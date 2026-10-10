// Registers the service worker that keeps a complete build cached for use
// without a network (web/sw.ts, web/js/offline-cache.ts) and reports what it
// does to Debug Output and to analytics.
//
// Analytics answers three questions: how many browsers hold a copy that loads
// offline (offline_ready, once per build per browser), why caching fails
// (offline_cache_failed), and how often the app is actually launched from
// the cache (offline_launches). The last cannot be sent as it happens --
// offline, gtag.js never loads and its queue dies with the page -- so each
// launch the worker answered from the cache is counted in localStorage and
// the count is sent from the next page the network served. The page's other
// events -- radios downloaded and uploaded offline among them -- are diverted
// into the replay queue in web/js/analytics.ts the same way and sent with it.
//
// Only the built site has a worker to register: scripts/build-dist.ts emits
// sw.js, and the dev server serves web/ unbuilt, where this module itself is
// still a .ts file. That is how it tells the two apart -- a worker under the
// dev server would cache sources that change on every edit.

import { errorDetails } from "./error-details.ts";
import type { OfflineMessage, PageSource } from "./offline-cache.ts";

/** trackEvent's shape (web/js/analytics.ts): false when nothing was sent. */
export type TrackEvent = (name: string, params?: Record<string, unknown>) => boolean;

/** The part of localStorage the offline counters use. */
export type OfflineStore = Pick<Storage, "getItem" | "setItem">;

/** The replay queue's two ends (web/js/analytics.ts). */
export interface AnalyticsReplay {
  /** Queue this page's events instead of sending them. */
  defer: () => void;
  /** Send what offline pages queued. */
  replay: () => void;
}

const NO_REPLAY: AnalyticsReplay = Object.freeze({ defer: () => {}, replay: () => {} });

/** What registerOfflineSupport() needs from the page. */
export interface OfflineSupportOptions {
  logDebug: (message: string) => void;
  /** Where the offline events go; nothing is sent without it. */
  trackEvent?: TrackEvent;
  /** The replay queue; without it an offline page's events are lost. */
  replay?: AnalyticsReplay;
  /** Defaults to localStorage, where the browser allows it. */
  store?: OfflineStore | null;
  /** The module's own URL; a test passes the built shape. */
  moduleUrl?: string;
  serviceWorker?: ServiceWorkerContainer;
  storage?: StorageManager;
}

// Turn one message from the worker into a Debug Output line, or null for a
// message that is not one of its.
export function describeOfflineMessage(data: unknown): string | null {
  const message = data as Partial<OfflineMessage> | null;
  if (message?.type !== "webchirp-offline") {
    return null;
  }
  if (message.event === "ready" || (message.event === "status" && message.buildHash)) {
    return `OFFLINE READY build ${message.buildHash} is cached; WebCHIRP will load without a network`;
  }
  if (message.event === "status") {
    return "OFFLINE caching this version so WebCHIRP can load without a network";
  }
  if (message.event === "error") {
    return `OFFLINE ERROR caching for offline use failed, will retry on the next load: ${message.message}`;
  }
  return null;
}

// Launches counted but not yet sent, by how the worker answered them, and the
// last build an offline_ready event was sent for.
const LAUNCHES_KEY = "webchirp-offline-launches";
const REPORTED_BUILD_KEY = "webchirp-offline-reported-build";

// Launch counts as a handful of ranges, so reports can group by them the way
// channelCountBucket (web/js/ui/analytics.ts) groups codeplug sizes.
export function launchCountBucket(count: number): string {
  if (count <= 1) {
    return "1";
  }
  if (count <= 5) {
    return "2-5";
  }
  if (count <= 20) {
    return "6-20";
  }
  return "21+";
}

// localStorage, or null where reading it throws (blocked site data, some
// private modes) or it is not a real Storage (Node 25 defines an empty one
// unless started with --localstorage-file); the counters are a nicety and go
// quiet without it.
function defaultStore(): OfflineStore | null {
  try {
    const storage = globalThis.localStorage;
    return typeof storage?.getItem === "function" && typeof storage.setItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

// The unsent launch counts, read without trusting what is stored.
function readLaunches(store: OfflineStore): Partial<Record<PageSource, number>> {
  try {
    const parsed = JSON.parse(store.getItem(LAUNCHES_KEY) || "{}") as Record<string, unknown>;
    const counts: Partial<Record<PageSource, number>> = {};
    for (const source of ["cache", "cache_after_timeout"] as const) {
      const n = parsed[source];
      if (typeof n === "number" && Number.isInteger(n) && n > 0) {
        counts[source] = n;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

function writeStore(store: OfflineStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Quota or blocked storage: the count is lost, nothing else is.
  }
}

// Turn the worker's messages into analytics events. Returns the handler for
// one message; it never throws.
export function createOfflineAnalytics(
  trackEvent: TrackEvent,
  store: OfflineStore | null,
  replay: AnalyticsReplay = NO_REPLAY,
): (data: unknown) => void {
  // offline_ready once per build per browser, however many tabs hear about
  // it, and only once actually sent (trackEvent is false off-domain).
  function reportReady(buildHash: string): void {
    if (store?.getItem(REPORTED_BUILD_KEY) === buildHash) {
      return;
    }
    if (trackEvent("offline_ready", {}) && store) {
      writeStore(store, REPORTED_BUILD_KEY, buildHash);
    }
  }

  // Count a launch answered from the cache; from a page the network served,
  // send what was counted.
  function recordLaunch(servedFrom: PageSource): void {
    if (!store) {
      return;
    }
    const counts = readLaunches(store);
    if (servedFrom !== "network") {
      counts[servedFrom] = (counts[servedFrom] || 0) + 1;
      writeStore(store, LAUNCHES_KEY, JSON.stringify(counts));
      return;
    }
    for (const source of ["cache", "cache_after_timeout"] as const) {
      const count = counts[source];
      if (count && trackEvent("offline_launches", {
        served_from: source,
        launch_count: count,
        launch_count_bucket: launchCountBucket(count),
      })) {
        delete counts[source];
      }
    }
    writeStore(store, LAUNCHES_KEY, JSON.stringify(counts));
  }

  return (data) => {
    const message = data as Partial<OfflineMessage> | null;
    if (message?.type !== "webchirp-offline") {
      return;
    }
    try {
      if (message.event === "ready" && message.buildHash) {
        reportReady(message.buildHash);
      } else if (message.event === "error") {
        trackEvent("offline_cache_failed", { error_kind: message.reason || "other" });
      } else if (message.event === "status" && message.servedFrom) {
        // A page served from the cache is offline, where nothing reaches GA:
        // its events wait in the replay queue. Only a network-served page can
        // report, and it sends what waited. A page the timeout served is
        // neither: gtag.js may yet load on it, so its events go out live.
        if (message.servedFrom === "cache") {
          replay.defer();
        }
        if (message.servedFrom === "network") {
          if (message.buildHash) {
            reportReady(message.buildHash);
          }
          replay.replay();
        }
        recordLaunch(message.servedFrom);
      }
    } catch {
      // Telemetry must never be able to break the page it reports on.
    }
  };
}

// Register the worker and ask it what it has cached. Never throws: a page
// without offline support works exactly as it did before there was any.
export async function registerOfflineSupport({
  logDebug,
  trackEvent = () => false,
  replay = NO_REPLAY,
  store = defaultStore(),
  moduleUrl = import.meta.url,
  serviceWorker = globalThis.navigator?.serviceWorker,
  storage = globalThis.navigator?.storage,
}: OfflineSupportOptions): Promise<void> {
  if (moduleUrl.endsWith(".ts")) {
    return;
  }
  if (!serviceWorker) {
    logDebug("OFFLINE unavailable: this browser has no service workers");
    return;
  }
  const report = createOfflineAnalytics(trackEvent, store, replay);
  serviceWorker.addEventListener("message", (event) => {
    const line = describeOfflineMessage(event.data);
    if (line) {
      logDebug(line);
    }
    report(event.data);
  });
  try {
    // Bundled modules live in dist/js/, so the worker is one level up, at
    // the root it has to sit at to control every page.
    await serviceWorker.register(new URL("../sw.js", moduleUrl), { updateViaCache: "none" });
    const registration = await serviceWorker.ready;
    registration.active?.postMessage({ type: "webchirp-offline-status" });
  } catch (error) {
    logDebug(`OFFLINE ERROR service worker registration failed: ${errorDetails(error)}`);
    return;
  }
  // Ask the browser not to evict the cache under storage pressure. Chrome
  // decides from engagement (an installed app, a bookmark) without a prompt.
  try {
    if (storage?.persist && !(await storage.persisted())) {
      const granted = await storage.persist();
      logDebug(`OFFLINE storage ${granted ? "persisted" : "not persisted; the browser may evict it when space runs low"}`);
    }
  } catch {
    // Storage persistence is a hint; without it the cache still works.
  }
}

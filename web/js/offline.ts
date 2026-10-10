// Registers the service worker that keeps a complete build cached for use
// without a network (web/sw.ts, web/js/offline-cache.ts) and reports what it
// does to Debug Output.
//
// Only the built site has a worker to register: scripts/build-dist.ts emits
// sw.js, and the dev server serves web/ unbuilt, where this module itself is
// still a .ts file. That is how it tells the two apart -- a worker under the
// dev server would cache sources that change on every edit.

import { errorDetails } from "./error-details.ts";
import type { OfflineMessage } from "./offline-cache.ts";

/** What registerOfflineSupport() needs from the page. */
export interface OfflineSupportOptions {
  logDebug: (message: string) => void;
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

// Register the worker and ask it what it has cached. Never throws: a page
// without offline support works exactly as it did before there was any.
export async function registerOfflineSupport({
  logDebug,
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
  serviceWorker.addEventListener("message", (event) => {
    const line = describeOfflineMessage(event.data);
    if (line) {
      logDebug(line);
    }
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

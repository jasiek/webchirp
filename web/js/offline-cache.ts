// What the service worker (web/sw.ts) does, without the service worker: which
// requests it answers and how, and how a build becomes available offline.
// Everything it touches -- Cache Storage, fetch, the digest, the clients -- is
// passed in, so tests/build/offline-cache.mjs drives it in Node against a fake
// Cache Storage and a scripted network.
//
// The model, in three rules:
//
//   1. A page (a navigation) and the few files that keep their name across
//      deploys (index.html, the radio catalogs, version.json...) come from the
//      network when it answers within NETWORK_TIMEOUT_MS, so an online visit
//      always sees the latest deploy; otherwise -- or when the host answers
//      with an outage status such as 503 -- from the cached build.
//   2. Everything else is immutable by name -- content-hashed bundles and
//      Python, the pin-named CHIRP archive, version-pinned CDN files -- so a
//      cached copy is served without asking the network at all. A pinned CDN
//      file the build did not list is cached the first time it is fetched,
//      so a module jsDelivr's generated +esm build starts importing still
//      reaches the offline copy after one online visit.
//   3. A build is cached whole or not at all. After a page load the worker
//      reads asset-manifest.json, fetches every file the build lists into a
//      cache of its own, checks each renamable file against the digest the
//      manifest records, and only then makes it the build served offline. A
//      half-cached build never replaces a complete one, so the offline copy is
//      always a version that can boot -- not merely the last page seen.
//
// The previous build's cache is kept beside the current one, because a tab
// opened on it may boot its runtime days later and ask for its hashed files.
// Older ones are deleted.

import { errorFields } from "./error-details.ts";

// Every cache this module owns starts with this; the version is bumped when
// the layout changes, and anything with the prefix but not in use is deleted.
export const OFFLINE_CACHE_PREFIX = "webchirp-offline-";
const CACHE_VERSION = "v1";
const BUILD_CACHE_PREFIX = `${OFFLINE_CACHE_PREFIX}${CACHE_VERSION}-build-`;
const STATE_CACHE_NAME = `${OFFLINE_CACHE_PREFIX}${CACHE_VERSION}-state`;

// How long a page or renamable file waits on the network before the cached
// copy is served instead, when there is one. A dead network fails fast on its
// own; this is for the one that accepts a connection and then says nothing.
export const NETWORK_TIMEOUT_MS = 4000;

// How long a file being cached may go without a byte arriving -- the
// response, or the next piece of its body -- before its download is given up.
// A slow download is fine as long as it keeps moving; one that stops would
// otherwise hold the sync, which every later page load shares, open for good.
export const DOWNLOAD_STALL_MS = 30000;

// How many files a build fetches at once while caching.
const FETCH_CONCURRENCY = 4;

// Matching ignores Vary: every URL cached here names one fixed body, and a
// CDN's Vary: Origin would otherwise make a key stored by the worker's own
// fetch miss the page's request for the same URL.
const MATCH_OPTIONS: CacheQueryOptions = Object.freeze({ ignoreVary: true });

/** One file a build needs offline. */
export interface OfflineEntry {
  /** Absolute URL. */
  url: string;
  /** The first 10 hex digits of the SHA-256 of its body, for a file whose name
   * does not change with its content; absent for an immutable name. */
  sha256?: string;
  /** Cached if it can be, without holding the build back if it cannot. */
  optional?: boolean;
}

/** A build as asset-manifest.json describes it for offline use. */
export interface OfflineBuild {
  buildHash: string;
  entries: OfflineEntry[];
  /** The URLs of the renamable files: served network-first. */
  mutableUrls: string[];
}

/** What is cached: the build served offline and the one before it. */
export interface OfflineState {
  current: { buildHash: string; mutableUrls: string[] } | null;
  previous: { buildHash: string; mutableUrls: string[] } | null;
}

/** How a page load was answered: by the network, by the cached build because
 * the network failed, or by the cached build because the network was slower
 * than NETWORK_TIMEOUT_MS. */
export type PageSource = "network" | "cache" | "cache_after_timeout";

/** Why caching a build failed, as a fixed vocabulary analytics can group by. */
export type OfflineFailureReason = "network" | "mismatch" | "http" | "quota" | "other";

/** What the worker tells its pages, through OfflineEnv.notify. */
export type OfflineMessage =
  | { type: "webchirp-offline"; event: "status"; buildHash: string | null; servedFrom: PageSource | null }
  | { type: "webchirp-offline"; event: "ready"; buildHash: string }
  | { type: "webchirp-offline"; event: "error"; message: string; reason: OfflineFailureReason };

/** What the worker hands this module. */
export interface OfflineEnv {
  /** The registration's scope: the site root, ending in "/". */
  scope: string;
  caches: CacheStorage;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Tell every page of this origin something; defaults to doing nothing. */
  notify?: (message: OfflineMessage) => void;
  /** First 10 hex digits of the SHA-256 of bytes; defaults to crypto.subtle. */
  digest?: (bytes: ArrayBuffer) => Promise<string>;
  timeoutMs?: number;
  /** Defaults to DOWNLOAD_STALL_MS. */
  stallMs?: number;
}

/** A build whose files did not match its manifest: a deploy landed mid-fetch. */
export class OfflineBuildMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineBuildMismatch";
  }
}

/** A file of a build the server would not serve. */
export class OfflineHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineHttpError";
  }
}

// The network not answering within the timeout, as opposed to failing.
class NetworkTimeout extends Error {}

// A download for the cache that stopped arriving (DOWNLOAD_STALL_MS).
class DownloadStalled extends Error {}

// Map a caching failure onto OfflineFailureReason: a deploy landing
// mid-download, a file the server refused, a full disk, the network dropping
// (fetch rejects with a TypeError) or going quiet, or anything else.
export function offlineFailureReason(error: unknown): OfflineFailureReason {
  if (error instanceof OfflineBuildMismatch) {
    return "mismatch";
  }
  if (error instanceof OfflineHttpError) {
    return "http";
  }
  const { name } = errorFields(error);
  if (name === "QuotaExceededError") {
    return "quota";
  }
  return error instanceof TypeError || error instanceof DownloadStalled ? "network" : "other";
}

const EMPTY_STATE: OfflineState = Object.freeze({ current: null, previous: null });

// SHA-256 of bytes as the 10-hex prefix scripts/build-dist.ts records, so a
// renamable file can be checked against the manifest that listed it.
async function sha256Prefix(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

function buildCacheName(buildHash: string): string {
  return `${BUILD_CACHE_PREFIX}${buildHash}`;
}

// The URL a page is cached under: its path, without the query a link or the
// web manifest's start_url adds (the page reads that itself), and with a
// directory resolved to its index.html the way the server resolves it.
function pageKey(url: URL): string {
  const key = new URL(url.pathname, url.origin);
  if (key.pathname.endsWith("/")) {
    key.pathname += "index.html";
  }
  return key.href;
}

// Read the offline section of asset-manifest.json (scripts/build-dist.ts) into
// absolute URLs, refusing anything malformed rather than caching half of it.
// The manifest is JSON from the network, so every field is checked.
export function parseOfflineBuild(manifest: unknown, scope: string): OfflineBuild {
  const record = manifest as { buildHash?: unknown; offline?: Record<string, unknown> } | null;
  const offline = record?.offline;
  if (typeof record?.buildHash !== "string" || !/^[0-9a-f]{10}$/.test(record.buildHash)
    || !offline || typeof offline !== "object") {
    throw new Error("asset-manifest.json has no usable buildHash and offline section");
  }
  const files = offline.files as Record<string, unknown> | undefined;
  const assets = offline.assets as unknown;
  const cdn = offline.cdn as unknown;
  if (!files || typeof files !== "object" || !Array.isArray(assets) || !Array.isArray(cdn)) {
    throw new Error("asset-manifest.json's offline section lacks files, assets or cdn");
  }
  const entries: OfflineEntry[] = [];
  const mutableUrls: string[] = [];
  for (const [rel, sha256] of Object.entries(files)) {
    if (typeof sha256 !== "string" || !/^[0-9a-f]{10}$/.test(sha256)) {
      throw new Error(`asset-manifest.json lists ${rel} without a digest`);
    }
    const url = new URL(rel, scope).href;
    entries.push({ url, sha256 });
    mutableUrls.push(url);
  }
  for (const ref of [...assets, ...cdn]) {
    if (typeof ref !== "string" || !ref) {
      throw new Error("asset-manifest.json lists an offline asset that is not a path");
    }
    entries.push({ url: new URL(ref, scope).href });
  }
  entries.push(...optionalEntries(offline.optional, new URL(scope).hostname));
  return { buildHash: record.buildHash, entries, mutableUrls };
}

// The offline section's optional groups (scripts/build-dist.ts): files only
// some deployments use -- the Sentry SDK, which loads on the production hosts
// alone -- each group naming the hosts it is for. A group for this host is
// cached best-effort; one for another host is not fetched at all. A manifest
// without the field has no optional files.
function optionalEntries(groups: unknown, hostname: string): OfflineEntry[] {
  if (groups === undefined) {
    return [];
  }
  if (!Array.isArray(groups)) {
    throw new Error("asset-manifest.json's offline.optional is not a list");
  }
  const entries: OfflineEntry[] = [];
  for (const group of groups as Array<{ hosts?: unknown; urls?: unknown } | null>) {
    if (!Array.isArray(group?.hosts) || !Array.isArray(group.urls)
      || !group.urls.every((url) => typeof url === "string" && url)) {
      throw new Error("asset-manifest.json lists an optional group without hosts and urls");
    }
    if (group.hosts.includes(hostname)) {
      entries.push(...(group.urls as string[]).map((url) => ({ url: new URL(url).href, optional: true })));
    }
  }
  return entries;
}

// Run task over items with at most limit in flight; the first failure rejects.
async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = items.values();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of queue) {
      await task(item);
    }
  }));
}

// Resolve with the network's answer, or reject once ms have passed without
// one. The fetch itself carries on, so a slow answer still lands in the HTTP
// cache for next time.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new NetworkTimeout(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

// Whether an HTTP status says the server could not answer just now (a 5xx,
// a request timeout, rate limiting) rather than giving an answer. A page or
// renamable file that gets one is served from the cached build as if the
// network had failed, so an outage at the host does not stop a cached app
// from launching. Any other status -- a 404 for a file a deploy dropped, say
// -- is the answer, and the cached copy is not resurrected over it.
function isServerOutage(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** What the worker knows about a request beyond the request itself. */
export interface RespondOptions {
  /** The id of the page a navigation creates (FetchEvent.resultingClientId). */
  clientId?: string;
  /** Keep the worker alive for work that outlasts the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

// A jsDelivr path that names an exact version, so its body never changes:
// /npm/<package>@1.2.3/... (scoped or not) or Pyodide's /pyodide/v1.2.3/.
// A range or a tag (@1, @latest) can move and is never cached.
const PINNED_CDN_PATH = /^\/npm\/(?:@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+(?:[-+][\w.]+)?\/|^\/pyodide\/v\d+\.\d+\.\d+\//;

/** The service worker's behaviour, bound to one environment. */
export interface OfflineCache {
  /**
   * The response for a request, or null when the worker should leave it to
   * the browser (non-GET, other hosts, asset-manifest.json).
   */
  respond(request: Request, options?: RespondOptions): Promise<Response> | null;
  /**
   * How the navigation that created the page clientId was answered, once:
   * the record is dropped as it is read. Null for a page this worker did not
   * load (the first visit, or a worker restarted since).
   */
  pageSource(clientId: string): PageSource | null;
  /** Cache the deployed build if it is not the current one; never throws. */
  sync(): Promise<OfflineState>;
  /** The build served offline, if any. */
  state(): Promise<OfflineState>;
}

// Build the worker's behaviour over env. Holds the state it last read and the
// one sync in flight, so concurrent page loads share a single download.
export function createOfflineCache(env: OfflineEnv): OfflineCache {
  const scope = new URL(env.scope).href;
  const stateKey = new URL("offline-state.json", scope).href;
  const manifestUrl = new URL("asset-manifest.json", scope).href;
  const cdnOrigin = "https://cdn.jsdelivr.net";
  const digest = env.digest || sha256Prefix;
  const notify = env.notify || (() => {});
  const timeoutMs = env.timeoutMs ?? NETWORK_TIMEOUT_MS;
  const stallMs = env.stallMs ?? DOWNLOAD_STALL_MS;
  let statePromise: Promise<OfflineState> | null = null;
  let syncing: Promise<OfflineState> | null = null;
  // How recent navigations were answered, by the id of the page each created.
  const pageSources = new Map<string, PageSource>();
  const PAGE_SOURCES_KEPT = 32;

  // Remember how the navigation for clientId was answered, keeping only the
  // most recent few: a page that never asks must not grow the map forever.
  function recordPageSource(clientId: string | undefined, source: PageSource): void {
    if (!clientId) {
      return;
    }
    pageSources.set(clientId, source);
    for (const oldest of pageSources.keys()) {
      if (pageSources.size <= PAGE_SOURCES_KEPT) {
        break;
      }
      pageSources.delete(oldest);
    }
  }

  function pageSource(clientId: string): PageSource | null {
    const source = pageSources.get(clientId) ?? null;
    pageSources.delete(clientId);
    return source;
  }

  // The state as stored, read once and then kept; a worker restarted by the
  // browser starts with nothing in memory and reads it again.
  function state(): Promise<OfflineState> {
    if (!statePromise) {
      statePromise = (async () => {
        const stored = await (await env.caches.open(STATE_CACHE_NAME)).match(stateKey);
        if (!stored) {
          return EMPTY_STATE;
        }
        // Written by writeState below; a malformed one is treated as none.
        const parsed = await stored.json().catch(() => null) as OfflineState | null;
        return parsed && "current" in parsed ? parsed : EMPTY_STATE;
      })();
    }
    return statePromise;
  }

  async function writeState(next: OfflineState): Promise<void> {
    const body = JSON.stringify(next);
    await (await env.caches.open(STATE_CACHE_NAME)).put(
      stateKey,
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    statePromise = Promise.resolve(next);
  }

  // Fetch url whole for the cache, giving up with DownloadStalled once stallMs
  // pass without the response or a piece of its body arriving. The fetch is
  // aborted then too, but the wait does not depend on that: it races the
  // watchdog, so even a fetch that ignores its signal releases the sync. The
  // body is read here, so the Response returned is a new one over its bytes
  // with the original status and headers -- what a Cache would store anyway.
  async function download(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let giveUp: (error: DownloadStalled) => void = () => {};
    const stalled = new Promise<never>((_resolve, reject) => {
      giveUp = reject;
    });
    // The watchdog only fires while a race below awaits it; this keeps its
    // rejection from ever being reported as unhandled.
    stalled.catch(() => {});
    const rearm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new DownloadStalled(`${url}: nothing arrived for ${stallMs} ms`);
        controller.abort(error);
        giveUp(error);
      }, stallMs);
    };
    rearm();
    try {
      const response = await Promise.race([env.fetch(url, { ...init, signal: controller.signal }), stalled]);
      const reader = response.body?.getReader();
      const chunks: BlobPart[] = [];
      while (reader) {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) {
          break;
        }
        chunks.push(value);
        rearm();
      }
      return new Response(reader ? new Blob(chunks) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Put one file of a build into its cache. An immutable name already cached
  // by an earlier build is copied from there instead of downloaded again,
  // which is what keeps a deploy that changed one chunk from refetching
  // Pyodide. A renamable file is always fetched and must match its digest.
  async function cacheEntry(cache: Cache, entry: OfflineEntry): Promise<void> {
    if (entry.optional) {
      // A blocker, a proxy or a CDN hiccup refusing an optional file costs
      // that file, never the build: the app runs without it, offline too.
      await cacheEntry(cache, { url: entry.url }).catch(() => {});
      return;
    }
    if (await cache.match(entry.url, MATCH_OPTIONS)) {
      return;
    }
    let response = entry.sha256 ? undefined : await env.caches.match(entry.url, MATCH_OPTIONS);
    if (!response) {
      // CORS rather than no-cors, so a CDN copy can answer the page's own
      // module import; jsDelivr sends access-control-allow-origin: *.
      response = await download(entry.url, { mode: "cors", cache: entry.sha256 ? "no-cache" : "default" });
      if (!response.ok) {
        throw new OfflineHttpError(`${entry.url}: HTTP ${response.status}`);
      }
    }
    if (entry.sha256) {
      const actual = await digest(await response.clone().arrayBuffer());
      if (actual !== entry.sha256) {
        throw new OfflineBuildMismatch(
          `${entry.url} does not match the build that listed it (${actual}, expected ${entry.sha256})`,
        );
      }
    }
    await cache.put(entry.url, response);
  }

  // Delete every cache of ours that is neither the state nor a kept build.
  async function prune(next: OfflineState): Promise<void> {
    const keep = new Set([STATE_CACHE_NAME]);
    for (const build of [next.current, next.previous]) {
      if (build) {
        keep.add(buildCacheName(build.buildHash));
      }
    }
    for (const name of await env.caches.keys()) {
      if (name.startsWith(OFFLINE_CACHE_PREFIX) && !keep.has(name)) {
        await env.caches.delete(name);
      }
    }
  }

  async function syncOnce(): Promise<OfflineState> {
    let manifest: unknown;
    try {
      const response = await download(manifestUrl, { cache: "no-store" });
      if (!response.ok) {
        // No manifest (a fork serving web/ unbuilt, say): nothing to cache.
        return await state();
      }
      manifest = await response.json();
    } catch {
      // Offline, or the network gave up or went quiet: the cached build stays
      // as it is.
      return await state();
    }
    const build = parseOfflineBuild(manifest, scope);
    const before = await state();
    if (before.current?.buildHash === build.buildHash) {
      return before;
    }
    const cache = await env.caches.open(buildCacheName(build.buildHash));
    await eachLimited(build.entries, FETCH_CONCURRENCY, (entry) => cacheEntry(cache, entry));
    const next: OfflineState = {
      current: { buildHash: build.buildHash, mutableUrls: build.mutableUrls },
      previous: before.current || before.previous,
    };
    await writeState(next);
    await prune(next);
    notify({ type: "webchirp-offline", event: "ready", buildHash: build.buildHash });
    return next;
  }

  // One sync at a time; a failure is reported and leaves the state as it was,
  // and the files that did arrive stay cached for the next attempt.
  function sync(): Promise<OfflineState> {
    if (!syncing) {
      syncing = syncOnce()
        .catch(async (error: unknown) => {
          notify({
            type: "webchirp-offline",
            event: "error",
            message: String(errorFields(error).message ?? error),
            reason: offlineFailureReason(error),
          });
          return state();
        })
        .finally(() => {
          syncing = null;
        });
    }
    return syncing;
  }

  // The network's answer within the timeout, or the cached copy under key
  // when the network fails, times out or reports an outage (isServerOutage);
  // with no cached copy, the network's answer however long it takes. Which
  // one answered goes to record.
  async function networkFirst(
    request: Request,
    key: string,
    buildHash: string,
    record: (source: PageSource) => void,
  ): Promise<Response> {
    const network = env.fetch(request);
    // Losing to the timeout is not an error: the cached copy answered.
    network.catch(() => {});
    const cached = await (await env.caches.open(buildCacheName(buildHash))).match(key, MATCH_OPTIONS);
    if (!cached) {
      record("network");
      return network;
    }
    try {
      const response = await withTimeout(network, timeoutMs);
      if (!isServerOutage(response.status)) {
        record("network");
        return response;
      }
      record("cache");
    } catch (error) {
      record(error instanceof NetworkTimeout ? "cache_after_timeout" : "cache");
    }
    return cached;
  }

  // Any cache's copy of an immutable URL, else the network.
  async function cacheFirst(request: Request): Promise<Response> {
    return (await env.caches.match(request.url, MATCH_OPTIONS)) || env.fetch(request);
  }

  // cacheFirst for the CDN, keeping a pinned file the build did not list in
  // the current build's cache once fetched. Before any build is complete
  // there is nowhere to keep it; the next sync lists what matters anyway.
  async function cacheFirstCdn(request: Request, url: URL, waitUntil: RespondOptions["waitUntil"]): Promise<Response> {
    const cached = await env.caches.match(request.url, MATCH_OPTIONS);
    if (cached) {
      return cached;
    }
    const response = await env.fetch(request);
    const { current } = await state();
    if (response.ok && current && PINNED_CDN_PATH.test(url.pathname)) {
      const copy = response.clone();
      const stored = env.caches.open(buildCacheName(current.buildHash))
        .then((cache) => cache.put(request.url, copy))
        .catch(() => {});
      waitUntil?.(stored);
    }
    return response;
  }

  // Until one build is complete nothing is served from a cache: a partly
  // cached build may hold a renamable file from a deploy that has since been
  // replaced, and there is nothing to fall back to offline anyway.
  async function routeSameOrigin(request: Request, url: URL, clientId: string | undefined): Promise<Response> {
    const navigate = request.mode === "navigate";
    // Only a navigation's source is worth keeping: it is what the page asks.
    const record = (source: PageSource) => {
      if (navigate) {
        recordPageSource(clientId, source);
      }
    };
    const { current } = await state();
    const key = navigate ? pageKey(url) : url.href;
    if (current?.mutableUrls.includes(key)) {
      return networkFirst(request, key, current.buildHash, record);
    }
    if (!current || navigate) {
      record("network");
      return env.fetch(request);
    }
    return cacheFirst(request);
  }

  function respond(request: Request, { clientId, waitUntil }: RespondOptions = {}): Promise<Response> | null {
    if (request.method !== "GET") {
      return null;
    }
    const url = new URL(request.url);
    if (url.href.startsWith(scope)) {
      return url.href === manifestUrl ? null : routeSameOrigin(request, url, clientId);
    }
    // Only pinned CDN URLs are immutable; analytics, Sentry's ingest and the
    // repeater directories are live and stay the browser's business.
    return url.origin === cdnOrigin ? cacheFirstCdn(request, url, waitUntil) : null;
  }

  return { respond, pageSource, sync, state };
}

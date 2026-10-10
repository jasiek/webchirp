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
//      always sees the latest deploy; otherwise from the cached build.
//   2. Everything else is immutable by name -- content-hashed bundles and
//      Python, the pin-named CHIRP archive, version-pinned CDN files -- so a
//      cached copy is served without asking the network at all.
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

/** What the worker tells its pages, through OfflineEnv.notify. */
export type OfflineMessage =
  | { type: "webchirp-offline"; event: "status"; buildHash: string | null }
  | { type: "webchirp-offline"; event: "ready"; buildHash: string }
  | { type: "webchirp-offline"; event: "error"; message: string };

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
}

/** A build whose files did not match its manifest: a deploy landed mid-fetch. */
export class OfflineBuildMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineBuildMismatch";
  }
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
  return { buildHash: record.buildHash, entries, mutableUrls };
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
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** The service worker's behaviour, bound to one environment. */
export interface OfflineCache {
  /**
   * The response for a request, or null when the worker should leave it to
   * the browser (non-GET, other hosts, asset-manifest.json).
   */
  respond(request: Request): Promise<Response> | null;
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
  let statePromise: Promise<OfflineState> | null = null;
  let syncing: Promise<OfflineState> | null = null;

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

  // Put one file of a build into its cache. An immutable name already cached
  // by an earlier build is copied from there instead of downloaded again,
  // which is what keeps a deploy that changed one chunk from refetching
  // Pyodide. A renamable file is always fetched and must match its digest.
  async function cacheEntry(cache: Cache, entry: OfflineEntry): Promise<void> {
    if (await cache.match(entry.url, MATCH_OPTIONS)) {
      return;
    }
    let response = entry.sha256 ? undefined : await env.caches.match(entry.url, MATCH_OPTIONS);
    if (!response) {
      response = await env.fetch(entry.url, { mode: "cors", cache: entry.sha256 ? "no-cache" : "default" });
      if (!response.ok) {
        throw new Error(`${entry.url}: HTTP ${response.status}`);
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
      const response = await env.fetch(manifestUrl, { cache: "no-store" });
      if (!response.ok) {
        // No manifest (a fork serving web/ unbuilt, say): nothing to cache.
        return await state();
      }
      manifest = await response.json();
    } catch {
      // Offline, or the network gave up: the cached build stays as it is.
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
          });
          return state();
        })
        .finally(() => {
          syncing = null;
        });
    }
    return syncing;
  }

  // The network's answer within the timeout, or the cached copy under key;
  // with no cached copy, the network's answer however long it takes.
  async function networkFirst(request: Request, key: string, buildHash: string): Promise<Response> {
    const network = env.fetch(request);
    // Losing to the timeout is not an error: the cached copy answered.
    network.catch(() => {});
    const cached = await (await env.caches.open(buildCacheName(buildHash))).match(key, MATCH_OPTIONS);
    if (!cached) {
      return network;
    }
    try {
      return await withTimeout(network, timeoutMs);
    } catch {
      return cached;
    }
  }

  // Any cache's copy of an immutable URL, else the network.
  async function cacheFirst(request: Request): Promise<Response> {
    return (await env.caches.match(request.url, MATCH_OPTIONS)) || env.fetch(request);
  }

  // Until one build is complete nothing is served from a cache: a partly
  // cached build may hold a renamable file from a deploy that has since been
  // replaced, and there is nothing to fall back to offline anyway.
  async function routeSameOrigin(request: Request, url: URL): Promise<Response> {
    const { current } = await state();
    if (!current) {
      return env.fetch(request);
    }
    const key = request.mode === "navigate" ? pageKey(url) : url.href;
    if (current.mutableUrls.includes(key)) {
      return networkFirst(request, key, current.buildHash);
    }
    return request.mode === "navigate" ? env.fetch(request) : cacheFirst(request);
  }

  function respond(request: Request): Promise<Response> | null {
    if (request.method !== "GET") {
      return null;
    }
    const url = new URL(request.url);
    if (url.href.startsWith(scope)) {
      return url.href === manifestUrl ? null : routeSameOrigin(request, url);
    }
    // Only pinned CDN URLs are immutable; analytics, Sentry's ingest and the
    // repeater directories are live and stay the browser's business.
    return url.origin === cdnOrigin ? cacheFirst(request) : null;
  }

  return { respond, sync, state };
}

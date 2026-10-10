// An in-memory Cache Storage for driving web/js/offline-cache.ts in Node, which
// has Request and Response but no caches global. Only what the service worker
// calls: open/match/keys/delete on the storage, match/put/delete/keys on a
// cache. Keys are URLs; matching ignores Vary (every caller passes
// ignoreVary) and honours ignoreSearch.

function urlOf(request) {
  return typeof request === "string" ? request : request.url;
}

function keyFor(request, { ignoreSearch = false } = {}) {
  const url = new URL(urlOf(request));
  if (ignoreSearch) {
    url.search = "";
  }
  return url.href;
}

export class FakeCache {
  constructor() {
    /** @type {Map<string, {body: ArrayBuffer, init: ResponseInit}>} */
    this.entries = new Map();
  }

  // Bodies are stored as bytes and a fresh Response built per match, as a real
  // cache hands out a new body every time.
  async match(request, options = {}) {
    const wanted = keyFor(request, options);
    for (const [key, entry] of this.entries) {
      if (keyFor(key, options) === wanted) {
        return new Response(entry.body.slice(0), entry.init);
      }
    }
    return undefined;
  }

  async put(request, response) {
    const body = await response.arrayBuffer();
    this.entries.set(keyFor(request), {
      body,
      init: { status: response.status, statusText: response.statusText, headers: [...response.headers] },
    });
  }

  async delete(request) {
    return this.entries.delete(keyFor(request));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export class FakeCacheStorage {
  constructor() {
    /** @type {Map<string, FakeCache>} */
    this.caches = new Map();
  }

  async open(name) {
    if (!this.caches.has(name)) {
      this.caches.set(name, new FakeCache());
    }
    return this.caches.get(name);
  }

  async has(name) {
    return this.caches.has(name);
  }

  async delete(name) {
    return this.caches.delete(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  // Searches every cache in creation order, like CacheStorage.match.
  async match(request, options = {}) {
    for (const cache of this.caches.values()) {
      const found = await cache.match(request, options);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  // Every cached URL, by cache name, for assertions.
  snapshot() {
    return Object.fromEntries(
      [...this.caches].map(([name, cache]) => [name, [...cache.entries.keys()].sort()]),
    );
  }
}

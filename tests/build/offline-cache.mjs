// The service worker's behaviour (web/js/offline-cache.ts), against an
// in-memory Cache Storage and a scripted site. What matters most here is the
// rule that makes the offline copy trustworthy: a build becomes the one served
// offline only once every file it lists is cached, so a page load that was cut
// short -- or a deploy that landed mid-download -- leaves the last complete
// build in place rather than half of a new one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { FakeCacheStorage } from "../support/fake-cache-storage.mjs";
import { createOfflineCache, parseOfflineBuild } from "../../web/js/offline-cache.ts";
import { PYODIDE_INDEX_URL } from "../../web/js/cdn-urls.ts";

const SCOPE = "https://webchirp.test/";
const CDN_FILE = `${PYODIDE_INDEX_URL}pyodide.asm.wasm`;

function sha(body) {
  return createHash("sha256").update(body).digest("hex").slice(0, 10);
}

// One deploy: its renamable files and immutable assets as path -> body, and
// the asset-manifest.json scripts/build-dist.ts would write for them.
function deploy(buildHash, { files, assets }) {
  return {
    buildHash,
    bodies: { ...files, ...assets },
    manifest: {
      buildHash,
      assets: {},
      offline: {
        files: Object.fromEntries(Object.entries(files).map(([rel, body]) => [rel, sha(body)])),
        assets: Object.keys(assets),
        cdn: [CDN_FILE],
      },
    },
  };
}

const BUILD_A = deploy("aaaaaaaaaa", {
  files: { "index.html": "<p>A</p>", "radio-catalog.json": '{"a":1}' },
  assets: { "js/app.AAAAAAAA.js": "app A", "chirp/chirp-pin.zip": "archive" },
});
const BUILD_B = deploy("bbbbbbbbbb", {
  files: { "index.html": "<p>B</p>", "radio-catalog.json": '{"b":1}' },
  assets: { "js/app.BBBBBBBB.js": "app B", "chirp/chirp-pin.zip": "archive" },
});
const BUILD_C = deploy("cccccccccc", {
  files: { "index.html": "<p>C</p>", "radio-catalog.json": '{"c":1}' },
  assets: { "js/app.CCCCCCCC.js": "app C", "chirp/chirp-pin.zip": "archive" },
});

// A site serving one deploy, with the CDN beside it. Like Pages after
// scripts/retain-deployed-assets.ts, it goes on serving every earlier deploy's
// hashed files; its renamable ones are the current deploy's. Every request is
// recorded; it can be taken offline, made to fail one URL, made to hang, or
// switched to another deploy -- including after the manifest has been read.
function createSite(initial) {
  const retained = {};
  const site = {
    get current() {
      return this.deployed;
    },
    set current(build) {
      Object.assign(retained, Object.fromEntries(build.manifest.offline.assets.map((rel) => [rel, build.bodies[rel]])));
      this.deployed = build;
    },
    deployed: initial,
    offline: false,
    hang: false,
    failing: new Set(),
    requests: [],
    // Called with each URL before it is answered, so a test can deploy mid-sync.
    onRequest: (/** @type {string} */ _url) => {},
    async fetch(input) {
      const url = typeof input === "string" ? input : input.url;
      site.requests.push(url);
      site.onRequest(url);
      if (site.offline) {
        throw new TypeError("Failed to fetch");
      }
      if (site.hang) {
        return new Promise(() => {});
      }
      if (site.failing.has(url)) {
        return new Response("", { status: 503 });
      }
      if (url === CDN_FILE) {
        return new Response("wasm", { headers: { "Content-Type": "application/wasm" } });
      }
      const pathname = new URL(url).pathname;
      const rel = url.startsWith(SCOPE) ? `${pathname.slice(1)}${pathname.endsWith("/") ? "index.html" : ""}` : null;
      if (rel === "asset-manifest.json") {
        return Response.json(site.current.manifest);
      }
      if (rel !== null && rel in site.current.bodies) {
        return new Response(site.current.bodies[rel]);
      }
      if (rel !== null && rel in retained) {
        return new Response(retained[rel]);
      }
      return new Response("not found", { status: 404 });
    },
  };
  site.current = initial;
  return site;
}

function setup(initial = BUILD_A, options = {}) {
  const caches = new FakeCacheStorage();
  const site = createSite(initial);
  const messages = [];
  const offline = createOfflineCache({
    scope: SCOPE,
    caches,
    fetch: (input) => site.fetch(input),
    notify: (message) => messages.push(message),
    timeoutMs: 20,
    ...options,
  });
  return { caches, site, messages, offline };
}

// A navigation as the worker sees it; Node's Request refuses mode "navigate".
function navigation(url) {
  return { url, method: "GET", mode: "navigate" };
}

function subresource(url) {
  return new Request(url);
}

async function bodyOf(responsePromise) {
  assert.ok(responsePromise, "expected the worker to answer this request");
  return (await responsePromise).text();
}

test("a complete build becomes the one served offline", async () => {
  const { caches, offline, messages } = setup();
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_A.buildHash);
  assert.deepEqual(caches.snapshot()["webchirp-offline-v1-build-aaaaaaaaaa"], [
    CDN_FILE,
    `${SCOPE}chirp/chirp-pin.zip`,
    `${SCOPE}index.html`,
    `${SCOPE}js/app.AAAAAAAA.js`,
    `${SCOPE}radio-catalog.json`,
  ].sort());
  assert.deepEqual(messages, [{ type: "webchirp-offline", event: "ready", buildHash: BUILD_A.buildHash }]);
});

test("a build cut short leaves the last complete one in place, and resumes", async () => {
  const { site, offline, messages } = setup();
  await offline.sync();
  site.current = BUILD_B;
  site.failing.add(`${SCOPE}js/app.BBBBBBBB.js`);
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_A.buildHash, "a half-cached build must not replace a complete one");
  assert.equal(messages.at(-1)?.event, "error");
  assert.equal(messages.at(-1)?.reason, "http");

  // Offline, the page served is still A's, whose files are all there.
  site.offline = true;
  assert.equal(await bodyOf(offline.respond(navigation(SCOPE))), "<p>A</p>");
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}js/app.AAAAAAAA.js`))), "app A");

  // Back online, the next sync fetches only what the first attempt missed.
  site.offline = false;
  site.failing.clear();
  site.requests = [];
  const resumed = await offline.sync();
  assert.equal(resumed.current?.buildHash, BUILD_B.buildHash);
  assert.deepEqual(
    site.requests.filter((url) => url.includes("/js/")),
    [`${SCOPE}js/app.BBBBBBBB.js`],
    "files cached by the failed attempt are not downloaded again",
  );
});

test("a deploy landing mid-download does not commit a mixed build", async () => {
  const { site, offline, messages } = setup();
  await offline.sync();
  site.current = BUILD_B;
  // The manifest is B's, but by the time index.html is fetched C is live.
  site.onRequest = (url) => {
    if (url === `${SCOPE}index.html`) {
      site.current = BUILD_C;
    }
  };
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_A.buildHash);
  assert.match(String(messages.at(-1)?.message), /does not match the build that listed it/);
  assert.equal(messages.at(-1)?.reason, "mismatch");
});

test("an unchanged file is copied from the previous build, not downloaded", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.current = BUILD_B;
  site.requests = [];
  await offline.sync();
  assert.ok(!site.requests.includes(`${SCOPE}chirp/chirp-pin.zip`), "the archive is already cached under its name");
  assert.ok(!site.requests.includes(CDN_FILE), "pinned CDN files are already cached");
  assert.ok(site.requests.includes(`${SCOPE}index.html`), "a renamable file is always fetched and checked");
});

test("the previous build is kept for open tabs and older ones are deleted", async () => {
  const { caches, site, offline } = setup();
  await offline.sync();
  site.current = BUILD_B;
  await offline.sync();
  site.current = BUILD_C;
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_C.buildHash);
  assert.equal(state.previous?.buildHash, BUILD_B.buildHash);
  assert.deepEqual((await caches.keys()).sort(), [
    "webchirp-offline-v1-build-bbbbbbbbbb",
    "webchirp-offline-v1-build-cccccccccc",
    "webchirp-offline-v1-state",
  ]);
  // A tab still on B boots its runtime offline from B's files.
  site.offline = true;
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}js/app.BBBBBBBB.js`))), "app B");
});

test("a sync without a network keeps the cached build quietly", async () => {
  const { site, offline, messages } = setup();
  await offline.sync();
  site.offline = true;
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_A.buildHash);
  assert.equal(messages.length, 1, "being offline is not an error worth reporting");
});

test("concurrent page loads share one download", async () => {
  const { site, offline } = setup();
  await Promise.all([offline.sync(), offline.sync(), offline.sync()]);
  assert.equal(site.requests.filter((url) => url.endsWith("asset-manifest.json")).length, 1);
});

test("online, a page comes from the network: the latest deploy", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.current = BUILD_B;
  assert.equal(await bodyOf(offline.respond(navigation(`${SCOPE}?radio=uv5r`))), "<p>B</p>");
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}radio-catalog.json`))), '{"b":1}');
});

test("offline, a page comes from the cached build whatever its query", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.offline = true;
  assert.equal(await bodyOf(offline.respond(navigation(`${SCOPE}?utm_source=pwa`))), "<p>A</p>");
  assert.equal(await bodyOf(offline.respond(navigation(`${SCOPE}index.html?radio=x`))), "<p>A</p>");
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}radio-catalog.json`))), '{"a":1}');
});

test("a network that never answers falls back to the cache after the timeout", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.hang = true;
  assert.equal(await bodyOf(offline.respond(navigation(SCOPE))), "<p>A</p>");
});

test("immutable files are served from the cache without asking the network", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.requests = [];
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}js/app.AAAAAAAA.js`))), "app A");
  assert.equal(await bodyOf(offline.respond(subresource(CDN_FILE))), "wasm");
  assert.deepEqual(site.requests, []);
});

test("nothing is served from a cache before one build is complete", async () => {
  const { site, offline } = setup();
  site.failing.add(`${SCOPE}js/app.AAAAAAAA.js`);
  await offline.sync();
  site.failing.clear();
  site.current = BUILD_B;
  site.requests = [];
  // radio-catalog.json from A sits in a partial cache; the page gets B's.
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}radio-catalog.json`))), '{"b":1}');
  assert.deepEqual(site.requests, [`${SCOPE}radio-catalog.json`]);
});

test("live services, other methods and the manifest are left to the browser", async () => {
  const { offline } = setup();
  await offline.sync();
  assert.equal(offline.respond(new Request("https://api-beta.rsgb.online/repeaters")), null);
  assert.equal(offline.respond(new Request("https://www.googletagmanager.com/gtag/js")), null);
  assert.equal(offline.respond(new Request(`${SCOPE}index.html`, { method: "POST", body: "x" })), null);
  assert.equal(offline.respond(new Request(`${SCOPE}asset-manifest.json`)), null);
});

test("a malformed manifest is refused rather than half-cached", () => {
  assert.throws(() => parseOfflineBuild({ buildHash: "aaaaaaaaaa" }, SCOPE), /offline section/);
  assert.throws(
    () => parseOfflineBuild({ buildHash: "aaaaaaaaaa", offline: { files: { "index.html": "" }, assets: [], cdn: [] } }, SCOPE),
    /index.html without a digest/,
  );
  assert.throws(() => parseOfflineBuild({ buildHash: "../x", offline: {} }, SCOPE), /buildHash/);
});

// What analytics is told (web/js/offline.ts): how the page asking was loaded.
test("each page load is remembered as network, cache or cache after the timeout", async () => {
  const { site, offline } = setup();
  await offline.sync();
  await offline.respond(navigation(SCOPE), "online-tab");
  site.offline = true;
  await offline.respond(navigation(SCOPE), "offline-tab");
  site.offline = false;
  site.hang = true;
  await offline.respond(navigation(SCOPE), "slow-tab");
  assert.equal(offline.pageSource("online-tab"), "network");
  assert.equal(offline.pageSource("offline-tab"), "cache");
  assert.equal(offline.pageSource("slow-tab"), "cache_after_timeout");
  assert.equal(offline.pageSource("online-tab"), null, "a source is handed out once");
  assert.equal(offline.pageSource("never-loaded"), null);
});

test("a page loaded before any build was cached came from the network", async () => {
  const { offline } = setup();
  await offline.respond(navigation(SCOPE), "first-visit");
  assert.equal(offline.pageSource("first-visit"), "network");
});

test("subresources leave no page source behind", async () => {
  const { offline } = setup();
  await offline.sync();
  await offline.respond(subresource(`${SCOPE}radio-catalog.json`), "");
  await offline.respond(subresource(`${SCOPE}js/app.AAAAAAAA.js`), "");
  assert.equal(offline.pageSource(""), null);
});

test("a dropped connection and a full disk are reported as such", async () => {
  {
    const { site, offline, messages } = setup();
    site.onRequest = (url) => {
      if (url.endsWith("index.html")) {
        site.offline = true;
      }
    };
    await offline.sync();
    assert.equal(messages.at(-1)?.reason, "network");
  }
  {
    const { caches, offline, messages } = setup();
    const open = caches.open.bind(caches);
    caches.open = async (name) => {
      const cache = await open(name);
      if (name.includes("-build-")) {
        cache.put = async () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      }
      return cache;
    };
    await offline.sync();
    assert.equal(messages.at(-1)?.reason, "quota");
  }
});

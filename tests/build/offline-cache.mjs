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
function deploy(buildHash, { files, assets, optional }) {
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
        ...(optional ? { optional } : {}),
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
// recorded; it can be taken offline, made to fail one URL, made to hang
// (everything, or one URL; before the headers, or partway through the body),
// made to send one URL's body slowly, or switched to another deploy --
// including after the manifest has been read.
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
    // CDN files beyond the one every build lists, by URL.
    cdn: {},
    // URLs whose request is accepted but never answered.
    stalled: new Set(),
    // URLs answered with headers and a first chunk, then nothing more.
    stalledBodies: new Set(),
    // URLs whose body arrives in small pieces, TRICKLE_MS apart.
    trickling: new Set(),
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
      if (site.hang || site.stalled.has(url)) {
        return new Promise(() => {});
      }
      if (site.stalledBodies.has(url)) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("the first part"));
          },
        }));
      }
      if (site.failing.has(url)) {
        return new Response("", { status: 503 });
      }
      if (url === CDN_FILE) {
        return new Response("wasm", { headers: { "Content-Type": "application/wasm" } });
      }
      if (url in site.cdn) {
        return new Response(site.cdn[url]);
      }
      const pathname = new URL(url).pathname;
      const rel = url.startsWith(SCOPE) ? `${pathname.slice(1)}${pathname.endsWith("/") ? "index.html" : ""}` : null;
      if (rel === "asset-manifest.json") {
        return Response.json(site.current.manifest);
      }
      if (rel !== null && rel in site.current.bodies) {
        const body = site.current.bodies[rel];
        return new Response(site.trickling.has(url) ? trickle(body) : body);
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

// How long the fake download watchdog waits, and the gap between the pieces
// of a trickled body: each gap is shorter than the watchdog, their sum longer.
const STALL_MS = 40;
const TRICKLE_MS = 15;

// A body sent one character at a time, TRICKLE_MS apart.
function trickle(text) {
  const bytes = new TextEncoder().encode(text);
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, TRICKLE_MS));
      if (sent < bytes.length) {
        controller.enqueue(bytes.slice(sent, sent + 1));
        sent += 1;
      } else {
        controller.close();
      }
    },
  });
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
    stallMs: STALL_MS,
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

test("a download that stops arriving is abandoned, and the next sync starts afresh", { timeout: 5000 }, async () => {
  for (const stall of ["stalled", "stalledBodies"]) {
    const { site, offline, messages } = setup();
    await offline.sync();
    site.current = BUILD_B;
    site[stall].add(`${SCOPE}js/app.BBBBBBBB.js`);
    const state = await offline.sync();
    assert.equal(state.current?.buildHash, BUILD_A.buildHash, `${stall}: a stuck file must not hold the sync open`);
    assert.equal(messages.at(-1)?.event, "error");
    assert.equal(messages.at(-1)?.reason, "network");

    site[stall].clear();
    const resumed = await offline.sync();
    assert.equal(resumed.current?.buildHash, BUILD_B.buildHash, `${stall}: the next sync is a new attempt`);
  }
});

test("a manifest that never arrives keeps the cached build quietly", { timeout: 5000 }, async () => {
  const { site, offline, messages } = setup();
  await offline.sync();
  site.stalled.add(`${SCOPE}asset-manifest.json`);
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_A.buildHash);
  assert.equal(messages.length, 1);
});

test("a slow download that keeps arriving is not abandoned", { timeout: 5000 }, async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.current = BUILD_B;
  // "app B" a character at a time: five gaps of TRICKLE_MS, longer than STALL_MS.
  site.trickling.add(`${SCOPE}js/app.BBBBBBBB.js`);
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, BUILD_B.buildHash);
  site.offline = true;
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}js/app.BBBBBBBB.js`))), "app B");
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

test("a server that cannot answer just now falls back to the cache", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.failing.add(`${SCOPE}index.html`);
  site.failing.add(`${SCOPE}radio-catalog.json`);
  assert.equal(await bodyOf(offline.respond(navigation(`${SCOPE}index.html`), { clientId: "outage-tab" })), "<p>A</p>");
  assert.equal(offline.pageSource("outage-tab"), "cache");
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}radio-catalog.json`))), '{"a":1}');
});

test("a file the server says is gone is not resurrected from the cache", async () => {
  const { site, offline } = setup();
  await offline.sync();
  // A deploy that dropped the catalog: the 404 is the answer, not an outage.
  site.current = deploy("dddddddddd", {
    files: { "index.html": "<p>D</p>" },
    assets: { "js/app.DDDDDDDD.js": "app D" },
  });
  const response = await offline.respond(subresource(`${SCOPE}radio-catalog.json`));
  assert.equal(response?.status, 404);
});

test("immutable files are served from the cache without asking the network", async () => {
  const { site, offline } = setup();
  await offline.sync();
  site.requests = [];
  assert.equal(await bodyOf(offline.respond(subresource(`${SCOPE}js/app.AAAAAAAA.js`))), "app A");
  const wasm = await offline.respond(subresource(CDN_FILE));
  assert.equal(wasm?.headers.get("Content-Type"), "application/wasm", "instantiateStreaming needs the type kept");
  assert.equal(await bodyOf(wasm), "wasm");
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
  await offline.respond(navigation(SCOPE), { clientId: "online-tab" });
  site.offline = true;
  await offline.respond(navigation(SCOPE), { clientId: "offline-tab" });
  site.offline = false;
  site.hang = true;
  await offline.respond(navigation(SCOPE), { clientId: "slow-tab" });
  assert.equal(offline.pageSource("online-tab"), "network");
  assert.equal(offline.pageSource("offline-tab"), "cache");
  assert.equal(offline.pageSource("slow-tab"), "cache_after_timeout");
  assert.equal(offline.pageSource("online-tab"), null, "a source is handed out once");
  assert.equal(offline.pageSource("never-loaded"), null);
});

test("a page loaded before any build was cached came from the network", async () => {
  const { offline } = setup();
  await offline.respond(navigation(SCOPE), { clientId: "first-visit" });
  assert.equal(offline.pageSource("first-visit"), "network");
});

test("subresources leave no page source behind", async () => {
  const { offline } = setup();
  await offline.sync();
  await offline.respond(subresource(`${SCOPE}radio-catalog.json`), { clientId: "" });
  await offline.respond(subresource(`${SCOPE}js/app.AAAAAAAA.js`), { clientId: "" });
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

// jsDelivr's +esm builds are generated, and can start importing a module the
// build never listed (a new patch of a dependency resolved from a range).
test("a pinned CDN module the build did not list is kept once fetched", async () => {
  const { site, offline } = setup();
  await offline.sync();
  const module = "https://cdn.jsdelivr.net/npm/@sentry/conventions@0.16.1/attributes/+esm";
  site.cdn[module] = "export {}";
  const kept = [];
  assert.equal(await bodyOf(offline.respond(subresource(module), { waitUntil: (p) => kept.push(p) })), "export {}");
  await Promise.all(kept);
  site.offline = true;
  assert.equal(await bodyOf(offline.respond(subresource(module))), "export {}");
});

test("a CDN URL that names no exact version is never kept", async () => {
  const { site, offline } = setup();
  await offline.sync();
  const kept = [];
  for (const url of [
    "https://cdn.jsdelivr.net/npm/web-serial-polyfill@1/+esm",
    "https://cdn.jsdelivr.net/npm/@sentry/browser@latest/+esm",
    "https://cdn.jsdelivr.net/npm/@sentry/browser/+esm",
  ]) {
    site.cdn[url] = "moves";
    await offline.respond(subresource(url), { waitUntil: (p) => kept.push(p) });
  }
  assert.deepEqual(kept, []);
});

test("nothing fetched from the CDN is kept before a build is complete", async () => {
  const { site, offline } = setup();
  const module = "https://cdn.jsdelivr.net/npm/@sentry/core@10.73.0/+esm";
  site.cdn[module] = "export {}";
  const kept = [];
  await offline.respond(subresource(module), { waitUntil: (p) => kept.push(p) });
  assert.deepEqual(kept, []);
});

// --- optional files ----------------------------------------------------------

// The Sentry SDK's shape: a CDN module only some hosts load.
const OPTIONAL_MODULE = "https://cdn.jsdelivr.net/npm/@sentry/browser@10.73.0/+esm";

function deployWithOptional(buildHash, hosts) {
  return deploy(buildHash, {
    files: { "index.html": `<p>${buildHash}</p>` },
    assets: { "js/app.OPTIONAL.js": "app" },
    optional: [{ hosts, urls: [OPTIONAL_MODULE] }],
  });
}

test("an optional file this host uses is cached with the build", async () => {
  const { site, offline } = setup(deployWithOptional("eeeeeeeeee", ["webchirp.test"]));
  site.cdn[OPTIONAL_MODULE] = "export {}";
  await offline.sync();
  site.offline = true;
  assert.equal(await bodyOf(offline.respond(subresource(OPTIONAL_MODULE))), "export {}");
});

test("an optional file that cannot be fetched does not hold the build back", async () => {
  const { site, offline, messages } = setup(deployWithOptional("eeeeeeeeee", ["webchirp.test"]));
  // A privacy filter refusing the SDK looks like this to the worker.
  site.failing.add(OPTIONAL_MODULE);
  const state = await offline.sync();
  assert.equal(state.current?.buildHash, "eeeeeeeeee", "the app is offline-ready without its telemetry");
  assert.deepEqual(messages.map((message) => message.event), ["ready"]);
});

test("an optional group for another host is never fetched", async () => {
  const { site, offline } = setup(deployWithOptional("eeeeeeeeee", ["webchirp.org"]));
  site.cdn[OPTIONAL_MODULE] = "export {}";
  await offline.sync();
  assert.ok(!site.requests.includes(OPTIONAL_MODULE), "a fork caches nothing its host gate never loads");
});

test("a malformed optional group is refused", () => {
  const manifest = (optional) => ({ buildHash: "aaaaaaaaaa", offline: { files: {}, assets: [], cdn: [], optional } });
  assert.throws(() => parseOfflineBuild(manifest({}), SCOPE), /offline.optional is not a list/);
  assert.throws(() => parseOfflineBuild(manifest([{ urls: [OPTIONAL_MODULE] }]), SCOPE), /without hosts and urls/);
  assert.equal(parseOfflineBuild(manifest(undefined), SCOPE).entries.length, 0, "an older manifest has none");
});

// A module kept at runtime lives in the build cache that was current then;
// served from there after a deploy, it must move to the new current cache or
// the deploy after next prunes the only copy.
test("a kept CDN module follows the current build across deploys", async () => {
  const { site, offline } = setup();
  await offline.sync();
  const module = "https://cdn.jsdelivr.net/npm/@sentry/conventions@0.16.1/attributes/+esm";
  site.cdn[module] = "export {}";
  const kept = [];
  const respond = (url) => offline.respond(subresource(url), { waitUntil: (p) => kept.push(p) });
  await bodyOf(respond(module));
  await Promise.all(kept.splice(0));

  site.current = BUILD_B;
  await offline.sync();
  // Used online under B, answered from A's cache.
  await bodyOf(respond(module));
  await Promise.all(kept.splice(0));

  site.current = BUILD_C;
  await offline.sync();
  site.offline = true;
  assert.equal(await bodyOf(respond(module)), "export {}", "A's cache is gone; B's copy answers");
});

// The page side of offline support (web/js/offline.ts): the built site
// registers the worker at the root and reports what it caches to Debug
// Output and analytics, and the dev server, whose sources change on every
// edit, registers nothing.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createOfflineAnalytics,
  describeOfflineMessage,
  launchCountBucket,
  registerOfflineSupport,
} from "../../web/js/offline.ts";

const BUILT_MODULE_URL = "https://webchirp.test/js/app.ABCDEFGH.js";

// A ServiceWorkerContainer that records registrations and hands back one
// active worker recording what the page posts to it.
function fakeServiceWorker({ registerError = null } = {}) {
  const posted = [];
  const listeners = [];
  const container = {
    registered: [],
    posted,
    addEventListener(type, listener) {
      listeners.push([type, listener]);
    },
    async register(url, options) {
      if (registerError) {
        throw registerError;
      }
      container.registered.push([String(url), options]);
    },
    ready: Promise.resolve({ active: { postMessage: (message) => posted.push(message) } }),
    // What the worker says, as a message event would carry it.
    emit(data) {
      for (const [type, listener] of listeners) {
        if (type === "message") {
          listener({ data });
        }
      }
    },
  };
  return container;
}

test("the built site registers the worker at the root and asks what it has", async () => {
  const serviceWorker = fakeServiceWorker();
  const logged = [];
  await registerOfflineSupport({ logDebug: (line) => logged.push(line), moduleUrl: BUILT_MODULE_URL, serviceWorker });
  assert.deepEqual(serviceWorker.registered, [["https://webchirp.test/sw.js", { updateViaCache: "none" }]]);
  assert.deepEqual(serviceWorker.posted, [{ type: "webchirp-offline-status" }]);
  serviceWorker.emit({ type: "webchirp-offline", event: "ready", buildHash: "aaaaaaaaaa" });
  assert.match(logged.at(-1), /^OFFLINE READY build aaaaaaaaaa/);
});

test("the dev server registers nothing", async () => {
  const serviceWorker = fakeServiceWorker();
  const logged = [];
  await registerOfflineSupport({
    logDebug: (line) => logged.push(line),
    moduleUrl: "http://127.0.0.1:8000/js/offline.ts",
    serviceWorker,
  });
  assert.deepEqual(serviceWorker.registered, []);
  assert.deepEqual(logged, []);
});

test("a failed registration is reported in Debug Output, not thrown", async () => {
  const serviceWorker = fakeServiceWorker({ registerError: new Error("SecurityError: insecure origin") });
  const logged = [];
  await registerOfflineSupport({ logDebug: (line) => logged.push(line), moduleUrl: BUILT_MODULE_URL, serviceWorker });
  assert.match(logged.join("\n"), /OFFLINE ERROR service worker registration failed: .*insecure origin/);
});

test("a browser without service workers says so once", async () => {
  const logged = [];
  await registerOfflineSupport({ logDebug: (line) => logged.push(line), moduleUrl: BUILT_MODULE_URL, serviceWorker: undefined });
  assert.deepEqual(logged, ["OFFLINE unavailable: this browser has no service workers"]);
});

test("each worker message reads as one Debug Output line", () => {
  assert.match(
    describeOfflineMessage({ type: "webchirp-offline", event: "status", buildHash: null }),
    /^OFFLINE caching this version/,
  );
  assert.match(
    describeOfflineMessage({ type: "webchirp-offline", event: "status", buildHash: "bbbbbbbbbb" }),
    /^OFFLINE READY build bbbbbbbbbb/,
  );
  assert.match(
    describeOfflineMessage({ type: "webchirp-offline", event: "error", message: "HTTP 503" }),
    /^OFFLINE ERROR .*HTTP 503$/,
  );
  assert.equal(describeOfflineMessage({ type: "something-else" }), null);
  assert.equal(describeOfflineMessage(null), null);
});

// --- analytics ---------------------------------------------------------------

// localStorage as the counters use it.
function memoryStore() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
  };
}

// trackEvent recording what it was asked to send; answers sent unless told
// otherwise, as it does on the production host with gtag loaded.
function recorder({ sends = true } = {}) {
  const events = [];
  const trackEvent = (name, params = {}) => {
    events.push([name, params]);
    return sends;
  };
  return { events, trackEvent };
}

const ready = (buildHash) => ({ type: "webchirp-offline", event: "ready", buildHash });
const status = (servedFrom, buildHash = "aaaaaaaaaa") => ({ type: "webchirp-offline", event: "status", buildHash, servedFrom });

test("offline_ready is sent once per build, however many tabs hear about it", () => {
  const { events, trackEvent } = recorder();
  const store = memoryStore();
  const firstTab = createOfflineAnalytics(trackEvent, store);
  const secondTab = createOfflineAnalytics(trackEvent, store);
  firstTab(ready("aaaaaaaaaa"));
  secondTab(ready("aaaaaaaaaa"));
  secondTab(status("network", "aaaaaaaaaa"));
  firstTab(ready("bbbbbbbbbb"));
  assert.deepEqual(events, [["offline_ready", {}], ["offline_ready", {}]]);
});

test("a build is not marked reported when nothing was sent", () => {
  const store = memoryStore();
  createOfflineAnalytics(recorder({ sends: false }).trackEvent, store)(ready("aaaaaaaaaa"));
  const { events, trackEvent } = recorder();
  createOfflineAnalytics(trackEvent, store)(status("network", "aaaaaaaaaa"));
  assert.deepEqual(events, [["offline_ready", {}]], "the next network-served page reports it");
});

test("a page served from the cache reports nothing, only counts", () => {
  const { events, trackEvent } = recorder();
  const store = memoryStore();
  const report = createOfflineAnalytics(trackEvent, store);
  report(status("cache"));
  report(status("cache"));
  report(status("cache_after_timeout"));
  assert.deepEqual(events, [], "offline, gtag.js never loads, so nothing is sent");
  assert.deepEqual(JSON.parse(store.getItem("webchirp-offline-launches")), { cache: 2, cache_after_timeout: 1 });
});

test("the next network-served page sends the counted launches and clears them", () => {
  const { events, trackEvent } = recorder();
  const store = memoryStore();
  const report = createOfflineAnalytics(trackEvent, store);
  for (let i = 0; i < 7; i++) {
    report(status("cache"));
  }
  report(status("cache_after_timeout"));
  report(status("network"));
  assert.deepEqual(events, [
    ["offline_ready", {}],
    ["offline_launches", { served_from: "cache", launch_count: 7, launch_count_bucket: "6-20" }],
    ["offline_launches", { served_from: "cache_after_timeout", launch_count: 1, launch_count_bucket: "1" }],
  ]);
  report(status("network"));
  assert.equal(events.length, 3, "a count is sent once");
});

test("counts survive a page where analytics could not send", () => {
  const store = memoryStore();
  createOfflineAnalytics(recorder().trackEvent, store)(status("cache"));
  createOfflineAnalytics(recorder({ sends: false }).trackEvent, store)(status("network"));
  const { events, trackEvent } = recorder();
  createOfflineAnalytics(trackEvent, store)(status("network"));
  assert.deepEqual(events.filter(([name]) => name === "offline_launches"), [
    ["offline_launches", { served_from: "cache", launch_count: 1, launch_count_bucket: "1" }],
  ]);
});

test("a caching failure is sent with its reason", () => {
  const { events, trackEvent } = recorder();
  createOfflineAnalytics(trackEvent, memoryStore())({ type: "webchirp-offline", event: "error", message: "x", reason: "quota" });
  assert.deepEqual(events, [["offline_cache_failed", { error_kind: "quota" }]]);
});

test("without storage, and with a corrupt count, nothing throws", () => {
  const { trackEvent } = recorder();
  createOfflineAnalytics(trackEvent, null)(status("cache"));
  const store = memoryStore();
  store.setItem("webchirp-offline-launches", "{not json");
  createOfflineAnalytics(trackEvent, store)(status("cache"));
  assert.deepEqual(JSON.parse(store.getItem("webchirp-offline-launches")), { cache: 1 });
});

test("a store that throws loses the count, not the page", () => {
  const { trackEvent } = recorder();
  const broken = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  const report = createOfflineAnalytics(trackEvent, broken);
  assert.doesNotThrow(() => report(status("cache")));
  assert.doesNotThrow(() => report(ready("aaaaaaaaaa")));
});

test("a cached page defers analytics, a network page replays, a slow one does neither", () => {
  const calls = [];
  const replay = { defer: () => calls.push("defer"), replay: () => calls.push("replay") };
  const report = createOfflineAnalytics(recorder().trackEvent, memoryStore(), replay);
  report(status("cache"));
  report(status("cache_after_timeout"));
  report(status("network"));
  assert.deepEqual(calls, ["defer", "replay"]);
});

test("launch counts fall into four ranges", () => {
  assert.deepEqual([1, 2, 5, 6, 20, 21, 400].map(launchCountBucket), ["1", "2-5", "2-5", "6-20", "6-20", "21+", "21+"]);
});

test("registration wires the worker's messages to analytics", async () => {
  const serviceWorker = fakeServiceWorker();
  const { events, trackEvent } = recorder();
  await registerOfflineSupport({
    logDebug: () => {},
    trackEvent,
    store: memoryStore(),
    moduleUrl: BUILT_MODULE_URL,
    serviceWorker,
  });
  serviceWorker.emit(ready("aaaaaaaaaa"));
  assert.deepEqual(events, [["offline_ready", {}]]);
});

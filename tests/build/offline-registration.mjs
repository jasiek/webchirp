// The page side of offline support (web/js/offline.ts): the built site
// registers the worker at the root and reports what it caches to Debug
// Output, and the dev server, whose sources change on every edit, registers
// nothing.
import test from "node:test";
import assert from "node:assert/strict";

import { describeOfflineMessage, registerOfflineSupport } from "../../web/js/offline.ts";

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

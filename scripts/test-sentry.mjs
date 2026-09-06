import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  SENTRY_DSN,
  SENTRY_HOSTS,
  SENTRY_SDK_URL,
  SENTRY_SDK_VERSION,
  captureError,
  initOptions,
  initSentry,
  isSentryHost,
  resetSentryForTests,
  scrubEvent,
  scrubText,
  setContextProvider,
} from "../web/js/sentry.js";
import { ANALYTICS_HOSTS } from "../web/js/analytics.js";

// Error reporting fails silently by design -- a dropped event looks exactly
// like a quiet day in the Sentry console -- so the wiring is only ever checked
// here. Two things carry real consequence and are tested hardest:
//
//   - The redaction rules. An event that should never have been sent cannot be
//     unsent, and a rule that quietly stops matching is invisible in the UI.
//   - The host gate. A fork's Pages site or a dev server reporting into the
//     shared project buries real user errors under a developer's own branch.
const ROOT = process.cwd();

// Minimal window stand-in: records listeners so a test can dispatch at them and
// assert they were removed again, and answers fetch with a version.json.
function makeWindow({ hostname = "codeplug.org", version = { webchirpSha: "abc123" } } = {}) {
  const listeners = new Map();
  return {
    location: { hostname },
    addEventListener(type, handler) {
      const existing = listeners.get(type) || [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler));
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) {
        handler(event);
      }
    },
    fetch: async () => ({ ok: version !== null, json: async () => version }),
  };
}

// Fake SDK namespace with the same surface this module calls.
function makeSdk() {
  const captured = [];
  let options = null;
  return {
    captured,
    getOptions: () => options,
    init(opts) {
      options = opts;
    },
    // captureException is called from inside the scope callback, so the tag
    // bag has to be live before fn runs rather than collected after it.
    withScope(fn) {
      const tags = {};
      this.pendingTags = tags;
      fn({ setTag: (key, value) => { tags[key] = value; } });
      this.pendingTags = null;
    },
    captureException(error) {
      captured.push({ error, tags: this.pendingTags || {} });
    },
  };
}

test("the SDK URL is pinned to the version declared in package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const declared = String(pkg.dependencies?.["@sentry/browser"] || "").replace(/^[^\d]*/, "");
  assert.equal(
    SENTRY_SDK_VERSION,
    declared,
    "web/js/sentry.js ships a different SDK version than package.json pins",
  );
  assert.ok(SENTRY_SDK_URL.includes(`@sentry/browser@${declared}`));
});

test("reporting and analytics agree on which deployment is production", () => {
  // Two lists, one concept. If they drift, one vendor starts collecting from
  // hosts the other rejects and the reports stop lining up.
  assert.deepEqual([...SENTRY_HOSTS], [...ANALYTICS_HOSTS]);
});

test("the DSN points at a project, not a placeholder", () => {
  assert.match(SENTRY_DSN, /^https:\/\/[0-9a-f]+@o\d+\.ingest\.[a-z.]*sentry\.io\/\d+$/);
});

test("the host gate admits only the production deployment", () => {
  assert.equal(isSentryHost({ location: { hostname: "codeplug.org" } }), true);
  assert.equal(isSentryHost({ location: { hostname: "www.codeplug.org" } }), true);
  assert.equal(isSentryHost({ location: { hostname: "localhost" } }), false);
  assert.equal(isSentryHost({ location: { hostname: "jasiek.github.io" } }), false);
  assert.equal(isSentryHost({}), false);
  assert.equal(isSentryHost(null), false);
});

test("scrubText removes the user data a CHIRP traceback carries", () => {
  // Frequencies, in both the forms CHIRP prints them.
  assert.equal(scrubText("Frequency 145.500000 out of range"), "Frequency [num] out of range");
  assert.equal(scrubText("freq=145500000 invalid"), "freq=[num] invalid");
  // Coordinates, including a negative longitude.
  assert.equal(scrubText("at 51.5074,-0.1278"), "at [num],[num]");
  // A Maidenhead locator is a home address to within a few km.
  assert.equal(scrubText("locator IO82MM"), "locator [loc]");
  // File names are named after their owner as often as not.
  assert.equal(scrubText("could not parse Dads-UV5R.img"), "could not parse [file]");
  assert.equal(scrubText("bad row in channels.csv"), "bad row in [file]");
  // Channel names, which CHIRP quotes when it rejects one.
  assert.equal(scrubText('Value "HOME REPEATER" is not valid'), 'Value "[value]" is not valid');
  // Search terms and coordinates ride in the query string of a failed lookup.
  assert.equal(
    scrubText("GET https://api.codeplug.org/rsgb?lat=51.5&lon=-0.12 failed"),
    "GET https://api.codeplug.org/rsgb?[query] failed",
  );
});

test("scrubText keeps the parts of a traceback that make it useful", () => {
  // The quoted path naming a frame's file is the most useful line in a Python
  // traceback, and must survive the rule that redacts quoted values.
  const frame = '  File "/lib/python3.12/site-packages/chirp/drivers/uv5r.py", line 421, in sync_in';
  assert.equal(scrubText(frame), frame);
  // Exception types and the shape of the failure are not user data.
  assert.equal(
    scrubText("chirp.errors.RadioError: Radio did not respond"),
    "chirp.errors.RadioError: Radio did not respond",
  );
  // Version numbers are not frequencies.
  assert.equal(scrubText("pyodide 0.27.2 on python3.12"), "pyodide 0.27.2 on python3.12");
  assert.equal(scrubText(""), "");
  assert.equal(scrubText(undefined), undefined);
});

test("scrubEvent redacts messages, exception values and breadcrumbs", () => {
  const event = scrubEvent({
    message: "upload of backup.img failed",
    exception: {
      values: [{ type: "RadioError", value: 'Value "HOME" rejected at 145.500000' }],
    },
    breadcrumbs: [
      { category: "fetch", message: "fetch IO82MM", data: { url: "https://api.codeplug.org/q?lat=51.5" } },
    ],
    request: { url: "https://codeplug.org/?locator=IO82MM" },
  });
  assert.equal(event.message, "upload of [file] failed");
  // Documented limit of the file rule: a name with spaces in it is only
  // redacted from its last token, because widening the pattern to reach the
  // words before the extension eats the surrounding sentence too. Nothing in
  // this app puts a file name in a thrown error, so this is a backstop.
  assert.equal(scrubText("parse of My Radio.img"), "parse of My [file]");
  // The exception type survives; only the value it broke on is redacted.
  assert.equal(event.exception.values[0].type, "RadioError");
  assert.equal(event.exception.values[0].value, 'Value "[value]" rejected at [num]');
  assert.equal(event.breadcrumbs[0].message, "fetch [loc]");
  assert.equal(event.breadcrumbs[0].data.url, "https://api.codeplug.org/q?[query]");
  assert.equal(event.request.url, "https://codeplug.org/?[query]");
});

test("init options disable tracing and PII, and drop console breadcrumbs", () => {
  const options = initOptions("webchirp@abc123");
  assert.equal(options.dsn, SENTRY_DSN);
  assert.equal(options.release, "webchirp@abc123");
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0);
  // The debug panel exists to print full tracebacks; anything on the console
  // has already been through it.
  assert.equal(options.beforeBreadcrumb({ category: "console", message: "145.500000" }), null);
  const crumb = options.beforeBreadcrumb({ category: "fetch", message: "at 51.5074" });
  assert.equal(crumb.message, "at [num]");
});

test("beforeSend stamps context tags and redacts events the SDK raised itself", () => {
  resetSentryForTests();
  setContextProvider(() => ({ radio: "Baofeng UV-5R", radio_module: "uv5r", radio_class: "" }));
  const event = initOptions().beforeSend({
    message: "crash at 145.500000",
    tags: { error_kind: "checksum" },
  });
  assert.equal(event.tags.radio, "Baofeng UV-5R");
  assert.equal(event.tags.radio_module, "uv5r");
  // Empty values are dropped rather than sent as an empty tag.
  assert.equal("radio_class" in event.tags, false);
  // A tag set explicitly on the capture wins over the provider.
  assert.equal(event.tags.error_kind, "checksum");
  // Redaction still applies to events that never went through captureError.
  assert.equal(event.message, "crash at [num]");
  resetSentryForTests();
});

test("beforeSend survives a context provider that throws", () => {
  resetSentryForTests();
  setContextProvider(() => {
    throw new Error("state not ready");
  });
  const event = initOptions().beforeSend({ message: "boom" });
  assert.equal(event.message, "boom");
  resetSentryForTests();
});

test("off the production host nothing is requested from the vendor", async () => {
  resetSentryForTests();
  const win = makeWindow({ hostname: "localhost" });
  let loaded = false;
  const result = await initSentry(win, {
    loadSdk: async () => {
      loaded = true;
      return makeSdk();
    },
  });
  assert.equal(result, null);
  assert.equal(loaded, false, "the SDK was fetched on a non-production host");
  // No listeners are left behind either.
  assert.equal(win.listenerCount("error"), 0);
  assert.equal(win.listenerCount("unhandledrejection"), 0);
  resetSentryForTests();
});

test("init loads the SDK, tags the release, and reports afterwards", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  const win = makeWindow({ version: { webchirpSha: "deadbeef" } });
  const result = await initSentry(win, { loadSdk: async () => sdk });
  assert.equal(result, sdk);
  assert.equal(sdk.getOptions().release, "webchirp@deadbeef");

  captureError(new Error("clone failed"), {
    action: "Download",
    tags: { error_kind: "checksum", error_type: "RadioError" },
  });
  assert.equal(sdk.captured.length, 1);
  assert.equal(sdk.captured[0].tags.action, "Download");
  assert.equal(sdk.captured[0].tags.error_kind, "checksum");
  resetSentryForTests();
});

test("errors raised before the SDK arrives are buffered and replayed once", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  const win = makeWindow();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = initSentry(win, {
    loadSdk: async () => {
      await pending;
      return sdk;
    },
  });

  // The window this covers is the one that matters: the runtime boots from a
  // CDN, so "the app never started" happens before any of our code is ready.
  win.dispatch("error", { error: new Error("pyodide boot failed") });
  win.dispatch("unhandledrejection", { reason: new Error("import rejected") });
  assert.equal(sdk.captured.length, 0, "captures were sent before the SDK existed");

  release();
  await started;
  assert.equal(sdk.captured.length, 2);
  assert.equal(sdk.captured[0].error.message, "pyodide boot failed");
  assert.equal(sdk.captured[1].error.message, "import rejected");

  // The buffer's listeners must come off once the SDK's own global handlers
  // take over, or every later error is reported twice.
  assert.equal(win.listenerCount("error"), 0);
  assert.equal(win.listenerCount("unhandledrejection"), 0);
  resetSentryForTests();
});

test("a string capture is wrapped so it groups by message", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  await initSentry(makeWindow(), { loadSdk: async () => sdk });
  captureError("RUNTIME CRASH worker exited", { action: "Runtime" });
  assert.ok(sdk.captured[0].error instanceof Error);
  assert.equal(sdk.captured[0].error.message, "RUNTIME CRASH worker exited");
  resetSentryForTests();
});

test("a blocked or offline CDN costs reporting, not the app", async () => {
  resetSentryForTests();
  const win = makeWindow();
  const result = await initSentry(win, {
    loadSdk: async () => {
      throw new Error("network error");
    },
  });
  assert.equal(result, null);
  // Nothing is left listening, and a later capture is a silent no-op rather
  // than an exception thrown into whatever operation was reporting.
  assert.equal(win.listenerCount("error"), 0);
  assert.equal(captureError(new Error("later failure")), false);
  resetSentryForTests();
});

test("a missing version.json costs the release tag, not the reporting", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  const win = makeWindow({ version: null });
  await initSentry(win, { loadSdk: async () => sdk });
  assert.equal(sdk.getOptions().release, undefined);
  assert.equal(sdk.getOptions().dsn, SENTRY_DSN);
  resetSentryForTests();
});

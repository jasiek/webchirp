import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  METRIC_ATTRIBUTES,
  SENTRY_DSN,
  SENTRY_HOSTS,
  SENTRY_SDK_URL,
  SENTRY_SDK_VERSION,
  captureError,
  captureMetric,
  initOptions,
  initSentry,
  isSentryHost,
  resetSentryForTests,
  scrubEvent,
  scrubMetric,
  scrubMetricAttributes,
  scrubText,
  setContextProvider,
} from "../web/js/sentry.js";
import { ANALYTICS_HOSTS } from "../web/js/analytics.js";
import { makeWindow } from "./test-support/fake-window.mjs";
import { repoRoot } from "./test-support/repo-paths.mjs";

// Error reporting fails silently by design -- a dropped event looks exactly
// like a quiet day in the Sentry console -- so the wiring is only ever checked
// here. Two things carry real consequence and are tested hardest:
//
//   - The redaction rules. An event that should never have been sent cannot be
//     unsent, and a rule that quietly stops matching is invisible in the UI.
//   - The host gate. A fork's Pages site or a dev server reporting into the
//     shared project buries real user errors under a developer's own branch.
// Fake SDK namespace with the same surface this module calls.
function makeSdk() {
  const captured = [];
  const recorded = [];
  let options = null;
  return {
    captured,
    // Metrics go down a pipeline of their own in the real SDK, so the fake
    // keeps them in a separate list rather than folding them into captured.
    recorded,
    metrics: {
      count: (name, value, opts) => recorded.push({ type: "count", name, value, ...opts }),
      distribution: (name, value, opts) => recorded.push({ type: "distribution", name, value, ...opts }),
    },
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
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
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

test("metric attributes are an allowlist, not a filter on their contents", () => {
  const attributes = scrubMetricAttributes({
    flow: "radio_download",
    outcome: "failed",
    radio: "Baofeng UV-5R",
    error_kind: "checksum",
    // Stamped by the SDK itself, and what ties a metric to the build it came
    // from, so it has to survive.
    "sentry.release": "webchirp@abc123",
    // Stamped by the same SDK code from the scope's user. Empty today only
    // because this app never calls setUser, which is not a thing to rely on.
    "user.id": "u-1",
    "user.email": "someone@example.com",
    // Values rather than dimensions: GA sends these, a metric must not turn
    // them into series.
    duration_ms: 1234,
    channel_count: 128,
    // Anything undeclared, whatever it holds.
    channel_name: "HOME REPEATER",
    file_name: "Dads-UV5R.img",
  });
  assert.deepEqual(Object.keys(attributes).sort(), [
    "error_kind",
    "flow",
    "outcome",
    "radio",
    "sentry.release",
  ]);
});

test("metric attribute values are scrubbed as well as filtered", () => {
  // Defence in depth: an allowed key whose value was built from a caught error
  // could still carry user data.
  const attributes = scrubMetricAttributes({
    flow: "repeater_query",
    error_type: "at 51.5074",
    outcome: "",
  });
  assert.equal(attributes.error_type, "at [num]");
  // Empty values are dropped rather than sent as an empty series.
  assert.equal("outcome" in attributes, false);
});

test("every attribute the flow metrics send is declared", () => {
  // The counterpart to the CUSTOM_DIMENSIONS check in
  // scripts/test-ga-dimensions.mjs: a key added at a call site but not here is
  // silently dropped, which looks exactly like the flow never running.
  for (const name of ["flow", "outcome", "radio", "radio_module", "radio_class"]) {
    assert.ok(METRIC_ATTRIBUTES.includes(name), `${name} must be declared`);
  }
  assert.equal(METRIC_ATTRIBUTES.includes("duration_ms"), false);
  assert.equal(METRIC_ATTRIBUTES.includes("channel_count"), false);
});

test("scrubMetric leaves the metric's own shape alone", () => {
  const metric = scrubMetric({
    name: "flow.duration",
    type: "distribution",
    value: 1234,
    unit: "millisecond",
    attributes: { flow: "radio_upload", channel_name: "HOME" },
  });
  assert.equal(metric.name, "flow.duration");
  assert.equal(metric.value, 1234);
  assert.equal(metric.unit, "millisecond");
  assert.deepEqual(metric.attributes, { flow: "radio_upload" });
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
  // Metrics are on deliberately; structured logs are off so that adding a
  // console logging integration later cannot start shipping tracebacks down a
  // pipeline neither beforeSend nor beforeSendMetric polices.
  assert.equal(options.enableMetrics, true);
  assert.equal(options.enableLogs, false);
});

test("beforeSendMetric is the last gate, because beforeSend never sees a metric", () => {
  const metric = initOptions().beforeSendMetric({
    name: "flow.completed",
    type: "count",
    value: 1,
    attributes: { flow: "radio_download", "user.email": "someone@example.com" },
  });
  assert.deepEqual(metric.attributes, { flow: "radio_download" });
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

test("captureMetric emits counters and distributions with the UI's context", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  await initSentry(makeWindow(), { loadSdk: async () => sdk });
  setContextProvider(() => ({ radio: "Baofeng UV-5R", radio_module: "uv5r" }));

  captureMetric("flow.completed", {
    type: "count",
    value: 1,
    attributes: { flow: "radio_download", outcome: "failed", error_kind: "checksum" },
  });
  captureMetric("flow.duration", {
    type: "distribution",
    value: 4200,
    unit: "millisecond",
    attributes: { flow: "radio_download", outcome: "failed" },
  });

  assert.equal(sdk.recorded.length, 2);
  assert.equal(sdk.recorded[0].type, "count");
  assert.equal(sdk.recorded[0].name, "flow.completed");
  assert.equal(sdk.recorded[0].value, 1);
  // Context from the UI rides along, so a failure is attributable to a driver
  // without every call site having to pass the radio.
  assert.equal(sdk.recorded[0].attributes.radio, "Baofeng UV-5R");
  assert.equal(sdk.recorded[0].attributes.error_kind, "checksum");
  assert.equal(sdk.recorded[1].type, "distribution");
  assert.equal(sdk.recorded[1].value, 4200);
  assert.equal(sdk.recorded[1].unit, "millisecond");
  resetSentryForTests();
});

test("an attribute set at the call site wins over the context provider", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  await initSentry(makeWindow(), { loadSdk: async () => sdk });
  // The selection can change while a clone is in flight, and the outcome
  // belongs to the radio the transfer actually ran against.
  setContextProvider(() => ({ radio: "Selected Later" }));
  captureMetric("flow.completed", {
    type: "count",
    value: 1,
    attributes: { flow: "radio_upload", radio: "Baofeng UV-5R" },
  });
  assert.equal(sdk.recorded[0].attributes.radio, "Baofeng UV-5R");
  resetSentryForTests();
});

test("a metric of an unknown kind is dropped rather than thrown", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  await initSentry(makeWindow(), { loadSdk: async () => sdk });
  assert.equal(captureMetric("flow.completed", { type: "gauge", value: 1 }), true);
  assert.equal(sdk.recorded.length, 0);
  resetSentryForTests();
});

test("metrics recorded before the SDK arrives are replayed once", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = initSentry(makeWindow(), {
    loadSdk: async () => {
      await pending;
      return sdk;
    },
  });

  // app_start reports the boot that the SDK's own load is racing, so this is
  // not a hypothetical window.
  captureMetric("flow.completed", {
    type: "count",
    value: 1,
    attributes: { flow: "app_start", outcome: "failed" },
  });
  assert.equal(sdk.recorded.length, 0, "a metric was sent before the SDK existed");

  release();
  await started;
  assert.equal(sdk.recorded.length, 1);
  assert.equal(sdk.recorded[0].attributes.flow, "app_start");
  resetSentryForTests();
});

test("a buffered metric keeps the context it was recorded with", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = initSentry(makeWindow(), {
    loadSdk: async () => {
      await pending;
      return sdk;
    },
  });

  // The SDK's load overlaps app startup, which is long enough for a radio to be
  // selected or restored from a cookie in between. A metric describes the
  // moment it was recorded, so reading the context at drain time would file a
  // startup failure against a radio that had nothing to do with it.
  setContextProvider(() => ({ radio: "Baofeng UV-5R" }));
  captureMetric("flow.completed", {
    type: "count",
    value: 1,
    attributes: { flow: "app_start", outcome: "failed" },
  });
  setContextProvider(() => ({ radio: "Yaesu FT-60" }));

  release();
  await started;
  assert.equal(sdk.recorded.length, 1);
  assert.equal(sdk.recorded[0].attributes.radio, "Baofeng UV-5R");
  resetSentryForTests();
});

test("this module never sets a scope attribute, which would bypass the allowlist", () => {
  // beforeSendMetric runs before the SDK serializes a metric, and serialization
  // then merges the current and isolation scopes' attributes underneath the
  // metric's own. Anything set with the SDK's setAttribute() therefore reaches
  // Sentry without passing scrubMetricAttributes, and no init option closes
  // that. The app's guarantee is that it never sets one -- it reaches the SDK
  // only through this module -- so that is what is pinned here rather than a
  // behaviour the SDK does not offer.
  const source = fs.readFileSync(path.join(repoRoot, "web", "js", "sentry.js"), "utf8");
  assert.equal(
    /\.setAttributes?\s*\(/.test(source),
    false,
    "web/js/sentry.js sets a scope attribute, which is not covered by METRIC_ATTRIBUTES",
  );
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
  assert.equal(captureMetric("flow.completed", { type: "count", value: 1 }), false);
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

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
  OFFLINE_QUEUE_SIZE,
  initSentry,
  isIgnoredError,
  isSentryHost,
  resetSentryForTests,
  runtimeFingerprint,
  scrubEvent,
  scrubMetric,
  scrubMetricAttributes,
  scrubSpanUrl,
  scrubText,
  setContextProvider,
} from "../../web/js/sentry.ts";
import { ANALYTICS_HOSTS } from "../../web/js/analytics.ts";
import {
  SERIAL_PORT_OPEN_FAILED,
  USB_CHIP_SETUP_FAILED,
  USB_DEVICE_OPEN_FAILED,
  createSerialPortOpenFailedError,
  createUsbDeviceOpenFailedError,
  isUsbChipSetupFailed,
  nameUsbChipSetupFailure,
} from "../../web/js/serial-errors.ts";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";
import { SENTRY_SDK_MODULES } from "../../web/js/cdn-urls.ts";
import { makeWindow } from "../support/fake-window.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

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
    "web/js/sentry.ts ships a different SDK version than package.json pins",
  );
  assert.ok(SENTRY_SDK_URL.includes(`@sentry/browser@${declared}`));
});

// The service worker caches these so the SDK loads offline; one missing and
// the SDK's import fails there, taking the offline transport with it. Checked
// against the installed packages, which npm resolved the way jsDelivr did;
// tests/e2e/sentry-sdk-modules.mjs walks the real imports, and
// tests/build/build-dist.mjs checks the build lists them.
test("SENTRY_SDK_MODULES names every module of the SDK's build", () => {
  const installed = (name) => JSON.parse(
    fs.readFileSync(path.join(repoRoot, "node_modules", "@sentry", name, "package.json"), "utf8"),
  ).version;
  const browserDeps = Object.keys(JSON.parse(
    fs.readFileSync(path.join(repoRoot, "node_modules", "@sentry", "browser", "package.json"), "utf8"),
  ).dependencies);
  for (const dep of browserDeps) {
    const name = dep.replace("@sentry/", "");
    const prefix = `https://cdn.jsdelivr.net/npm/${dep}@${installed(name)}/`;
    assert.ok(
      SENTRY_SDK_MODULES.some((url) => url.startsWith(prefix)),
      `${dep}@${installed(name)} is imported by the SDK but not in SENTRY_SDK_MODULES (web/js/cdn-urls.ts)`,
    );
  }
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
  // The same deployment's second name, which reports into the same project.
  // Apex only -- neither www name resolves, so nothing ever runs there.
  assert.equal(isSentryHost({ location: { hostname: "webchirp.org" } }), true);
  assert.equal(isSentryHost({ location: { hostname: "www.webchirp.org" } }), false);
  assert.equal(isSentryHost({ location: { hostname: "www.codeplug.org" } }), false);
  assert.equal(isSentryHost({ location: { hostname: "localhost" } }), false);
  // Not a suffix match: a lookalike domain must not inherit the project.
  assert.equal(isSentryHost({ location: { hostname: "evil-webchirp.org" } }), false);
  assert.equal(isSentryHost({ location: { hostname: "jasiek.github.io" } }), false);
  assert.equal(isSentryHost({}), false);
  assert.equal(isSentryHost(null), false);
});

test("a port native Web Serial would not open is ignored by name, directly and through Pyodide", () => {
  const message = "Failed to execute 'open' on 'SerialPort': Failed to open serial port.";
  const failed = createSerialPortOpenFailedError(message);
  assert.equal(isIgnoredError(failed), true);
  const throughPython = runtimeCallError("JsException", `${SERIAL_PORT_OPEN_FAILED}: ${message}`, {
    js: { name: SERIAL_PORT_OPEN_FAILED, message },
  }, "webserial_connect");
  assert.equal(isIgnoredError(throughPython), true);
});

test("a WebUSB device the browser would not open is the user's machine; a chip setup failure is ours", () => {
  // The three stages of a WebUSB connect split the same way the native open
  // does: the OS refusing the device, like another driver holding its
  // interface, is dropped and counted by the metric; the chip's own setup
  // failing is this app's driver code and stays an event.
  const refused = createUsbDeviceOpenFailedError("PL2303: could not open USB device: Access denied.", new Error("Access denied."));
  assert.equal(isIgnoredError(refused), true);
  assert.equal(isIgnoredError(runtimeCallError("JsException", `${USB_DEVICE_OPEN_FAILED}: ${refused.message}`, {
    js: { name: USB_DEVICE_OPEN_FAILED, message: refused.message },
  }, "webserial_connect")), true);
  const setup = nameUsbChipSetupFailure(new Error("PL2303 vendor read failed (value 0x8484): stall"));
  assert.ok(isUsbChipSetupFailed(setup));
  assert.equal(isIgnoredError(setup), false);
  assert.equal(isIgnoredError(runtimeCallError("JsException", `${USB_CHIP_SETUP_FAILED}: ${setup.message}`, {
    js: { name: USB_CHIP_SETUP_FAILED, message: setup.message },
  }, "webserial_connect")), false);
});

test("other network and serial failures remain reportable", () => {
  // The same name the browser gives an open failure, on a port lost mid-clone:
  // only the renamed open failure is dropped.
  const lost = runtimeCallError("JsException", "NetworkError: The device has been lost.", {
    js: { name: "NetworkError", message: "The device has been lost." },
  }, "webserial_read");
  assert.equal(isIgnoredError(lost), false);
  const raw = new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port.");
  raw.name = "NetworkError";
  assert.equal(isIgnoredError(raw), false);
  assert.equal(isIgnoredError(new TypeError("unexpected value")), false);
});

test("a browser without WebAssembly reports nothing", () => {
  // Safari's Lockdown Mode removes the global (WEBCHIRP-FRONTEND-1S): the
  // runtime cannot boot, so whatever fails next is that, whatever it is called.
  const bootFailure = new ReferenceError("Can't find variable: WebAssembly");
  const saved = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly");
  delete globalThis.WebAssembly;
  try {
    assert.equal(isIgnoredError(bootFailure), true);
    assert.equal(isIgnoredError(new Error("Initialization failed")), true);
  } finally {
    Object.defineProperty(globalThis, "WebAssembly", saved);
  }
  // With WebAssembly present the same ReferenceError is a bug like any other.
  assert.equal(isIgnoredError(bootFailure), false);
});

test("only browser noise is left to message patterns", () => {
  assert.deepEqual(initOptions().ignoreErrors.map(String), [
    "/ResizeObserver loop/i",
    "/Invalid call to runtime\\.sendMessage\\(\\)/",
    "/Object Not Found Matching Id:\\d+, MethodName:\\w+, ParamCount:\\d+$/",
  ]);
  const [, extension, linkScanner] = initOptions().ignoreErrors;
  assert.ok(extension instanceof RegExp);
  assert.ok(extension.test("Invalid call to runtime.sendMessage(). Tab not found."));
  // Matched against the value the SDK builds for a non-Error rejection, which
  // is what WEBCHIRP-FRONTEND-1T was titled.
  assert.ok(linkScanner instanceof RegExp);
  assert.ok(linkScanner.test(
    "Non-Error promise rejection captured with value: Object Not Found Matching Id:6, MethodName:update, ParamCount:4",
  ));
  assert.equal(linkScanner.test("Object Not Found"), false);
});

test("scripts that are not this app's are denied by origin", () => {
  const denyUrls = initOptions().denyUrls;
  assert.ok(Array.isArray(denyUrls));
  const denied = (url) => denyUrls.some((pattern) => pattern instanceof RegExp && pattern.test(url));
  assert.ok(denied("chrome-extension://abcdef/content.js"));
  // Facebook's and Instagram's in-app browser on Android.
  assert.ok(denied("iabjs://navigation_performance_logger_android"));
  assert.equal(denied("https://webchirp.org/js/app.OI2X7MXU.js"), false);
  assert.equal(denied("https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.asm.js"), false);
});

test("runtime failures group by class, method and the function that raised them", () => {
  // Every runtime failure is thrown from one line of unwrapRpcEnvelope, so
  // Sentry's stack-based grouping put every RadioError from every driver in
  // one issue. Two drivers' failures must now land apart...
  const firmware = runtimeCallError("RadioError", "Firmware version is not supported by this driver", {
    origin: { module: "chirp.drivers.uvk5", function: "_sayhello" },
  }, "download_selected_radio");
  const shortRead = runtimeCallError("RadioError", "Tried to read 8 bytes, but got 0 bytes instead.", {
    origin: { module: "chirp.drivers.puxing_px888k", function: "_read" },
  }, "download_selected_radio");
  assert.deepEqual(runtimeFingerprint(firmware), [
    "runtime-call", "RadioError", "download_selected_radio", "chirp.drivers.uvk5._sayhello",
  ]);
  assert.notDeepEqual(runtimeFingerprint(firmware), runtimeFingerprint(shortRead));

  // ...while one raise site stays one issue whatever values its message names.
  const channel = (n) => runtimeCallError(
    "RuntimeUnsupportedError",
    `Channel ${n}: This image is read-only due to being from a radio with unsupported firmware`,
    { origin: { module: "webchirp_bridge.radio_memories", function: "_apply_rows_to_radio_instance" } },
    "export_image_base64",
  );
  assert.deepEqual(runtimeFingerprint(channel(2)), runtimeFingerprint(channel(17)));

  // The same raise site reached through a different flow is a different issue.
  const upload = runtimeCallError("RadioError", "Firmware version is not supported by this driver", {
    origin: { module: "chirp.drivers.uvk5", function: "_sayhello" },
  }, "upload_selected_radio");
  assert.notDeepEqual(runtimeFingerprint(firmware), runtimeFingerprint(upload));
});

test("beforeSend sets the runtime grouping key and leaves other errors to Sentry", () => {
  // A driver tripping over an empty read: reported, unlike a driver's own
  // complaint about the radio (tests/channels/chirp-error-filter.mjs).
  const error = runtimeCallError("TypeError", "ord() expected a character, but string of length 0 found", {
    origin: { module: "chirp.drivers.anytone778uv", function: "_read" },
  }, "download_selected_radio");
  const event = initOptions().beforeSend(
    { exception: { values: [{ type: error.name, value: error.message }] } },
    { originalException: error },
  );
  assert.deepEqual(event.fingerprint, [
    "runtime-call", "TypeError", "download_selected_radio", "chirp.drivers.anytone778uv._read",
  ]);
  assert.equal(event.contexts.python.raised_in, "chirp.drivers.anytone778uv._read");

  const plain = new Error("something else broke");
  const plainEvent = initOptions().beforeSend(
    { exception: { values: [{ type: plain.name, value: plain.message }] } },
    { originalException: plain },
  );
  assert.equal(plainEvent.fingerprint, undefined);
  assert.equal(runtimeFingerprint(plain), null);
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
    scrubText("GET https://api.webchirp.org/rsgb?lat=51.5&lon=-0.12 failed"),
    "GET https://api.webchirp.org/rsgb?[query] failed",
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
      { category: "fetch", message: "fetch IO82MM", data: { url: "https://api.webchirp.org/q?lat=51.5" } },
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
  assert.equal(event.breadcrumbs[0].data.url, "https://api.webchirp.org/q?[query]");
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
  // tests/channels/ga-dimensions.mjs: a key added at a call site but not here is
  // silently dropped, which looks exactly like the flow never running.
  for (const name of [
    "flow", "outcome", "radio", "radio_module", "radio_class",
    // The cable a connect or a transfer ran over: a model of adapter, never
    // one adapter in particular.
    "chip", "usb_vendor_id", "usb_product_id",
  ]) {
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

test("init options trace one load in ten, send no PII, and drop console breadcrumbs", () => {
  const options = initOptions("webchirp@abc123");
  assert.equal(options.dsn, SENTRY_DSN);
  assert.equal(options.release, "webchirp@abc123");
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0.1);
  // No request carries sentry-trace or baggage: on api.webchirp.org an
  // unexpected header is a CORS preflight its allowlist may refuse. An empty
  // list, not an absent one, which the SDK reads as "same origin".
  assert.deepEqual(options.tracePropagationTargets, []);
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

test("tracing is the loaded SDK's browser integration", () => {
  const tracing = { name: "BrowserTracing" };
  assert.deepEqual(initOptions("webchirp@abc123", { browserTracingIntegration: () => tracing }).integrations, [tracing]);
  // An SDK without it (a test's fake) traces nothing rather than throwing.
  assert.deepEqual(initOptions("webchirp@abc123", {}).integrations, []);
});

// The values a span must never carry, each as one of this app's requests puts
// it in a URL: a place name typed into the gazetteer and the position it was
// asked near, a directory query's centre, the callsign a map was hovered for,
// and a map tile's coordinates at street zoom.
const SPAN_SECRETS = ["Little", "Snoring", "52.86", "0.912", "51.5074", "-0.1278", "GB3WB", "16372", "10895"];
const CITY_LOOKUP = "https://api.webchirp.org/cities?q=Little%20Snoring&lat=52.86&lon=0.912";

function assertNoSpanSecrets(value) {
  const sent = JSON.stringify(value);
  for (const secret of SPAN_SECRETS) {
    assert.equal(sent.includes(secret), false, `${secret} left in ${sent}`);
  }
}

test("scrubSpanUrl drops every query and fragment, and every path off the app's own hosts", () => {
  assert.equal(scrubSpanUrl(CITY_LOOKUP), "https://api.webchirp.org/[path]");
  // The callsign lookup puts its search term in the path, and a map tile its
  // position, so another host's path goes whatever it looks like.
  assert.equal(scrubSpanUrl("https://api.webchirp.org/lookup/GB3WB"), "https://api.webchirp.org/[path]");
  assert.equal(scrubSpanUrl("https://tile.openstreetmap.org/15/16372/10895.png"), "https://tile.openstreetmap.org/[path]");
  // The app's own files and the CDN's keep their paths: which file was slow is
  // the point of a resource span.
  assert.equal(scrubSpanUrl("https://webchirp.org/?radio=uv5r#top"), "https://webchirp.org/");
  assert.equal(
    scrubSpanUrl("https://codeplug.org/chirp/chirp-7a4123ad.zip?v=2"),
    "https://codeplug.org/chirp/chirp-7a4123ad.zip",
  );
  assert.equal(
    scrubSpanUrl("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.asm.wasm"),
    "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.asm.wasm",
  );
  // Relative is the page's own origin.
  assert.equal(scrubSpanUrl("./version.json?t=1"), "./version.json");
  // Not a suffix match, for the same reason as the host gate.
  assert.equal(scrubSpanUrl("https://evil-webchirp.org/IO82MM"), "https://evil-webchirp.org/[path]");
});

test("beforeSendSpan drops the query strings that carry search terms and coordinates", () => {
  const { beforeSendSpan } = initOptions();
  // A fetch span as the SDK builds one: the query rides in the URL attributes
  // and again, on its own, in http.query.
  const fetchSpan = beforeSendSpan({
    description: `GET ${CITY_LOOKUP}`,
    op: "http.client",
    data: {
      url: CITY_LOOKUP,
      "http.url": CITY_LOOKUP,
      "url.full": CITY_LOOKUP,
      "http.query": "?q=Little%20Snoring&lat=52.86&lon=0.912",
      "http.fragment": "#Little-Snoring",
      "http.method": "GET",
      "server.address": "api.webchirp.org",
      "sentry.op": "http.client",
    },
  });
  assertNoSpanSecrets(fetchSpan);
  assert.equal(fetchSpan.description, "GET https://api.webchirp.org/[path]");
  assert.equal(fetchSpan.data["url.full"], "https://api.webchirp.org/[path]");
  assert.equal("http.query" in fetchSpan.data, false);
  assert.equal("http.fragment" in fetchSpan.data, false);
  // What the span is for survives: which host, which method, how it ran.
  assert.equal(fetchSpan.data["server.address"], "api.webchirp.org");
  assert.equal(fetchSpan.data["http.method"], "GET");
  assert.equal(fetchSpan.data["sentry.op"], "http.client");

  const directory = "https://api.webchirp.org/repeaterbook?country=United%20Kingdom&latitude=51.5074&longitude=-0.1278";
  assertNoSpanSecrets(beforeSendSpan({ description: `GET ${directory}`, data: { url: directory } }));
  assertNoSpanSecrets(beforeSendSpan({
    description: "GET https://api.webchirp.org/lookup/GB3WB",
    data: { url: "https://api.webchirp.org/lookup/GB3WB" },
  }));

  // A resource span names a file from the page's own origin by its path, and
  // a map tile by its whole URL.
  const own = beforeSendSpan({
    description: "/chirp/chirp-7a4123ad.zip?lat=52.86#GB3WB",
    op: "resource.fetch",
    data: { "url.full": "https://webchirp.org/chirp/chirp-7a4123ad.zip?lat=52.86#GB3WB", "url.same_origin": true },
  });
  assert.equal(own.description, "/chirp/chirp-7a4123ad.zip");
  assert.equal(own.data["url.full"], "https://webchirp.org/chirp/chirp-7a4123ad.zip");
  assert.equal(own.data["url.same_origin"], true);
  const tile = beforeSendSpan({
    description: "https://tile.openstreetmap.org/15/16372/10895.png",
    op: "resource.img",
    data: { "url.full": "https://tile.openstreetmap.org/15/16372/10895.png" },
  });
  assertNoSpanSecrets(tile);
  assert.equal(tile.description, "https://tile.openstreetmap.org/[path]");
});

test("beforeSendSpan redacts the page load and a span named by its element", () => {
  const { beforeSendSpan } = initOptions();
  // The page load's root span, which the SDK passes through beforeSendSpan
  // too: url.full is the whole address bar.
  const pageload = beforeSendSpan({
    description: "/",
    op: "pageload",
    data: { "url.full": "https://webchirp.org/?radio=uv5r&lat=52.86#GB3WB", "url.path": "/" },
  });
  assertNoSpanSecrets(pageload);
  assert.equal(pageload.data["url.full"], "https://webchirp.org/");
  // An interaction span is named after the element's selector, attributes and
  // all, which is the same text a click breadcrumb carries.
  const click = beforeSendSpan({
    description: 'body > td[title="GB3WB 145.500000"]',
    op: "ui.interaction.click",
    data: { "sentry.op": "ui.interaction.click", "lcp.element": "img.map[alt=\"52.86, 0.912\"]" },
  });
  assertNoSpanSecrets(click);
  assert.equal(click.description, 'body > td[title="[value]"]');
});

test("beforeSendTransaction redacts the page's address, the referrer and the breadcrumbs", () => {
  const event = initOptions().beforeSendTransaction({
    type: "transaction",
    transaction: "/",
    contexts: { trace: { op: "pageload", data: { "url.full": "https://webchirp.org/?q=Little%20Snoring" } } },
    request: {
      url: "https://webchirp.org/?radio=uv5r&lat=52.86#GB3WB",
      headers: { Referer: "https://forum.example.org/thread/GB3WB?lat=51.5074", "User-Agent": "Mozilla/5.0" },
    },
    breadcrumbs: [{ category: "fetch", data: { url: CITY_LOOKUP } }],
  });
  assertNoSpanSecrets(event);
  assert.equal(event.request.url, "https://webchirp.org/");
  assert.equal(event.request.headers.Referer, "https://forum.example.org/[path]");
  assert.equal(event.request.headers["User-Agent"], "Mozilla/5.0");
  assert.equal(event.contexts.trace.data["url.full"], "https://webchirp.org/");
  assert.equal(event.contexts.trace.op, "pageload");
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

// An error or flow metric from a page with no network is stored and sent
// later rather than lost: the SDK's own offline transport, around its fetch
// transport, with a queue larger than its default.
test("sends go through the SDK's offline transport", async () => {
  resetSentryForTests();
  const sdk = makeSdk();
  const fetchTransport = () => ({});
  sdk.makeFetchTransport = fetchTransport;
  sdk.makeBrowserOfflineTransport = (inner) => ({ offline: true, inner });
  await initSentry(makeWindow(), { loadSdk: async () => sdk });
  const options = sdk.getOptions();
  assert.deepEqual(options.transport, { offline: true, inner: fetchTransport });
  assert.deepEqual(options.transportOptions, { maxQueueSize: OFFLINE_QUEUE_SIZE, flushAtStartup: true });
  assert.ok(OFFLINE_QUEUE_SIZE > 30, "larger than the SDK's default of 30");
  // Without the factories (an SDK that lacks them) the default transport stays.
  assert.equal(initOptions("webchirp@abc123", {}).transport, undefined);
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
  const source = fs.readFileSync(path.join(repoRoot, "web", "js", "sentry.ts"), "utf8");
  assert.equal(
    /\.setAttributes?\s*\(/.test(source),
    false,
    "web/js/sentry.ts sets a scope attribute, which is not covered by METRIC_ATTRIBUTES",
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

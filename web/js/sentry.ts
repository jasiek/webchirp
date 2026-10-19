// Sentry error reporting.
//
// Shaped deliberately like web/js/analytics.ts, and for the same reasons: the
// production-host gate, the vendor loader and the redaction rules all live in
// one module, so no feature module has to know whether reporting is switched on
// or what it is allowed to send. Loaded with type="module", so it runs after
// the document is parsed but before app.js does any work.
//
// This module is generic on purpose. It knows nothing about CHIRP, radios or
// codeplugs -- the UI layer supplies those as tags through captureError() and
// setContextProvider(). That keeps the dependency arrow pointing one way and
// keeps the redaction rules below readable as a single list of "things a user
// owns", rather than being spread across the modules that happen to produce
// them.
//
// The SDK is a runtime dependency of the browser, not of Node: it is declared
// in package.json to pin the version of record, and shipped from the CDN URL
// below. tests/channels/sentry.mjs fails the build if the two drift apart.

import { SENTRY_SDK_URL, SENTRY_SDK_VERSION } from "./cdn-urls.ts";
import { isServerOutage } from "./http-errors.ts";
import { isPythonError, isRuntimeCallError } from "./runtime-errors.ts";
import {
  isSerialPortOpenFailed,
  isSerialUnsupported,
  isUsbDeviceOpenFailed,
  isUsbInterfaceBusy,
} from "./serial-errors.ts";
import type { BrowserOptions } from "@sentry/browser";
import type { RpcMethodName } from "./rpc-dispatch.ts";

// The SDK's namespace as the CDN's +esm build exports it, typed from the npm
// package package.json pins to the same version (tests/channels/sentry.mjs
// keeps the two in step). Type-only: nothing here imports the package.
export type SentrySdk = typeof import("@sentry/browser");

// The SDK's own shapes for what its hooks are handed, from the npm package the
// CDN build is the same version of (type-only: nothing is imported at runtime).
type SentryEvent = Parameters<NonNullable<BrowserOptions["beforeSend"]>>[0];
type SentryBreadcrumb = Parameters<NonNullable<BrowserOptions["beforeBreadcrumb"]>>[0];
type SentryMetrics = NonNullable<SentrySdk["metrics"]>;
type MetricOptions = Parameters<SentryMetrics["count"]>[2];
export type CaptureContext = {action?: string, tags?: Record<string, unknown>};
export interface MetricRecord {
  type: "count" | "distribution";
  value: number;
  unit?: string;
  attributes?: Record<string, unknown>;
}

// Project this app reports into. Unlike a secret, a DSN is meant to be public --
// it only grants the right to submit events -- which is why it can sit in a
// file served to every visitor. The host gate below, not the DSN's secrecy, is
// what keeps other people's copies out of the project.
export const SENTRY_DSN =
  "https://bb59bf03dbcc6894696fcaaf97d24e1d@o4511981618462720.ingest.de.sentry.io/4512037978308688";

// jsDelivr's flattened ESM build of @sentry/browser, pinned to an exact
// version, lives in web/js/cdn-urls.ts with the other CDN URLs; re-exported
// here because this module is what loads it.
export { SENTRY_SDK_URL, SENTRY_SDK_VERSION };

// Only the production deployment reports, for the reason spelled out at length
// in analytics.ts: anyone can serve this app, and every copy carries the DSN
// above, so without this gate a developer reloading localhost and a fork's
// Pages site land in the same project as real users. An error that only ever
// happens on someone's half-finished branch is worse than no error at all --
// it is a bug report against code that was never deployed.
//
// This list must stay in step with ANALYTICS_HOSTS; the same deployment is
// "production" for both, and tests/channels/sentry.mjs fails if they diverge.
export const SENTRY_HOSTS = Object.freeze([
  "codeplug.org",
  "webchirp.org",
]);

// Browser noise that is never actionable: a benign layout notification, a
// browser extension's messaging call failing inside the page (Safari and
// Firefox word it this way; the event carries no extension frame for
// denyUrls to match, WEBCHIRP-FRONTEND-K), and the rejection Microsoft's
// link scanner leaves behind when it opens a link pasted into Outlook or
// Teams -- its embedded browser calls back into a host object the page never
// had, and rejects with a bare string naming the object id and method
// (WEBCHIRP-FRONTEND-1T: no stack, no click, no radio). The SDK titles that
// "Non-Error promise rejection captured with value: Object Not Found...", so
// the pattern is unanchored at the start. All three are raised
// outside this app's code, so nothing here can name them, and they stay
// message patterns for the SDK's own ignoreErrors filter. Everything this app
// raises is filtered by name or type instead (isIgnoredError below).
const IGNORE_ERRORS = Object.freeze([
  /ResizeObserver loop/i,
  /Invalid call to runtime\.sendMessage\(\)/,
  /Object Not Found Matching Id:\d+, MethodName:\w+, ParamCount:\d+$/,
]);

// The CHIRP errors that describe the user's file, the user's radio or the
// user's cable, by class name within the module that defines them.
//
// The rule names its classes rather than taking the module whole, because the
// module is not a severity boundary. Upstream CHIRP is a desktop app where
// every one of these ends in a dialog box, so it never had to tell "the user
// handed us something we cannot use" apart from "we asked for something that
// does not exist". The classes below are the first kind: a CSV with no
// channels in it, a value or a tone the radio will not take, an image no
// driver claims, a radio that did not answer because the cable is not in. The
// ones deliberately left out are the second kind and stay reportable --
// InvalidMemoryLocation (we computed a channel bound the driver rejects),
// FrozenMemoryError (we mutated a memory we were told not to), and the bare
// RadioError the drivers raise as a catch-all. That one is dropped only where
// a driver's clone protocol raised it (isDriverCloneFailure below); anywhere
// else it stays a report.
//
// chirp.settings is here because CHIRP defines InvalidValueError twice.
// chirp/chirp/settings.py has its own, unrelated to the chirp.errors one:
// RadioSettingValue.set_value raises it for a setting value the radio will not
// take, and 18 drivers import it instead of the chirp.errors class and raise it
// from their own range checks -- kguv9dplus refusing a VFO frequency outside
// the radio's bands (WEBCHIRP-FRONTEND-2D, -2E) is a value the driver was
// handed and will not take, which is what the chirp.errors class means too.
// No other listed name is defined twice in chirp/. The one raise of it that is
// not about a value, RadioSettingValueMap rejecting a driver's malformed map,
// happens whenever the driver builds its settings, which upstream's
// test_settings does for every driver image before a release.
export const IGNORED_CHIRP_ERRORS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "chirp.errors": Object.freeze([
    "InvalidDataError",
    "InvalidValueError",
    "UnsupportedToneError",
    "ImageDetectFailed",
    "ImageMetadataInvalidModel",
    "RadioNoResponse",
    "RadioNoContactLikelyK1",
    "RadioFixedBanks",
  ]),
  "chirp.settings": Object.freeze(["InvalidValueError"]),
});

// The RPC methods that run a clone over the serial port, which is CHIRP's
// sync_in or sync_out with the driver's own protocol code in charge
// (web/python/webchirp_bridge/clone.py). Typed by the dispatcher's method
// names, so renaming either one fails the typecheck instead of quietly
// switching the rule off.
const CLONE_RPC_METHODS: ReadonlySet<string> = new Set<RpcMethodName>([
  "download_selected_radio",
  "upload_selected_radio",
]);

// The classes a driver raises when the radio did not answer the way its
// protocol expected, by class and defining module: CHIRP's catch-all
// RadioError, and the bare Exception that older drivers (h777, wouxun_common)
// raise for the same thing. Exact on both: the subclasses of either are
// another rule's to judge.
const DRIVER_CLONE_COMPLAINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "chirp.errors": Object.freeze(["RadioError"]),
  builtins: Object.freeze(["Exception"]),
});

// Whether a failure is a driver's clone protocol giving up on the radio: one
// of the DRIVER_CLONE_COMPLAINTS, raised from a chirp.drivers module during a
// download or an upload, and chained only from others of its kind or from
// IGNORED_CHIRP_ERRORS. A handshake the radio refused, a firmware the driver
// does not know, a block that came back short or unacknowledged.
//
// This used to be reported on purpose, because a short read from the Web
// Serial stand-in (web/python/webchirp_bridge/serial_pipe.py) would surface
// here too, and the hope was that Sentry would show one. It never told the
// two apart: the class is the same whether the radio or the pipe lost the
// byte, so each event was a guess, and the fingerprint (runtimeFingerprint
// below) opened a new issue for every driver that complained, faster than
// archiving could close them -- 30 of 34 events over 2026-10-16/17. A pipe
// that loses bytes now shows as a clone failure rate that moves with the
// transport across every driver, which the flow metrics carry
// (web/js/ui/serial-actions.ts) and a single event never could.
//
// What stays reported is what the driver did not say itself. A cause of any
// other class -- an AttributeError on the pipe, a TypeError from an empty
// read, a JsException from the serial bridge -- is a defect the driver merely
// wrapped, so one such cause anywhere in the chain keeps the event.
function isDriverCloneFailure(error: unknown): boolean {
  if (!isRuntimeCallError(error) || !CLONE_RPC_METHODS.has(error.rpcMethod)) {
    return false;
  }
  if (!error.pythonOrigin.module.startsWith("chirp.drivers.")) {
    return false;
  }
  return isNamedIn(DRIVER_CLONE_COMPLAINTS, error.pythonType, error.pythonModule)
    && error.pythonCauses.every((cause) => isNamedIn(DRIVER_CLONE_COMPLAINTS, cause.type, cause.module)
      || isIgnoredChirpClass(cause.type, cause.module));
}

// What fetch() rejects with when the request never got a response -- the tab
// went offline, a CDN was blocked, a proxy dropped the connection -- in
// Chromium, Firefox and Safari respectively. The SDK's fetch instrumentation
// appends the request's host in parentheses ("Failed to fetch (webchirp.org)"),
// so that suffix is allowed. The match is whole-message on purpose: Chromium's
// "Failed to fetch dynamically imported module" is a missing deploy chunk as
// often as a dropped network, and stays reported.
const NETWORK_FAILURE_MESSAGE =
  /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)(?: \([^()]*\))?$/;

// Whether a failure is fetch() reporting that the network let it down. Nothing
// in this app can act on that: the user's connection is not a bug, and the
// offline cache (web/js/offline-cache.ts) already covers what can be covered.
// An HTTP error status is not one of these: fetchOk() in python-sources.ts
// throws for it through createHttpStatusError (web/js/http-errors.ts), and
// isIgnoredError drops only the outage statuses that names. Gated on
// TypeError, which is the only thing fetch() rejects with for a network
// failure, so an Error that merely quotes the sentence is kept.
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE_MESSAGE.test(error.message);
}

// Whether this browser has no WebAssembly at all. Pyodide is WebAssembly, so
// without it the runtime cannot boot and every failure that follows is that
// one circumstance: Safari's Lockdown Mode removes the global, and so can
// enterprise policy (WEBCHIRP-FRONTEND-1S). A property of the browser rather
// than of any one error, read live so a test can take it away.
function webAssemblyMissing(): boolean {
  return typeof globalThis.WebAssembly === "undefined";
}

// Whether a failure is one this app never reports: a browser without the serial
// API, a port native Web Serial would not open, a USB interface another driver
// holds (all three named in web/js/serial-errors.ts), the network failing a
// fetch, the host answering with an outage status (web/js/http-errors.ts),
// the runtime's own "you have not done X yet" guard, a driver's clone protocol
// giving up on the radio, or a CHIRP error
// from the list above -- or anything at all in a browser without WebAssembly,
// which cannot run the runtime and so has nothing to report that is not that.
// None is a bug in this app or in CHIRP. Read off the
// RuntimeCallError the dispatcher throws (web/js/runtime-errors.ts), which
// beforeSend receives as the hint's originalException -- for a capture from the one funnel and for an
// unhandled rejection through the SDK's global handlers alike.
//
// RuntimePreconditionError (web/python/webchirp_bridge/runtime_errors.py) is
// what the runtime raises when an action needs something the user has not
// supplied -- pressing Upload before ever downloading, most of all. Its message
// is already the instruction that fixes it, so a report says only that someone
// pressed the buttons out of order, once per person who did. It is matched as
// a class or any subclass of it; the sentence is user-facing copy, and a rule
// on the wording would lapse silently the next time it improved.
//
// The CHIRP rule is exact on both class and defining module, never on a base:
// RuntimeUnsupportedError and ImageDetectionError subclass errors.RadioError,
// so a hierarchy match on the listed classes' shared base would swallow them,
// while an exact match leaves them -- defined in
// webchirp_bridge.runtime_errors -- reported as before. A class is dropped
// only under a module the list names for it: chirp.settings is named for
// InvalidValueError alone, so the same name from any other module is kept.
//
// The rule is applied to the failure and to the exception it was raised from,
// because a wrapper describes the same circumstance as what it wraps.
// load_image_base64 re-raises chirp.errors.ImageDetectFailed ("Unknown file
// format": the user dropped something that is not a radio image) as
// ImageDetectionError, which the all-drivers retry needs by that name -- so
// judged by its own class the user's file reached Sentry as a bug. Only the
// nearest cause counts, and only an explicit one (raise ... from): what that
// exception was itself raised from was already the wrapper's author's to
// judge, and a failure Python merely recorded as raised while handling an
// ignored one -- ga510 reading the port inside its RadioNoResponse handler --
// is a defect of its own.
//
// Dropping the events does not drop the signal. This filters events only,
// while the failure metrics in web/js/ui/metrics.ts carry error_kind,
// error_type and the driver out through beforeSendMetric -- so "what share of
// clones fail on this model" stays a question a dashboard can answer even for
// the classes filtered here. The debug panel still prints the whole traceback.
export function isIgnoredError(error: unknown): boolean {
  if (
    webAssemblyMissing()
    || isSerialUnsupported(error)
    || isSerialPortOpenFailed(error)
    || isUsbDeviceOpenFailed(error)
    || isUsbInterfaceBusy(error)
    || isNetworkFailure(error)
    || isServerOutage(error)
    || isPythonError(error, "RuntimePreconditionError")
  ) {
    return true;
  }
  if (!isRuntimeCallError(error)) {
    return false;
  }
  if (isDriverCloneFailure(error)) {
    return true;
  }
  const cause = error.pythonCauses[0];
  return isIgnoredChirpClass(error.pythonType, error.pythonModule)
    || (cause !== undefined && cause.explicit && isIgnoredChirpClass(cause.type, cause.module));
}

// Whether a Python class, named by class and defining module, is one of the
// IGNORED_CHIRP_ERRORS. Split out because isIgnoredError asks it twice: of the
// failure, and of the exception the failure was raised from.
function isIgnoredChirpClass(type: string, module: string): boolean {
  return isNamedIn(IGNORED_CHIRP_ERRORS, type, module);
}

// Whether a table keyed by defining module lists a class under that module.
// Object.hasOwn, because the module name is the Python side's text and
// "constructor" must not find Object's.
function isNamedIn(table: Readonly<Record<string, readonly string[]>>, type: string, module: string): boolean {
  return Object.hasOwn(table, module) && table[module].includes(type);
}

// Script origins that are never this app: browser extensions, and the script
// Facebook's and Instagram's in-app browser on Android injects into every page
// it shows (iabjs://, whose "Java object is gone" outlives the app's own
// WebView bridge -- WEBCHIRP-FRONTEND-4).
const DENY_URLS = Object.freeze([
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-(?:web-)?extension:\/\//i,
  /^iabjs:\/\//i,
]);

// Everything a user owns that could otherwise ride along inside an error
// message, applied to every string this module sends. CLAUDE.md forbids sending
// file names, channel names, frequencies, search terms and coordinates, and a
// CHIRP traceback is exactly where all five turn up -- "Frequency 145.500000
// out of range for HOME REPEATER" is a useful bug report and a description of
// someone's radio at the same time.
//
// The rules keep the shape of the failure while dropping the values: what broke
// and where stays, which value it broke on does not. Order matters, because the
// later numeric rules would otherwise eat digits out of the earlier patterns.
const SCRUB_RULES: ReadonlyArray<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = Object.freeze([
  // Query strings first. A repeater query puts the user's coordinates in the
  // URL, so the URL of a failed fetch is a location fix.
  [/(https?:\/\/[^\s"'<>]*?)\?[^\s"'<>]*/gi, "$1?[query]"],
  // Codeplug file names, which are named after their owner as often as not.
  // This is defence in depth: nothing in this app throws with a file name in
  // the message, and CHIRP is handed bytes rather than a name. It matches a
  // single unspaced token deliberately -- widening it to swallow the words
  // before the extension is what it would take to catch "My Radio.img" whole,
  // and regex leftmost-matching means that also eats the sentence around it,
  // turning "could not parse backup.img" into nothing but "[file]".
  [/[^\s"'/\\]+\.(?:img|csv|chirp)\b/gi, "[file]"],
  // Quoted values, which is how CHIRP's validation reports the thing it
  // rejected. Quoted *paths* are exempt: a Python traceback names each frame's
  // file that way, and those lines are the most useful part of the report.
  [
    /"([^"\n]{1,120})"/g,
    (match, inner) => (/[/\\]|\.py$/.test(inner) ? match : '"[value]"'),
  ],
  // Maidenhead locator, e.g. IO82MM -- a home address to within a few km.
  [/\b[A-R]{2}\d{2}[A-X]{2}\b/g, "[loc]"],
  // Frequencies and coordinates alike: 145.500000, 51.5074, -0.1278. Three
  // decimal places is the threshold that spares version numbers (0.27.2) and
  // Python's own "python3.12" while catching every frequency CHIRP prints.
  [/-?\b\d+\.\d{3,}\b/g, "[num]"],
  // The same frequencies as the drivers hold them internally, in whole Hz.
  [/\b\d{7,10}\b/g, "[num]"],
]);

// Apply every redaction rule to one string. Exported so the rules can be tested
// directly -- they are the part of this module that has to be right, and a
// rule that silently stops matching is invisible in the Sentry UI.
export function scrubText(value: string): string;
export function scrubText<T>(value: T): T;
export function scrubText(value: unknown): unknown {
  if (typeof value !== "string" || value === "") {
    return value;
  }
  let out = value;
  for (const [pattern, replacement] of SCRUB_RULES) {
    // replace() is declared once for a string and once for a replacer
    // function, and picks neither for their union, so each is named.
    out = typeof replacement === "string"
      ? out.replace(pattern, replacement)
      : out.replace(pattern, replacement);
  }
  return out;
}

// Metric attribute keys this app is allowed to send, and the whole of what
// makes metrics safe to send at all. An error message is free-form text the
// SCRUB_RULES above have to chase; a metric attribute is a value we chose to
// attach, so the honest control is a list of the keys rather than a filter on
// their contents. This is the job CUSTOM_DIMENSIONS does in
// web/js/analytics.ts -- one declared vocabulary, reviewed as a unit -- minus
// the vendor registration, which Sentry does not require.
//
// Every key here is a CHIRP driver identifier, a fixed enum, or a bucketed
// count. Nothing read out of a codeplug belongs on the list.
export const METRIC_ATTRIBUTES = Object.freeze([
  // Which flow, and how it ended. These two are on every metric; the rest
  // narrow a broken flow down to a cause.
  "flow",
  "outcome",
  // Which radio, so a failure rate can be read per driver rather than in
  // aggregate -- the difference between "clones fail" and "clones fail on this
  // one model".
  "radio",
  "radio_module",
  "radio_class",
  // Why it broke.
  "error_kind",
  "error_type",
  "stage",
  "first_column",
  // What it ran in. Web Serial is Chromium only, WebUSB behaves differently per
  // platform, and every browser on iOS is Safari underneath whatever brand it
  // wears -- so for this app these are often the dimension that explains a
  // failure rate rather than merely describing it. Both are bounded tokens from
  // web/js/ui/format.ts, never a version and never a raw user agent.
  "browser",
  "platform",
  // What it was working on or over.
  "transport",
  // The cable: the chip family behind the port (ftdi, pl2303, ch340, cp2102,
  // cdc) and its USB vendor and product ids, as "0x067B". These name a model
  // of adapter, never its owner -- there is no serial number here -- and they
  // are what turns "WebUSB connects fail" into "PL2303 cables fail at chip
  // setup", the question the failure metric exists to answer.
  "chip",
  "usb_vendor_id",
  "usb_product_id",
  "format",
  "import_source",
  "codeplug_source",
  "channel_count_bucket",
  "catalog_source",
  "repeater_source",
]);

// The SDK stamps its own attributes on every metric before beforeSendMetric
// runs -- sentry.release, sentry.environment, sentry.sdk.* -- and those are
// what tie a metric back to the build that produced it, so they survive the
// filter. Its user.id, user.email and user.name are stamped by the very same
// code and are deliberately not exempt: they are empty today only because this
// app never calls setUser, and a filter that leans on that is one call site
// away from being wrong.
const SDK_ATTRIBUTE_PREFIX = "sentry.";

// Drop every attribute not on the list above, then scrub the strings that
// remain. The scrub is defence in depth rather than the control: an allowed key
// whose value was built from a caught error could still carry a frequency.
export function scrubMetricAttributes(
  attributes: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (!METRIC_ATTRIBUTES.includes(key) && !key.startsWith(SDK_ATTRIBUTE_PREFIX)) {
      continue;
    }
    out[key] = typeof value === "string" ? scrubText(value) : value;
  }
  return out;
}

// The last gate every metric this app records passes through, and the
// counterpart to scrubEvent(). It has to exist separately because Sentry runs
// metrics down a pipeline of their own: beforeSend is never called for them, so
// none of the redaction above would otherwise apply.
//
// One documented limit, because the boundary is narrower than it looks:
// beforeSendMetric runs *before* the SDK serializes the metric, and
// _buildSerializedMetric then merges the current and isolation scopes'
// attributes into the payload underneath the metric's own. Anything set with
// the SDK's setAttribute() would therefore reach Sentry without passing through
// here, and there is no option that closes that -- the isolation scope is
// merged whatever scope a capture is given. The app's guarantee rests on never
// setting one: it reaches the SDK only through this module, and
// tests/channels/sentry.mjs fails if a setAttribute call appears in it.
export function scrubMetric<T extends { attributes?: Record<string, unknown> } | null | undefined>(metric: T): T {
  if (!metric || typeof metric !== "object") {
    return metric;
  }
  metric.attributes = scrubMetricAttributes(metric.attributes);
  return metric;
}

// Redact a breadcrumb in place. Breadcrumb data carries fetch URLs, so it needs
// the same treatment as a message body.
function scrubBreadcrumb(crumb: SentryBreadcrumb): SentryBreadcrumb {
  if (!crumb || typeof crumb !== "object") {
    return crumb;
  }
  if (typeof crumb.message === "string") {
    crumb.message = scrubText(crumb.message);
  }
  if (crumb.data && typeof crumb.data === "object") {
    for (const key of Object.keys(crumb.data)) {
      if (typeof crumb.data[key] === "string") {
        crumb.data[key] = scrubText(crumb.data[key]);
      }
    }
  }
  return crumb;
}

// Redact every free-form string on an outgoing event. Exception *types* are
// left alone: "RadioError" is a class name from CHIRP, not user data, and it is
// what makes an unrecognised failure legible.
export function scrubEvent(event: SentryEvent): SentryEvent {
  if (!event || typeof event !== "object") {
    return event;
  }
  if (typeof event.message === "string") {
    event.message = scrubText(event.message);
  }
  for (const value of event.exception?.values || []) {
    if (typeof value?.value === "string") {
      value.value = scrubText(value.value);
    }
  }
  for (const crumb of event.breadcrumbs || []) {
    scrubBreadcrumb(crumb);
  }
  const python = event.contexts?.python;
  if (python && typeof python === "object") {
    for (const key of ["message", "traceback", "js_cause"]) {
      if (typeof python[key] === "string") {
        python[key] = scrubText(python[key]);
      }
    }
  }
  if (typeof event.request?.url === "string") {
    event.request.url = scrubText(event.request.url);
  }
  return event;
}

// Put the Python side of a runtime failure on its event, as a "python"
// context. The event's own exception is the RuntimeCallError: its type is the
// Python class and its value the one-line message, which is what Sentry titles
// and groups by, and its stack is the JS call that asked for the method. The
// frames that say where CHIRP broke are only in the traceback, which used to
// ride in the exception value and now rides here instead; scrubEvent redacts
// it like any other free-form text.
function attachPythonContext(event: SentryEvent, error: unknown): void {
  if (!isRuntimeCallError(error)) {
    return;
  }
  event.contexts = {
    ...(event.contexts || {}),
    python: {
      type: error.pythonType,
      module: error.pythonModule,
      bases: error.pythonBases.join(", "),
      message: error.message,
      traceback: error.pythonTraceback,
      js_cause: error.jsCause ? `${error.jsCause.name}: ${error.jsCause.message}` : "",
      rpc_method: error.rpcMethod,
      raised_in: [error.pythonOrigin?.module, error.pythonOrigin?.function].filter(Boolean).join("."),
    },
  };
}

// The grouping key for a runtime failure, or null for any other error, which
// keeps Sentry's default grouping.
//
// Sentry groups an event by its exception type and stack. Every runtime
// failure is thrown from the same line of unwrapRpcEnvelope
// (web/js/rpc-dispatch.ts), so the stack never differs, and every RadioError
// from every driver -- a UV-K5 refusing its firmware, a PX-888K answering
// with no bytes -- became one issue whose title was whichever came last.
// Archiving that issue would hide them all. The key here is the Python class,
// the RPC method that failed and the module and function that raised it,
// which is what tells two such failures apart. The message stays out: it
// carries values ("Channel 17: ...") and changes with CHIRP's wording.
export function runtimeFingerprint(error: unknown): string[] | null {
  if (!isRuntimeCallError(error)) {
    return null;
  }
  const { module, function: fn } = error.pythonOrigin ?? { module: "", function: "" };
  return [
    "runtime-call",
    error.pythonType,
    error.rpcMethod,
    module && fn ? `${module}.${fn}` : module || fn,
  ];
}

// The loaded SDK namespace, or null while reporting is off or still loading.
let sdk: SentrySdk | null = null;

// Captures raised before the SDK finished loading. The window this covers is
// small but it is the one that matters: Pyodide boots from a CDN behind a
// WebAssembly feature check, so "the app never started" is precisely the class
// of failure that happens before any of our code is ready to report it.
// Metrics recorded in the same window, kept apart from the captures above
// only because they are replayed through a different SDK call.
const pendingCaptures: Array<[unknown, CaptureContext]> = [];
const pendingMetrics: Array<[string, Partial<MetricRecord>]> = [];
const MAX_PENDING = 10;

// Tags stamped onto every event, supplied by the UI so this module does not
// have to reach into application state. Replaced wholesale by
// setContextProvider(); called on each event so it always reflects the radio
// selected at the time of the failure rather than at page load.
let contextProvider: () => Record<string, unknown> = () => ({});

export function setContextProvider(provider: (() => Record<string, unknown>) | null | undefined): void {
  contextProvider = typeof provider === "function" ? provider : () => ({});
}

// Read the UI's context without letting it fail the report it was meant to
// enrich. A provider that throws costs the tags, not the event or the metric.
function safeContext() {
  try {
    return contextProvider() || {};
  } catch {
    return {};
  }
}

// Whether this copy of the app is the one allowed to report. Reads the live
// location every time rather than caching, so a test can drive the module
// against a fake window.
export function isSentryHost(win: { location?: { hostname?: string } } | null | undefined): boolean {
  return SENTRY_HOSTS.includes(String(win?.location?.hostname || ""));
}

// String tags only: Sentry indexes tags for search and drops structured values,
// and a tag whose value is "[object Object]" is worse than an absent one.
function stringTags(source: Record<string, unknown> | null | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    tags[key] = String(value);
  }
  return tags;
}

// Which commit built the site, so a stack trace can be read against the code
// that produced it. Comes from the same version.json the footer widget reads,
// rather than being baked in here, because that file is regenerated on every
// build while this one is not.
async function resolveRelease(win: Pick<Window, "fetch">): Promise<string | undefined> {
  try {
    const response = await win.fetch("./version.json", { cache: "no-cache" });
    if (!response?.ok) {
      return undefined;
    }
    const version = await response.json();
    return version?.webchirpSha ? `webchirp@${version.webchirpSha}` : undefined;
  } catch {
    // A release tag is a nicety; losing it must not cost us the error report.
    return undefined;
  }
}

// Hand one capture to the SDK with its tags attached. Strings are wrapped in an
// Error so they group by message like everything else -- Sentry files a bare
// string as a "Non-Error exception" with no useful title. The caller passes the
// loaded SDK it has just checked for, so this never runs against a null one.
function sendCapture(client: SentrySdk, error: unknown, { action, tags }: CaptureContext = {}) {
  const payload = typeof error === "string" ? new Error(error) : error;
  client.withScope((scope) => {
    if (action) {
      scope.setTag("action", String(action));
    }
    for (const [key, value] of Object.entries(stringTags(tags))) {
      scope.setTag(key, value);
    }
    client.captureException(payload);
  });
}

// Report a failure the app already handled. Callers pass the action that failed
// and whatever tags classify it; this is a no-op wherever reporting is off, so
// no caller has to guard.
//
// Never throws: telemetry must not be able to fail the operation it is
// reporting on, which is the same rule trackEvent() follows.
/**
 * @param error An Error, or a message to wrap in one.
 * @returns Whether the SDK took it (false while buffered or off).
 */
export function captureError(error: unknown, context: CaptureContext = {}): boolean {
  try {
    if (!sdk) {
      if (pendingCaptures.length < MAX_PENDING) {
        pendingCaptures.push([error, context]);
      }
      return false;
    }
    sendCapture(sdk, error, context);
    return true;
  } catch {
    return false;
  }
}

// The metric kinds this app records, each mapped to the SDK call that emits it.
// Counters answer "how often", distributions answer "how long". Gauges are
// deliberately absent: a gauge samples a level over time, and a page that lives
// for one clone session has no level worth sampling.
const METRIC_EMITTERS: Readonly<Record<MetricRecord["type"], (
  metrics: SentryMetrics,
  name: string,
  value: number,
  options: MetricOptions,
) => void>> = Object.freeze({
  count: (metrics, name, value, options) => metrics.count(name, value, options),
  distribution: (metrics, name, value, options) => metrics.distribution(name, value, options),
});

// Hand one metric to the SDK with its attributes filtered. Context from the UI
// is merged underneath the caller's, so an attribute set explicitly at the call
// site still wins -- the same precedence beforeSend gives tags. Like
// sendCapture(), it is handed the SDK its caller checked for.
function sendMetric(
  client: SentrySdk,
  name: string,
  { type, value, unit, attributes }: Partial<MetricRecord> = {},
) {
  const emit = type ? METRIC_EMITTERS[type] : undefined;
  // A kind nobody wired up, or a CDN build without the metrics namespace. Both
  // are silent: a missing metric must not become a thrown error.
  if (!emit || !client.metrics) {
    return;
  }
  emit(client.metrics, String(name), Number(value), {
    unit,
    attributes: scrubMetricAttributes({ ...safeContext(), ...attributes }),
  });
}

// Record one operational metric. Metrics sit alongside captureError() rather
// than replacing it, and answer a different question: an error says one session
// broke and hands you the stack, a metric says what share of sessions break and
// is the thing a dashboard can group by driver or by flow.
//
// Buffered like a capture when the SDK has not landed yet, and never throws --
// telemetry must not be able to fail the operation it is reporting on.
export function captureMetric(name: string, metric: Partial<MetricRecord> = {}): boolean {
  try {
    if (!sdk) {
      if (pendingMetrics.length < MAX_PENDING) {
        // The context is snapshotted here rather than read at drain time. A
        // buffered metric describes the moment it was recorded, and the SDK's
        // load overlaps app startup -- long enough for a radio to be selected
        // or restored in between, which would otherwise attribute an app_start
        // or runtime metric to a radio that had nothing to do with it. The
        // snapshot wins on drain because sendMetric() merges context underneath
        // the metric's own attributes.
        pendingMetrics.push([
          name,
          { ...metric, attributes: { ...safeContext(), ...metric.attributes } },
        ]);
      }
      return false;
    }
    sendMetric(sdk, name, metric);
    return true;
  } catch {
    return false;
  }
}

// Catch unhandled failures raised before the SDK is ready, and replay them once
// it is. These listeners are removed the moment the SDK's own global handlers
// take over, so nothing is reported twice.
function bufferEarlyErrors(win: Window): () => void {
  const onError = (event: ErrorEvent) => {
    captureError(event?.error || event?.message || "Unknown error");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    captureError(event?.reason ?? "Unhandled promise rejection");
  };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}

function drainPendingCaptures(client: SentrySdk) {
  const queued = pendingCaptures.splice(0, pendingCaptures.length);
  for (const [error, context] of queued) {
    try {
      sendCapture(client, error, context);
    } catch {
      // One malformed capture must not strand the rest of the queue.
    }
  }
}

function drainPendingMetrics(client: SentrySdk) {
  const queued = pendingMetrics.splice(0, pendingMetrics.length);
  for (const [name, metric] of queued) {
    try {
      sendMetric(client, name, metric);
    } catch {
      // One malformed metric must not strand the rest of the queue.
    }
  }
}

// How many envelopes -- an error each, or a batch of metrics -- the offline
// transport keeps while sends fail. The SDK's default is 30; a field day spent
// programming radios with no signal can fail more flows than that.
export const OFFLINE_QUEUE_SIZE = 100;

// The SDK's two transport factories initOptions() composes; the real SDK and
// a test's fake both provide them.
type TransportFactories = Pick<SentrySdk, "makeBrowserOfflineTransport" | "makeFetchTransport">;
// What the offline transport takes. The client spreads transportOptions into
// the options it builds the transport with, but types the field as the plain
// fetch transport's, so the offline ones are typed from the factory itself.
type OfflineTransportOptions = Partial<Parameters<ReturnType<SentrySdk["makeBrowserOfflineTransport"]>>[0]>;

// Options handed to Sentry.init. Split out so a test can assert on them without
// standing up the real SDK.
//
// With the SDK at hand, sends go through its offline transport: an envelope
// that cannot be sent -- the page was served from the service worker's cache,
// or the network dropped mid-session -- is stored in IndexedDB and sent at the
// next startup or when the browser comes back online, with the timestamp it
// was captured at. Everything stored has already been through beforeSend or
// beforeSendMetric, so IndexedDB never holds anything unredacted.
export function initOptions(release: string | undefined, sdk?: TransportFactories | null): BrowserOptions {
  const transportOptions: OfflineTransportOptions = { maxQueueSize: OFFLINE_QUEUE_SIZE, flushAtStartup: true };
  const offlineTransport = sdk?.makeBrowserOfflineTransport && sdk.makeFetchTransport
    ? { transport: sdk.makeBrowserOfflineTransport(sdk.makeFetchTransport), transportOptions }
    : {};
  return {
    ...offlineTransport,
    dsn: SENTRY_DSN,
    release,
    environment: "production",
    // No IP addresses, no cookies, no request headers. The default, set here
    // because it is the kind of default that must not change silently.
    sendDefaultPii: false,
    // Errors only. Performance tracing would multiply the event volume for a
    // browser app whose slow part is a CDN download nobody can act on.
    tracesSampleRate: 0,
    maxBreadcrumbs: 30,
    // Metrics default to on in the SDK; set explicitly for the same reason
    // sendDefaultPii is, because it is a decision rather than an inherited
    // default. Nothing is sent until a captureMetric() call site asks for it.
    enableMetrics: true,
    // Structured logs default to on too. Nothing calls Sentry.logger today, so
    // this changes nothing now -- it is here so that wiring up a console
    // logging integration later cannot quietly start shipping the debug panel's
    // tracebacks, the same content beforeBreadcrumb drops, down a pipeline that
    // neither beforeSend nor beforeSendMetric polices.
    enableLogs: false,
    ignoreErrors: [...IGNORE_ERRORS],
    denyUrls: [...DENY_URLS],
    // Console breadcrumbs are dropped wholesale rather than redacted: the debug
    // panel's whole job is to print full tracebacks, and anything that reaches
    // the console has already been through it.
    beforeBreadcrumb: (crumb) => (crumb?.category === "console" ? null : scrubBreadcrumb(crumb)),
    // The last gate every event passes through. A failure isIgnoredError
    // names is dropped here; then tags from the UI are applied so an explicit
    // tag on a capture still wins, a runtime failure gets its Python side
    // attached and its grouping key (runtimeFingerprint), and the whole event
    // is redacted -- including events the SDK
    // raised on its own, which never went through captureError().
    beforeSend: (event, hint) => {
      const original = hint?.originalException;
      if (isIgnoredError(original)) {
        return null;
      }
      event.tags = { ...stringTags(safeContext()), ...(event.tags || {}) };
      attachPythonContext(event, original);
      const fingerprint = runtimeFingerprint(original);
      if (fingerprint) {
        event.fingerprint = fingerprint;
      }
      return scrubEvent(event);
    },
    // Metrics never pass through beforeSend, so the allowlist has to be applied
    // on their own way out. This runs after the SDK has added its own
    // attributes, which is what makes it the last word on what leaves.
    beforeSendMetric: (metric) => scrubMetric(metric),
  };
}

// Load the SDK and start reporting. Off the production host this returns
// without requesting anything from the vendor at all -- the import below is
// dynamic for exactly that reason, since a static one would fetch the SDK on
// every fork and dev server before the gate could run.
//
// loadSdk is injectable so tests can drive the whole path without reaching the
// network.
export async function initSentry(
  win: Window | null | undefined,
  { loadSdk = () => import(SENTRY_SDK_URL) }: { loadSdk?: () => Promise<SentrySdk> } = {},
): Promise<SentrySdk | null> {
  if (!win || !isSentryHost(win)) {
    return null;
  }
  const stopBuffering = bufferEarlyErrors(win);
  let loaded: SentrySdk;
  try {
    // Both are network round trips and neither needs the other, so they overlap
    // rather than adding up.
    const [module, release] = await Promise.all([loadSdk(), resolveRelease(win)]);
    module.init(initOptions(release, module));
    loaded = module;
    sdk = module;
  } catch {
    // The CDN is blocked, offline, or serving something unusable. The app is
    // unaffected; it simply reports nothing.
    pendingCaptures.length = 0;
    pendingMetrics.length = 0;
    return null;
  } finally {
    stopBuffering();
  }
  drainPendingCaptures(loaded);
  drainPendingMetrics(loaded);
  return loaded;
}

// Test seam: lets a test start from a known state rather than inheriting the
// SDK a previous test installed.
export function resetSentryForTests() {
  sdk = null;
  pendingCaptures.length = 0;
  pendingMetrics.length = 0;
  contextProvider = () => ({});
}

if (typeof window !== "undefined") {
  initSentry(window);
}

// Sentry error reporting.
//
// Shaped deliberately like js/analytics.js, and for the same reasons: the
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
// below. scripts/test-sentry.mjs fails the build if the two drift apart.

// Project this app reports into. Unlike a secret, a DSN is meant to be public --
// it only grants the right to submit events -- which is why it can sit in a
// file served to every visitor. The host gate below, not the DSN's secrecy, is
// what keeps other people's copies out of the project.
export const SENTRY_DSN =
  "https://bb59bf03dbcc6894696fcaaf97d24e1d@o4511981618462720.ingest.de.sentry.io/4512037978308688";

// jsDelivr's flattened ESM build of @sentry/browser, pinned to an exact
// version. This is how every other third-party browser dependency arrives here
// (Pyodide, the Web Serial polyfill): there is no bundler in this project, so
// an npm package cannot be imported by the browser directly.
export const SENTRY_SDK_VERSION = "10.73.0";
export const SENTRY_SDK_URL =
  `https://cdn.jsdelivr.net/npm/@sentry/browser@${SENTRY_SDK_VERSION}/+esm`;

// Only the production deployment reports, for the reason spelled out at length
// in analytics.js: anyone can serve this app, and every copy carries the DSN
// above, so without this gate a developer reloading localhost and a fork's
// Pages site land in the same project as real users. An error that only ever
// happens on someone's half-finished branch is worse than no error at all --
// it is a bug report against code that was never deployed.
//
// This list must stay in step with ANALYTICS_HOSTS; the same deployment is
// "production" for both, and scripts/test-sentry.mjs fails if they diverge.
export const SENTRY_HOSTS = Object.freeze(["codeplug.org", "www.codeplug.org"]);

// Noise that is never actionable: a benign layout notification the browser
// raises, and failures thrown by whatever the user has installed into their
// own browser. Neither is this app's code.
const IGNORE_ERRORS = Object.freeze([
  /ResizeObserver loop/i,
]);

const DENY_URLS = Object.freeze([
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-(?:web-)?extension:\/\//i,
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
const SCRUB_RULES = Object.freeze([
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
export function scrubText(value) {
  if (typeof value !== "string" || value === "") {
    return value;
  }
  let out = value;
  for (const [pattern, replacement] of SCRUB_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Redact a breadcrumb in place. Breadcrumb data carries fetch URLs, so it needs
// the same treatment as a message body.
function scrubBreadcrumb(crumb) {
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
export function scrubEvent(event) {
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
  if (typeof event.request?.url === "string") {
    event.request.url = scrubText(event.request.url);
  }
  return event;
}

// The loaded SDK namespace, or null while reporting is off or still loading.
let sdk = null;

// Captures raised before the SDK finished loading. The window this covers is
// small but it is the one that matters: Pyodide boots from a CDN behind a
// WebAssembly feature check, so "the app never started" is precisely the class
// of failure that happens before any of our code is ready to report it.
const pendingCaptures = [];
const MAX_PENDING = 10;

// Tags stamped onto every event, supplied by the UI so this module does not
// have to reach into application state. Replaced wholesale by
// setContextProvider(); called on each event so it always reflects the radio
// selected at the time of the failure rather than at page load.
let contextProvider = () => ({});

export function setContextProvider(provider) {
  contextProvider = typeof provider === "function" ? provider : () => ({});
}

// Whether this copy of the app is the one allowed to report. Reads the live
// location every time rather than caching, so a test can drive the module
// against a fake window.
export function isSentryHost(win) {
  return SENTRY_HOSTS.includes(String(win?.location?.hostname || ""));
}

// String tags only: Sentry indexes tags for search and drops structured values,
// and a tag whose value is "[object Object]" is worse than an absent one.
function stringTags(source) {
  const tags = {};
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
async function resolveRelease(win) {
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
// string as a "Non-Error exception" with no useful title.
function sendCapture(error, { action, tags } = {}) {
  const payload = typeof error === "string" ? new Error(error) : error;
  sdk.withScope((scope) => {
    if (action) {
      scope.setTag("action", String(action));
    }
    for (const [key, value] of Object.entries(stringTags(tags))) {
      scope.setTag(key, value);
    }
    sdk.captureException(payload);
  });
}

// Report a failure the app already handled. Callers pass the action that failed
// and whatever tags classify it; this is a no-op wherever reporting is off, so
// no caller has to guard.
//
// Never throws: telemetry must not be able to fail the operation it is
// reporting on, which is the same rule trackEvent() follows.
export function captureError(error, context = {}) {
  try {
    if (!sdk) {
      if (pendingCaptures.length < MAX_PENDING) {
        pendingCaptures.push([error, context]);
      }
      return false;
    }
    sendCapture(error, context);
    return true;
  } catch {
    return false;
  }
}

// Catch unhandled failures raised before the SDK is ready, and replay them once
// it is. These listeners are removed the moment the SDK's own global handlers
// take over, so nothing is reported twice.
function bufferEarlyErrors(win) {
  const onError = (event) => {
    captureError(event?.error || event?.message || "Unknown error");
  };
  const onRejection = (event) => {
    captureError(event?.reason ?? "Unhandled promise rejection");
  };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}

function drainPendingCaptures() {
  const queued = pendingCaptures.splice(0, pendingCaptures.length);
  for (const [error, context] of queued) {
    try {
      sendCapture(error, context);
    } catch {
      // One malformed capture must not strand the rest of the queue.
    }
  }
}

// Options handed to Sentry.init. Split out so a test can assert on them without
// standing up the real SDK.
export function initOptions(release) {
  return {
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
    ignoreErrors: [...IGNORE_ERRORS],
    denyUrls: [...DENY_URLS],
    // Console breadcrumbs are dropped wholesale rather than redacted: the debug
    // panel's whole job is to print full tracebacks, and anything that reaches
    // the console has already been through it.
    beforeBreadcrumb: (crumb) => (crumb?.category === "console" ? null : scrubBreadcrumb(crumb)),
    // The last gate every event passes through. Tags from the UI are applied
    // first so an explicit tag on a capture still wins, then the whole event is
    // redacted -- including events the SDK raised on its own, which never went
    // through captureError().
    beforeSend: (event) => {
      try {
        event.tags = { ...stringTags(contextProvider()), ...(event.tags || {}) };
      } catch {
        // A provider that throws costs the tags, not the report.
      }
      return scrubEvent(event);
    },
  };
}

// Load the SDK and start reporting. Off the production host this returns
// without requesting anything from the vendor at all -- the import below is
// dynamic for exactly that reason, since a static one would fetch the SDK on
// every fork and dev server before the gate could run.
//
// loadSdk is injectable so tests can drive the whole path without reaching the
// network.
export async function initSentry(win, { loadSdk = () => import(SENTRY_SDK_URL) } = {}) {
  if (!win || !isSentryHost(win)) {
    return null;
  }
  const stopBuffering = bufferEarlyErrors(win);
  try {
    // Both are network round trips and neither needs the other, so they overlap
    // rather than adding up.
    const [module, release] = await Promise.all([loadSdk(), resolveRelease(win)]);
    module.init(initOptions(release));
    sdk = module;
  } catch {
    // The CDN is blocked, offline, or serving something unusable. The app is
    // unaffected; it simply reports nothing.
    pendingCaptures.length = 0;
    return null;
  } finally {
    stopBuffering();
  }
  drainPendingCaptures();
  return sdk;
}

// Test seam: lets a test start from a known state rather than inheriting the
// SDK a previous test installed.
export function resetSentryForTests() {
  sdk = null;
  pendingCaptures.length = 0;
  contextProvider = () => ({});
}

if (typeof window !== "undefined") {
  initSentry(window);
}

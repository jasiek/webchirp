// Google Analytics wiring, shared by index.html and about.html.
//
// Everything with logic in it lives here so the two pages cannot drift: the
// production-host gate, the consent gate behind it, the gtag.js loader this
// module injects, the launch context, the install funnel, and the trackEvent()
// the rest of the app sends through. Loaded with type="module", so it runs
// after the document is parsed.
//
// Home-screen launches are the reason the display-mode plumbing exists: a
// WebAPK sends no referrer, so without a marker its traffic is indistinguishable
// from direct browser traffic. The manifest's start_url carries utm params for
// session attribution; display_mode below covers every hit including ones that
// navigate away from start_url.

import {
  CONSENT_SETTINGS_SELECTOR,
  hideConsentBanner,
  showConsentBanner,
  type ConsentChoice,
} from "./consent-banner.ts";

export type { ConsentChoice } from "./consent-banner.ts";

export const MEASUREMENT_ID = "G-80DP6MQ180";

// Only the production deployment reports. Anyone can serve this app — dev
// servers on localhost, forks on their own Pages site — and every copy carries
// the measurement ID above, so without this check they all land in the same
// property; one developer reloading localhost all day is then indistinguishable
// from real traffic, and a per-driver success rate is worth nothing.
//
// The vendor tag itself is gated rather than just our own events: it sends
// page_view and session_start on its own, which is the bulk of what has to stay
// out. Off-domain nothing is requested from googletagmanager, gtag stays
// undefined, and every trackEvent() call no-ops through the guard below.
//
// Both domains are listed because the app is moving between them. webchirp.org
// is what CNAME names and what Pages serves; codeplug.org is the name it was
// served under and now 301-redirects to webchirp.org, but a tab opened before
// the move keeps running the app from that origin, and that is production
// traffic reaching production code.
// Splitting either into its own property would halve every per-driver rate for
// no reason anyone reading the reports wants. Forks are unaffected either way,
// being on github.io or a domain of their own.
//
// Neither www name is listed: www.codeplug.org and www.webchirp.org are both
// NXDOMAIN, so location.hostname can never be either and an entry would be a
// branch that can never be taken.
export const ANALYTICS_HOSTS = Object.freeze([
  "codeplug.org",
  "webchirp.org",
]);

/** One GA4 custom dimension, in the Admin API's own field names. */
export interface CustomDimension {
  parameterName: string;
  displayName: string;
  description: string;
  /** EVENT, USER or ITEM; every one here is EVENT. */
  scope: string;
}

// Every event parameter this app sends, declared once here so the GA property
// can be brought in line with the code rather than the other way round — see
// `npm run ga:dimensions`. GA4 drops unregistered parameters from reports
// silently and never backfills them, so a parameter added in code but not here
// collects nothing until someone notices.
//
// parameterName and scope are immutable in the API: changing either means a new
// dimension and a new, empty history. displayName and description are patchable.
export const CUSTOM_DIMENSIONS: readonly Readonly<CustomDimension>[] = Object.freeze([
  {
    parameterName: "display_mode",
    displayName: "Display mode",
    description: "How the page was launched: browser, standalone, minimal-ui, fullscreen or window-controls-overlay.",
    scope: "EVENT",
  },
  {
    parameterName: "install_outcome",
    displayName: "Install outcome",
    description: "How the user answered the browser's PWA install prompt: accepted, dismissed or unknown.",
    scope: "EVENT",
  },
  {
    parameterName: "radio",
    displayName: "Radio",
    description: "Make and model of the radio an operation ran against, e.g. Baofeng UV-5R.",
    scope: "EVENT",
  },
  {
    parameterName: "radio_module",
    displayName: "Radio driver module",
    description: "CHIRP driver module backing the selected radio.",
    scope: "EVENT",
  },
  {
    parameterName: "radio_class",
    displayName: "Radio driver class",
    description: "CHIRP driver class backing the selected radio.",
    scope: "EVENT",
  },
  {
    parameterName: "method",
    displayName: "Selection method",
    description: "How a radio came to be selected: search, dropdown, a restored cookie, a per-model page link, or detection from a loaded image.",
    scope: "EVENT",
  },
  {
    parameterName: "duration_ms",
    displayName: "Duration ms",
    description: "How long the reported operation took, in milliseconds.",
    scope: "EVENT",
  },
  {
    parameterName: "stage",
    displayName: "Clone stage",
    description: "Where a clone failed: preflight validation or the transfer itself.",
    scope: "EVENT",
  },
  {
    parameterName: "error_kind",
    displayName: "Error kind",
    description: "Failure cause mapped onto a fixed vocabulary — timeout, no_response, ident_mismatch, checksum and the like.",
    scope: "EVENT",
  },
  {
    parameterName: "error_type",
    displayName: "Error type",
    description: "Exception type behind a failure, so an unanticipated one still reports as e.g. RadioError rather than other.",
    scope: "EVENT",
  },
  {
    parameterName: "catalog_source",
    displayName: "Catalog source",
    description: "Which path filled the radio dropdowns: the prebuilt static catalog, or a full driver import in Pyodide.",
    scope: "EVENT",
  },
  {
    parameterName: "transport",
    displayName: "Serial transport",
    description: "Transport a serial connection actually opened over.",
    scope: "EVENT",
  },
  {
    parameterName: "channel_count",
    displayName: "Channel count",
    description: "Number of channels involved in the reported operation.",
    scope: "EVENT",
  },
  {
    parameterName: "channel_count_bucket",
    displayName: "Channel count bucket",
    description: "Codeplug size as a range (0, 1-16, 17-128, 129-512, 512+) so reports can group by it.",
    scope: "EVENT",
  },
  {
    parameterName: "codeplug_source",
    displayName: "Codeplug source",
    description: "Where the channels in the editor came from: a radio, a CSV, an .img, or mixed once an import was merged in.",
    scope: "EVENT",
  },
  {
    parameterName: "format",
    displayName: "File format",
    description: "File format of an import or export: csv or img.",
    scope: "EVENT",
  },
  {
    parameterName: "import_source",
    displayName: "Import source",
    description: "How a file reached the app: the import button or a drag-and-drop.",
    scope: "EVENT",
  },
  {
    parameterName: "import_mode",
    displayName: "Import mode",
    description: "What the user did with the replace-or-merge prompt: replace, merge or cancelled.",
    scope: "EVENT",
  },
  {
    parameterName: "outcome",
    displayName: "Outcome",
    description: "Whether the reported step succeeded or failed.",
    scope: "EVENT",
  },
  {
    parameterName: "repeater_source",
    displayName: "Repeater source",
    description: "Which repeater directory a query ran against: przemienniki.net, RepeaterBook, IRTS or RSGB ETCC.",
    scope: "EVENT",
  },
  {
    parameterName: "result_count",
    displayName: "Result count",
    description: "How many repeaters a query returned; zero means the filters or the proxy are wrong.",
    scope: "EVENT",
  },
  {
    parameterName: "country",
    displayName: "Repeater country",
    description: "Country filter a repeater query ran with.",
    scope: "EVENT",
  },
  {
    parameterName: "located",
    displayName: "Query located",
    description: "Whether a repeater query carried a position rather than searching blind.",
    scope: "EVENT",
  },
  {
    parameterName: "preset",
    displayName: "Preset",
    description: "Which band-plan preset a block of channels was inserted from.",
    scope: "EVENT",
  },
  {
    parameterName: "first_column",
    displayName: "First blocked column",
    description: "Channel column of the first issue that blocked an upload; the rejected value itself is never sent.",
    scope: "EVENT",
  },
  {
    parameterName: "issue_count",
    displayName: "Preflight issue count",
    description: "How many values CHIRP's own preflight rejected before an upload.",
    scope: "EVENT",
  },
  {
    parameterName: "field_count",
    displayName: "Field count",
    description: "How many channel attributes one bulk edit wrote to every selected channel.",
    scope: "EVENT",
  },
  {
    parameterName: "tab",
    displayName: "Settings tab",
    description: "CHIRP settings group opened in the radio settings editor.",
    scope: "EVENT",
  },
  {
    parameterName: "served_from",
    displayName: "Offline served from",
    description: "How the service worker answered counted app launches: cache (network failed) or cache_after_timeout (network too slow).",
    scope: "EVENT",
  },
  {
    parameterName: "launch_count",
    displayName: "Offline launch count",
    description: "App launches answered from the offline cache since the last report.",
    scope: "EVENT",
  },
  {
    parameterName: "delivery",
    displayName: "Delivery",
    description: "offline_replay for an event recorded on a page served from the offline cache and sent later; unset when sent live.",
    scope: "EVENT",
  },
  {
    parameterName: "event_count",
    displayName: "Replayed event count",
    description: "Offline events an offline_replay sent from the replay queue.",
    scope: "EVENT",
  },
  {
    parameterName: "dropped_count",
    displayName: "Dropped event count",
    description: "Offline events an offline_replay lost because the replay queue was full (REPLAY_LIMIT in web/js/analytics.ts).",
    scope: "EVENT",
  },
  {
    parameterName: "launch_count_bucket",
    displayName: "Offline launch count bucket",
    description: "Offline launches since the last report as a range (1, 2-5, 6-20, 21+) so reports can group by it.",
    scope: "EVENT",
  },
].map((dimension) => Object.freeze(dimension)));

// Display modes reported through the display-mode media feature, most app-like
// first: a window-controls-overlay window also matches standalone, so the first
// match has to win.
const DISPLAY_MODES = ["window-controls-overlay", "fullscreen", "standalone", "minimal-ui"];

// The window analytics was initialised against. Kept so trackEvent() callers
// elsewhere in the app do not have to thread a window through, and so tests can
// drive the module against a fake one.
let target: Window | null = typeof window === "undefined" ? null : window;

export function detectDisplayMode(win: Window | null | undefined): string {
  // iOS Safari never matches the display-mode query for home-screen launches
  // and reports navigator.standalone instead.
  if (win?.navigator?.standalone === true) {
    return "standalone";
  }
  if (typeof win?.matchMedia !== "function") {
    return "browser";
  }
  for (const mode of DISPLAY_MODES) {
    if (win.matchMedia(`(display-mode: ${mode})`)?.matches) {
      return mode;
    }
  }
  return "browser";
}

// Whether this copy of the app is the one allowed to report. Reads the live
// location every time rather than caching, so a test can drive the module
// against a fake window.
export function isAnalyticsHost(win: Window | null | undefined): boolean {
  return ANALYTICS_HOSTS.includes(String(win?.location?.hostname || ""));
}

// Send a GA4 event. Returns false when no analytics is loaded — an ad blocker,
// a copy of the app off the production host, or a test — so callers never have
// to guard. display_mode is stamped on here rather than globally because
// gtag("set") does not carry custom parameters onto events (see FINDINGS); an
// explicit value in params still wins.
//
// A throwing gtag is swallowed: content blockers commonly replace it with a
// stub that throws, and telemetry must never be able to fail the clone it is
// reporting on.
//
// On a page diverted by deferAnalytics() the event is queued for replay
// instead, and false says it was not sent. Before the visitor has answered
// the consent banner it waits in memory, and false says the same; a decline
// drops it, and every event after it, without a trace.
export function trackEvent(name: string, params: Record<string, unknown> = {}, win: Window | null = target): boolean {
  if (!win) {
    return false;
  }
  const event = { name: String(name), params: { display_mode: detectDisplayMode(win), ...params } };
  const consent = consentStates.get(win);
  if (consent && consent.choice !== "granted") {
    if (consent.choice === null) {
      holdForConsent(consent, event);
    }
    return false;
  }
  return deliverEvent(win, event);
}

// Hand one event to gtag, or to the replay queue on a deferred page. The part
// of trackEvent() past the consent gate, shared with the release of the
// events that waited for an Accept.
function deliverEvent(win: Window, event: QueuedEvent): boolean {
  const gtag = win.gtag;
  if (typeof gtag !== "function") {
    return false;
  }
  if (deferredWindows.has(win)) {
    enqueueReplay(win, [event]);
    return false;
  }
  try {
    gtag("event", event.name, event.params);
  } catch {
    return false;
  }
  return true;
}

// --- Consent -----------------------------------------------------------------
//
// Basic consent mode: on the production host nothing is requested from Google
// and no GA cookie is set until the visitor presses Accept on the banner
// (web/js/consent-banner.ts). Accept defines gtag, sets the Consent Mode v2
// defaults to denied, grants analytics_storage alone, and only then loads
// gtag.js and configs the property. Decline loads nothing; one made after an
// Accept on the same page switches the loaded tag off, withdraws the grant
// and deletes the GA cookies. The choice is kept on the device under
// CONSENT_KEY; "Cookie settings" in each page's footer reopens the banner.
//
// The banner asks everyone, not only EEA and UK visitors: GitHub Pages runs
// no server code, so the page has no reliable way to know where a visitor is.
//
// Events tracked before an answer wait in memory, never in storage -- writing
// them to the device is itself what needs the consent. An Accept sends them,
// a Decline drops them, and leaving the page loses them.

export const CONSENT_KEY = "webchirp-analytics-consent";

// Every Consent Mode v2 type starts denied; an Accept grants analytics_storage
// and nothing else, so the ad types stay denied for good.
export const CONSENT_DEFAULTS = Object.freeze({
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
});

// gtag.js's own off switch for one measurement ID: set to true, the loaded
// tag sends nothing more for it.
const GA_DISABLE_PROPERTY = `ga-disable-${MEASUREMENT_ID}` as const;

/** One page's consent: the answer in force and what waits for one. */
interface ConsentState {
  /** The visitor's answer, or null while the banner is unanswered. */
  choice: ConsentChoice | null;
  /** Events tracked before an answer, oldest first. */
  pending: QueuedEvent[];
  /** Whether this page has defined gtag, configured it and requested gtag.js. */
  started: boolean;
}

// The consent of each window initAnalytics() ran on. A window it never ran
// on (a test's bare object) has none, and trackEvent() treats it as before
// consent existed: whatever gtag it carries is used.
const consentStates = new WeakMap<object, ConsentState>();

// The stored answer, or null when there is none or storage cannot be read.
export function readConsentChoice(win: Window | null | undefined): ConsentChoice | null {
  const storage = win ? analyticsStorage(win) : null;
  try {
    const value = storage?.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

// Keep the answer on the device. Without storage it holds for this page only,
// and the banner asks again on the next.
function writeConsentChoice(win: Window, choice: ConsentChoice): void {
  try {
    analyticsStorage(win)?.setItem(CONSENT_KEY, choice);
  } catch {
    // Storage full or blocked: the answer still applies to this page.
  }
}

// Keep an event until the visitor answers, the newest REPLAY_LIMIT of them:
// a page left open with the banner unanswered must not grow without bound.
function holdForConsent(consent: ConsentState, event: QueuedEvent): void {
  consent.pending.push(event);
  if (consent.pending.length > REPLAY_LIMIT) {
    consent.pending.splice(0, consent.pending.length - REPLAY_LIMIT);
  }
}

// Record the visitor's answer for this page and the ones after it, and act on
// it: Accept starts analytics and sends what waited, Decline drops it and
// stops analytics. Called by the banner's buttons; exported for the tests.
// Does nothing on a window initAnalytics() did not run on.
export function setAnalyticsConsent(choice: ConsentChoice, win: Window | null = target): void {
  const consent = win ? consentStates.get(win) : undefined;
  if (!win || !consent) {
    return;
  }
  consent.choice = choice;
  writeConsentChoice(win, choice);
  hideConsentBanner(win.document);
  if (choice === "granted") {
    startAnalytics(win, consent);
    for (const event of consent.pending.splice(0)) {
      deliverEvent(win, event);
    }
  } else {
    consent.pending.length = 0;
    stopAnalytics(win, consent);
  }
}

// Show the banner for this page's window, saying what is in force if anything.
function askForConsent(win: Window, consent: ConsentState): void {
  showConsentBanner(win.document, consent.choice, (choice) => setAnalyticsConsent(choice, win));
}

// Reveal the page's Cookie settings controls and have them reopen the banner.
// They ship hidden, so off the production host, where this never runs, there
// is nothing to click.
function bindConsentSettings(win: Window, consent: ConsentState): void {
  const doc = win.document;
  if (typeof doc?.querySelectorAll !== "function") {
    return;
  }
  for (const control of doc.querySelectorAll<HTMLElement>(CONSENT_SETTINGS_SELECTOR)) {
    control.hidden = false;
    control.addEventListener("click", (event) => {
      event.preventDefault();
      askForConsent(win, consent);
    });
  }
}

// Define gtag, set the consent defaults and the grant, load the vendor tag,
// then config with the launch context attached. gtag.js reads whatever is
// already in dataLayer when it arrives, so the ordering between the injection
// and the commands below does not matter; the order of the commands does: the
// consent commands come first, so the config's page_view goes out granted.
// A second Accept on the same page (after a Decline from Cookie settings)
// only switches the loaded tag back on.
//
// display_mode goes in the config call, NOT in a preceding gtag("set"): "set"
// reads like it sets a global parameter for later hits, but GA4 does not carry
// custom parameters from it onto events, so the parameter silently never
// reaches the collect payload. Config parameters do ride along with the
// automatic page_view.
function startAnalytics(win: Window, consent: ConsentState): void {
  if (consent.started) {
    if (win[GA_DISABLE_PROPERTY]) {
      win[GA_DISABLE_PROPERTY] = false;
    }
    win.gtag?.("consent", "update", { analytics_storage: "granted" });
    return;
  }
  consent.started = true;
  const dataLayer = win.dataLayer || [];
  win.dataLayer = dataLayer;
  if (typeof win.gtag !== "function") {
    // Mirrors the vendor snippet: gtag.js reads the pushed arguments objects,
    // so this pushes arguments rather than an array.
    win.gtag = function gtag() {
      dataLayer.push(arguments);
    };
  }
  win.gtag("consent", "default", { ...CONSENT_DEFAULTS });
  win.gtag("consent", "update", { analytics_storage: "granted" });
  loadGtagScript(win);
  win.gtag("js", new Date());
  win.gtag("config", MEASUREMENT_ID, { display_mode: detectDisplayMode(win) });
}

// Undo what an Accept did: the replay queue goes, a tag loaded on this page
// is switched off and its grant withdrawn, and the GA cookies are deleted.
// Never throws: a blocker's throwing gtag must not keep the banner up.
function stopAnalytics(win: Window, consent: ConsentState): void {
  try {
    analyticsStorage(win)?.removeItem(REPLAY_KEY);
  } catch {
    // Blocked storage holds no queue to remove.
  }
  if (consent.started) {
    win[GA_DISABLE_PROPERTY] = true;
    try {
      win.gtag?.("consent", "update", { analytics_storage: "denied" });
    } catch {
      // The off switch above already stops the tag.
    }
  }
  deleteAnalyticsCookies(win);
}

// Delete the cookies GA4 sets: _ga, and _ga_<container> per property. GA puts
// them on the registrable domain (domain=webchirp.org), so each is expired
// with that domain and without one, whichever it was written with.
function deleteAnalyticsCookies(win: Window): void {
  const doc = win.document;
  let names: string[];
  try {
    names = String(doc?.cookie || "").split(";").map((pair) => pair.split("=")[0].trim());
  } catch {
    return;
  }
  const hostname = String(win.location?.hostname || "");
  for (const name of names.filter((cookie) => cookie === "_ga" || cookie.startsWith("_ga_"))) {
    for (const domain of ["", `; domain=${hostname}`]) {
      try {
        doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
      } catch {
        // A document that will not take cookies has none to delete.
      }
    }
  }
}

// --- Offline replay ----------------------------------------------------------
//
// A page the service worker answered from its cache because the network
// failed (web/js/offline.ts) has no way to report: gtag.js never loads, and
// the stub's dataLayer dies with the page. deferAnalytics() diverts such a
// page's events into localStorage, and replayDeferredAnalytics() sends them,
// marked delivery: "offline_replay", from the next page the network serves.
// GA stamps them with the time of the replay, not the time they happened, and
// counts them in the replaying session.
//
// The queue keeps the newest REPLAY_LIMIT events. A typical offline session --
// select a radio, connect, download, edit, upload -- records 10 to 25, so the
// limit covers a dozen or more sessions between online visits; when it does
// not, the offline_replay summary's dropped_count says by how much.

export const REPLAY_LIMIT = 300;
const REPLAY_KEY = "webchirp-analytics-replay";

/** One event waiting to be replayed: its name and the params trackEvent built. */
interface QueuedEvent {
  name: string;
  params: Record<string, unknown>;
}

/** The replay queue as stored. */
interface ReplayQueue {
  events: QueuedEvent[];
  /** Events discarded because the queue was full. */
  dropped: number;
}

// The windows whose events are being queued; per window so a test's fake
// window and the real one cannot leak into each other.
const deferredWindows = new WeakSet<object>();

// The window's localStorage, which holds the replay queue and the consent
// answer, or null where it is missing, not a real Storage, or throws to read
// (blocked site data, some private modes).
function analyticsStorage(win: Window): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    const storage = win.localStorage;
    return typeof storage?.getItem === "function" && typeof storage.setItem === "function"
      && typeof storage.removeItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

// The stored queue, keeping only well-formed entries: it is JSON this module
// wrote, but storage outlives code versions and can be edited by hand.
function readReplayQueue(storage: Pick<Storage, "getItem">): ReplayQueue {
  try {
    const parsed = JSON.parse(storage.getItem(REPLAY_KEY) || "null") as Partial<ReplayQueue> | null;
    const events = (Array.isArray(parsed?.events) ? parsed.events : []).filter(
      (event): event is QueuedEvent => typeof event?.name === "string"
        && Boolean(event.params) && typeof event.params === "object",
    );
    const dropped = Number.isInteger(parsed?.dropped) ? Number(parsed?.dropped) : 0;
    return { events, dropped };
  } catch {
    return { events: [], dropped: 0 };
  }
}

// Append to the queue, dropping the oldest past REPLAY_LIMIT and counting them.
function enqueueReplay(win: Window, events: QueuedEvent[]): void {
  const storage = analyticsStorage(win);
  if (!storage || events.length === 0) {
    return;
  }
  const queue = readReplayQueue(storage);
  queue.events.push(...events);
  const overflow = queue.events.length - REPLAY_LIMIT;
  if (overflow > 0) {
    queue.events.splice(0, overflow);
    queue.dropped += overflow;
  }
  try {
    storage.setItem(REPLAY_KEY, JSON.stringify(queue));
  } catch {
    // Storage full or blocked: these events are lost, as they were before.
  }
}

// Queue this page's events for a later page instead of sending them, from now
// on and retroactively: what was tracked before the page learned it was
// offline sits in dataLayer as gtag("event", ...) argument lists, and is moved
// out, so gtag.js cannot send it a second time should it load after all.
// Returns whether the page is now deferred; analytics off the production host,
// or no storage, leaves it as it was.
//
// Consent comes first: after a Decline there is nothing to queue, and before
// an answer the page is marked deferred but its held events stay in memory,
// reaching the queue only through an Accept on this page.
export function deferAnalytics(win: Window | null = target): boolean {
  const consent = win ? consentStates.get(win) : undefined;
  if (!win || consent?.choice === "denied" || !analyticsStorage(win)) {
    return false;
  }
  if (deferredWindows.has(win)) {
    return true;
  }
  if (consent?.choice === null) {
    deferredWindows.add(win);
    return true;
  }
  if (typeof win.gtag !== "function") {
    return false;
  }
  deferredWindows.add(win);
  const layer = win.dataLayer || [];
  const moved: QueuedEvent[] = [];
  for (let i = 0; i < layer.length;) {
    // dataLayer holds the arguments objects the gtag stub pushed.
    const entry = layer[i] as ArrayLike<unknown> | null;
    if (entry?.[0] === "event" && typeof entry[1] === "string") {
      const params = entry[2] && typeof entry[2] === "object" ? entry[2] as Record<string, unknown> : {};
      moved.push({ name: entry[1], params: { ...params } });
      layer.splice(i, 1);
    } else {
      i += 1;
    }
  }
  enqueueReplay(win, moved);
  return true;
}

// Send what offline pages queued, oldest first, then one offline_replay
// summary. The queue is cleared before anything is sent, so a second tab the
// network served at the same moment finds it empty rather than sending it
// again. Returns how many events were replayed. Only with consent granted:
// before an answer the queue waits for a later page, and a Decline deletes it.
export function replayDeferredAnalytics(win: Window | null = target): number {
  const consent = win ? consentStates.get(win) : undefined;
  if (!win || (consent && consent.choice !== "granted")
    || typeof win.gtag !== "function" || deferredWindows.has(win)) {
    return 0;
  }
  const storage = analyticsStorage(win);
  if (!storage) {
    return 0;
  }
  const queue = readReplayQueue(storage);
  if (queue.events.length === 0 && queue.dropped === 0) {
    return 0;
  }
  try {
    storage.removeItem(REPLAY_KEY);
  } catch {
    return 0;
  }
  for (const event of queue.events) {
    trackEvent(event.name, { ...event.params, delivery: "offline_replay" }, win);
  }
  trackEvent("offline_replay", { event_count: queue.events.length, dropped_count: queue.dropped }, win);
  return queue.events.length;
}

// The install funnel. Without these, installs are invisible in GA: the browser
// mints the WebAPK on its own and never navigates anywhere we could measure.
export function bindInstallTracking(win: Window | null = target) {
  if (typeof win?.addEventListener !== "function") {
    return;
  }

  win.addEventListener("beforeinstallprompt", (event) => {
    // Deliberately not preventDefault()ed here: this is the measurement side
    // and it runs on both pages, while only index.html has a button to replace
    // what cancelling would suppress. Cancelling is that page's own decision,
    // taken in web/js/install-prompt.ts, and preventDefault() from a second
    // listener is honoured whichever runs first — so this event means "an
    // install became available", not "the browser showed something".
    trackEvent("pwa_install_prompt", {}, win);
    // userChoice settles once the user answers a prompt that was actually
    // raised — by the browser on about.html, by the toolbar button on
    // index.html. It stays pending forever if none ever is, which costs
    // nothing.
    const choice = event?.userChoice;
    if (typeof choice?.then !== "function") {
      return;
    }
    choice.then(
      (result) => {
        trackEvent("pwa_install_choice", {
          install_outcome: String(result?.outcome || "unknown"),
        }, win);
      },
      () => {},
    );
  });

  win.addEventListener("appinstalled", () => {
    trackEvent("pwa_installed", {}, win);
  });
}

// Request the vendor tag. The pages carry no static loader, so this is the only
// place gtag.js is ever asked for, and it is reached only past the host gate
// and an Accept.
function loadGtagScript(win: Window): void {
  const doc = win?.document;
  if (typeof doc?.createElement !== "function") {
    return;
  }
  const script = doc.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  (doc.head || doc.documentElement)?.appendChild(script);
}

// Wire analytics into the page, on the production host only: the install
// funnel, the Cookie settings controls, and then whatever the visitor's stored
// answer allows -- analytics started at once after an Accept, nothing after a
// Decline, and the banner when there is no answer yet. A second call on the
// same window starts it over as a new page. Returns gtag once it is defined,
// otherwise null.
export function initAnalytics(win: Window | null | undefined) {
  if (!win || !isAnalyticsHost(win)) {
    return null;
  }
  target = win;
  const consent: ConsentState = { choice: readConsentChoice(win), pending: [], started: false };
  consentStates.set(win, consent);
  deferredWindows.delete(win);
  bindInstallTracking(win);
  bindConsentSettings(win, consent);
  if (consent.choice === "granted") {
    startAnalytics(win, consent);
  } else if (consent.choice === null) {
    askForConsent(win, consent);
  }
  return win.gtag || null;
}

if (typeof window !== "undefined") {
  initAnalytics(window);
}

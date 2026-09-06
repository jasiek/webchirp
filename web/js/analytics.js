// Google Analytics wiring, shared by index.html and about.html.
//
// Everything with logic in it lives here so the two pages cannot drift: the
// production-host gate, the gtag.js loader this module injects, the launch
// context, the install funnel, and the trackEvent() the rest of the app sends
// through. Loaded with type="module", so it runs after the document is parsed.
//
// Home-screen launches are the reason the display-mode plumbing exists: a
// WebAPK sends no referrer, so without a marker its traffic is indistinguishable
// from direct browser traffic. The manifest's start_url carries utm params for
// session attribution; display_mode below covers every hit including ones that
// navigate away from start_url.

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
// www sits beside the apex because CNAME points at the apex and a www visitor
// who was not redirected is real traffic. Forks are unaffected either way,
// being on github.io or a domain of their own.
export const ANALYTICS_HOSTS = Object.freeze(["codeplug.org", "www.codeplug.org"]);

// Every event parameter this app sends, declared once here so the GA property
// can be brought in line with the code rather than the other way round — see
// `npm run ga:dimensions`. GA4 drops unregistered parameters from reports
// silently and never backfills them, so a parameter added in code but not here
// collects nothing until someone notices.
//
// parameterName and scope are immutable in the API: changing either means a new
// dimension and a new, empty history. displayName and description are patchable.
export const CUSTOM_DIMENSIONS = Object.freeze([
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
    description: "How a radio came to be selected: the model dropdown, the search box, or detection from a loaded image.",
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
    parameterName: "tab",
    displayName: "Settings tab",
    description: "CHIRP settings group opened in the radio settings editor.",
    scope: "EVENT",
  },
].map(Object.freeze));

// Display modes reported through the display-mode media feature, most app-like
// first: a window-controls-overlay window also matches standalone, so the first
// match has to win.
const DISPLAY_MODES = ["window-controls-overlay", "fullscreen", "standalone", "minimal-ui"];

// The window analytics was initialised against. Kept so trackEvent() callers
// elsewhere in the app do not have to thread a window through, and so tests can
// drive the module against a fake one.
let target = typeof window === "undefined" ? null : window;

export function detectDisplayMode(win) {
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
export function isAnalyticsHost(win) {
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
export function trackEvent(name, params = {}, win = target) {
  const gtag = win?.gtag;
  if (typeof gtag !== "function") {
    return false;
  }
  try {
    gtag("event", String(name), { display_mode: detectDisplayMode(win), ...params });
  } catch {
    return false;
  }
  return true;
}

// The install funnel. Without these, installs are invisible in GA: the browser
// mints the WebAPK on its own and never navigates anywhere we could measure.
export function bindInstallTracking(win = target) {
  if (typeof win?.addEventListener !== "function") {
    return;
  }

  win.addEventListener("beforeinstallprompt", (event) => {
    // Deliberately not preventDefault()ed — that suppresses the browser's own
    // install prompt, and this app has no custom install button to replace it.
    trackEvent("pwa_install_prompt", {}, win);
    // userChoice settles once the user answers the browser-shown prompt. It can
    // stay pending forever if they never do, which costs nothing.
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
// place gtag.js is ever asked for, and it is reached only past the host gate.
function loadGtagScript(win) {
  const doc = win?.document;
  if (typeof doc?.createElement !== "function") {
    return;
  }
  const script = doc.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  (doc.head || doc.documentElement)?.appendChild(script);
}

// Define gtag, load the vendor tag, then config with the launch context
// attached. gtag.js reads whatever is already in dataLayer when it arrives, so
// the ordering between the injection and the commands below does not matter.
//
// display_mode goes in the config call, NOT in a preceding gtag("set"): "set"
// reads like it sets a global parameter for later hits, but GA4 does not carry
// custom parameters from it onto events, so the parameter silently never
// reaches the collect payload. Config parameters do ride along with the
// automatic page_view.
export function initAnalytics(win) {
  if (!win || !isAnalyticsHost(win)) {
    return null;
  }
  target = win;
  const dataLayer = win.dataLayer || [];
  win.dataLayer = dataLayer;
  if (typeof win.gtag !== "function") {
    // Mirrors the vendor snippet: gtag.js reads the pushed arguments objects,
    // so this pushes arguments rather than an array.
    win.gtag = function gtag() {
      dataLayer.push(arguments);
    };
  }
  loadGtagScript(win);
  win.gtag("js", new Date());
  win.gtag("config", MEASUREMENT_ID, { display_mode: detectDisplayMode(win) });
  bindInstallTracking(win);
  return win.gtag;
}

if (typeof window !== "undefined") {
  initAnalytics(window);
}

// Google Analytics wiring, shared by index.html and about.html.
//
// The gtag.js loader tag stays in each page's <head> so the vendor script
// starts downloading during parse; everything with logic in it lives here so
// the two pages cannot drift. This module is loaded with type="module" and so
// runs after the document is parsed — gtag.js reads whatever is already in
// dataLayer when it arrives, so nothing is lost either side of that.
//
// Home-screen launches are the reason the display-mode plumbing exists: a
// WebAPK sends no referrer, so without a marker its traffic is indistinguishable
// from direct browser traffic. The manifest's start_url carries utm params for
// session attribution; display_mode below covers every hit including ones that
// navigate away from start_url.

export const MEASUREMENT_ID = "G-80DP6MQ180";

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
    parameterName: "radio_make",
    displayName: "Radio make",
    description: "Vendor of the radio a clone operation ran against.",
    scope: "EVENT",
  },
  {
    parameterName: "radio_model",
    displayName: "Radio model",
    description: "Model of the radio a clone operation ran against.",
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

// Send a GA4 event. Returns false when no analytics is loaded — an ad blocker,
// a fork with the snippet removed, or a test — so callers never have to guard.
// display_mode is stamped on here rather than globally because gtag("set") does
// not carry custom parameters onto events (see FINDINGS); an explicit value in
// params still wins.
export function trackEvent(name, params = {}, win = target) {
  const gtag = win?.gtag;
  if (typeof gtag !== "function") {
    return false;
  }
  gtag("event", name, { display_mode: detectDisplayMode(win), ...params });
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

// Define gtag, then config with the launch context attached.
//
// display_mode goes in the config call, NOT in a preceding gtag("set"): "set"
// reads like it sets a global parameter for later hits, but GA4 does not carry
// custom parameters from it onto events, so the parameter silently never
// reaches the collect payload. Config parameters do ride along with the
// automatic page_view.
export function initAnalytics(win) {
  if (!win) {
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
  win.gtag("js", new Date());
  win.gtag("config", MEASUREMENT_ID, { display_mode: detectDisplayMode(win) });
  bindInstallTracking(win);
  return win.gtag;
}

if (typeof window !== "undefined") {
  initAnalytics(window);
}

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
export function trackEvent(name, params = {}, win = target) {
  const gtag = win?.gtag;
  if (typeof gtag !== "function") {
    return false;
  }
  gtag("event", name, params);
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
    trackEvent("pwa_install_prompt", { display_mode: detectDisplayMode(win) }, win);
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
    trackEvent("pwa_installed", { display_mode: detectDisplayMode(win) }, win);
  });
}

// Define gtag, stamp the launch context onto every subsequent hit, then config.
// Order matters: gtag("set") only applies to hits sent after it, and the
// automatic page_view is sent by config.
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
  win.gtag("set", { display_mode: detectDisplayMode(win) });
  win.gtag("config", MEASUREMENT_ID);
  bindInstallTracking(win);
  return win.gtag;
}

if (typeof window !== "undefined") {
  initAnalytics(window);
}

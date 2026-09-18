// Ownership of the browser's deferred install prompt.
//
// Chrome fires beforeinstallprompt once this app meets the install criteria and
// then offers an install of its own -- on Android an ambient badge governed by
// engagement heuristics and suppressed for months after one dismissal, and
// otherwise the "Add to Home screen" item buried in the browser menu. Almost
// nobody finds either, so installs here are limited by discovery rather than by
// eligibility. Cancelling the event parks it in this module instead, where the
// toolbar button in web/js/ui/install-button.js can raise it on a tap.
//
// Cancelling is only safe where a replacement affordance exists, so this module
// is loaded by index.html alone: about.html keeps the browser's own prompt.
//
// Measurement stays in web/js/analytics.js, whose bindInstallTracking() listens
// for the same event without cancelling it. Two listeners on one event is
// deliberate -- one page may cancel and one may not, while both report the same
// funnel -- and preventDefault() from either is honoured regardless of order.
//
// Loaded early, from the document head, because the event can fire before the
// UI controller is constructed: the app boots behind a serial capability check,
// and a listener registered after the event has already fired never sees it.

// The window this module was bound against, so callers elsewhere do not thread
// one through and a test can drive the module against a fake.
let target = typeof window === "undefined" ? null : window;

// The cancelled beforeinstallprompt event, held until something raises it.
// Null whenever no install can be offered right now: before the browser offers
// one, after the prompt has been used (an event may be raised only once), and
// after the app has been installed.
let deferredPrompt = null;

const availabilityListeners = new Set();

// Tell every subscriber what the current availability is. A throwing subscriber
// is swallowed so one broken listener cannot strand the others -- this runs on
// a browser event with no call site to report a failure back to.
function notifyAvailability() {
  const available = deferredPrompt !== null;
  for (const listener of [...availabilityListeners]) {
    try {
      listener(available);
    } catch {
      /* ignored */
    }
  }
}

// Whether an install can be raised right now. False in every browser that never
// fires the event at all (every one on iOS, Firefox), and in a window that is
// already running installed -- so a caller needs no platform check of its own.
export function isInstallAvailable() {
  return deferredPrompt !== null;
}

// Subscribe to availability changes; returns an unsubscribe. The listener is
// not called on subscription: a subscriber that binds after the event has
// already fired reads isInstallAvailable() once itself, which keeps this free
// of assumptions about when it is called.
export function onInstallAvailabilityChange(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

// Raise the parked prompt and report how the user answered: accepted,
// dismissed, unavailable when nothing was parked, or failed when the browser
// rejected the call. Callers get an outcome rather than a rejection because
// there is nothing for them to handle -- every failure here means the same
// thing to the UI, which is that the button is finished.
export async function promptInstall() {
  const event = deferredPrompt;
  if (!event || typeof event.prompt !== "function") {
    return "unavailable";
  }
  // Dropped before prompting rather than after. The event may be raised only
  // once, so a second tap while the first prompt is still open would be
  // rejected by the browser and leave the button looking broken.
  deferredPrompt = null;
  notifyAvailability();
  try {
    await event.prompt();
    const result = await event.userChoice;
    return String(result?.outcome || "unknown");
  } catch {
    return "failed";
  }
}

// Start listening. Exported and state-resetting so a test can rebind against a
// fresh fake window without a previous test's parked event leaking into it.
export function bindInstallPrompt(win = target) {
  deferredPrompt = null;
  if (typeof win?.addEventListener !== "function") {
    notifyAvailability();
    return;
  }
  target = win;

  win.addEventListener("beforeinstallprompt", (event) => {
    // Nothing is parked unless the browser's own prompt was actually
    // suppressed: a shape we cannot cancel would otherwise leave the user with
    // neither the browser's affordance nor a working one of ours.
    if (typeof event?.preventDefault !== "function") {
      return;
    }
    event.preventDefault();
    deferredPrompt = event;
    notifyAvailability();
  });

  // The install can also happen through the browser's own menu, or from
  // another tab on this origin, and the button has to stand down when it does.
  win.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyAvailability();
  });

  notifyAvailability();
}

if (typeof window !== "undefined") {
  bindInstallPrompt(window);
}

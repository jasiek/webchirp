import {
  isInstallAvailable,
  onInstallAvailabilityChange,
  promptInstall,
} from "../install-prompt.js";
import { trackEvent } from "./analytics.js";

// The toolbar's Install button: this app's own install affordance, standing in
// for the browser one that web/js/install-prompt.js suppresses. See that module
// for why -- in short, Chrome's Android install badge is throttled to the point
// of invisibility, so the install has to be offered somewhere a user looks.
//
// The button is hidden rather than disabled while no install can be raised,
// which is most of the time: already installed, a browser that never offers one
// (every browser on iOS, Firefox), or a visit the browser has not yet judged
// installable. A permanently dead control in the toolbar would say the app
// cannot be installed here, which is usually the opposite of the truth.
export function createInstallButton(ctx) {
  const { dom, log } = ctx;

  // Mirror the parked prompt into the button's visibility. Called on every
  // availability change and once at bind time, because the event may well have
  // fired before this module existed.
  function refresh() {
    dom.installAppEl.hidden = !isInstallAvailable();
  }

  // Raise the prompt and report the tap. Only the tap is reported here: the
  // answer arrives separately as pwa_install_choice from web/js/analytics.js,
  // which watches the same event whether or not this button raised it, and the
  // two together are this button's conversion rate. The outcome still reaches
  // the debug panel, where it is the only sign the tap did anything at all when
  // the user declines.
  async function install() {
    trackEvent("pwa_install_clicked");
    const outcome = await promptInstall();
    log.logDebug(`INSTALL PROMPT ${outcome}`);
  }

  function bindEvents() {
    onInstallAvailabilityChange(refresh);
    refresh();
    // The handler returns the promise rather than discarding it. A browser
    // ignores a listener's return value, but it is what lets a test await the
    // whole tap -- prompt raised, outcome resolved, button retired -- instead
    // of guessing how many microtasks that takes.
    dom.installAppEl.addEventListener("click", () => install());
  }

  return { bindEvents, refresh };
}

import test from "node:test";
import assert from "node:assert/strict";

import { initAnalytics } from "../../web/js/analytics.js";
import { bindInstallPrompt } from "../../web/js/install-prompt.js";
import { createInstallButton } from "../../web/js/ui/install-button.js";
import { FakeElement } from "../support/fake-dom.mjs";
import { makeWindow } from "../support/fake-window.mjs";

// The button's whole job is to be visible at the right moments: an install
// offer nobody can see is exactly the state this feature exists to fix, and a
// button left showing after the prompt is spent is one that does nothing when
// tapped. Neither shows up in a page load — beforeinstallprompt fires only on a
// device the app is installable on — so it is pinned here.

// The two members web/js/ui/install-button.js reads off ctx. A full UI harness
// would only add the rest of the app to a module that touches one element.
function makeContext() {
  const installAppEl = new FakeElement("button", null, "install-app");
  installAppEl.hidden = true;
  const debug = [];
  return {
    installAppEl,
    debug,
    ctx: {
      dom: { installAppEl },
      log: {
        logDebug: (line) => debug.push(line),
        logError: (line) => debug.push(line),
      },
    },
  };
}

function trackedEvents(win, name) {
  return (win.dataLayer || [])
    .map((entry) => Array.from(entry))
    .filter((call) => call[0] === "event" && call[1] === name);
}

function fakePromptEvent(outcome = "accepted") {
  return {
    preventDefault() {},
    async prompt() {},
    userChoice: Promise.resolve({ outcome }),
  };
}

test("the button stays hidden where no install is on offer", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  const { installAppEl, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();

  // Every browser on iOS, and Firefox everywhere, never fires the event. A
  // control that is permanently present and dead would say this app cannot be
  // installed here, which is not what it means.
  assert.equal(installAppEl.hidden, true);
});

test("the button appears once the browser parks an install", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  const { installAppEl, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();

  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(installAppEl.hidden, false);
});

test("an install offered before the UI booted is still shown", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  // The app boots behind a serial capability check, so the event routinely
  // beats the UI. A module that only listened for changes would miss it.
  win.dispatch("beforeinstallprompt", fakePromptEvent());

  const { installAppEl, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();
  assert.equal(installAppEl.hidden, false);
});

test("a tap raises the prompt, reports the click and retires the button", async () => {
  const win = makeWindow();
  initAnalytics(win);
  bindInstallPrompt(win);
  const { installAppEl, debug, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();
  win.dispatch("beforeinstallprompt", fakePromptEvent("accepted"));

  await installAppEl.dispatch("click");

  // The click is this button's half of the funnel; the answer arrives
  // separately as pwa_install_choice from web/js/analytics.js.
  assert.equal(trackedEvents(win, "pwa_install_clicked").length, 1);
  // The event is spent, so the offer is gone: a still-visible button would do
  // nothing on a second tap.
  assert.equal(installAppEl.hidden, true);
  assert.ok(
    debug.some((line) => line.includes("INSTALL PROMPT accepted")),
    `outcome never reached the debug panel: ${debug.join(" | ")}`,
  );
});

test("the button stands down when the app is installed elsewhere", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  const { installAppEl, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(installAppEl.hidden, false);

  win.dispatch("appinstalled", {});
  assert.equal(installAppEl.hidden, true);
});

test("a browser that refuses the prompt says why in the debug panel", async () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  const { installAppEl, debug, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();
  win.dispatch("beforeinstallprompt", {
    preventDefault() {},
    prompt() {
      throw new Error("prompt() can only be called once");
    },
  });

  await installAppEl.dispatch("click");

  // The button vanishing with nothing installed is the whole user-visible
  // symptom, so the panel has to carry the actual exception.
  assert.ok(
    debug.some((line) => line.includes("INSTALL PROMPT ERROR") && line.includes("called once")),
    `the rejection never reached the debug panel: ${debug.join(" | ")}`,
  );
  assert.equal(installAppEl.hidden, true);
});

test("an install in another tab retires the button here", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  const { installAppEl, ctx } = makeContext();
  createInstallButton(ctx).bindEvents();
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(installAppEl.hidden, false);

  win.deliverBroadcast("installed");
  assert.equal(installAppEl.hidden, true);
});

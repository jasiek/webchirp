import test from "node:test";
import assert from "node:assert/strict";

import {
  bindInstallPrompt,
  isInstallAvailable,
  onInstallAvailabilityChange,
  promptInstall,
} from "../../web/js/install-prompt.js";
import { makeWindow } from "../support/fake-window.mjs";

// Guards the one thing this module does that is not undoable from the UI: it
// cancels the browser's own install prompt. If it ever cancels without parking
// a usable prompt in exchange, the app becomes harder to install than it was
// before the button existed — and nothing about that is visible on a page load,
// because beforeinstallprompt only fires on a device the app is installable on.
//
// Module state is deliberately global (the event may arrive before any
// subscriber exists), so every test rebinds against a fresh window and drops
// its own subscription afterwards.

// A beforeinstallprompt stand-in that records whether it was cancelled and how
// many times it was raised — the two facts every test here turns on.
function fakePromptEvent(outcome = "accepted") {
  return {
    prevented: false,
    prompts: 0,
    preventDefault() {
      this.prevented = true;
    },
    async prompt() {
      this.prompts += 1;
    },
    userChoice: Promise.resolve({ outcome }),
  };
}

test("nothing is installable until the browser offers it", async () => {
  bindInstallPrompt(makeWindow());
  assert.equal(isInstallAvailable(), false);
  assert.equal((await promptInstall()).outcome, "unavailable");
});

test("an offered prompt is cancelled, parked and announced", () => {
  const win = makeWindow();
  bindInstallPrompt(win);

  const seen = [];
  const unsubscribe = onInstallAvailabilityChange((available) => seen.push(available));

  const event = fakePromptEvent();
  win.dispatch("beforeinstallprompt", event);

  // Cancelling is what moves the install from the browser's throttled badge to
  // the app's own button; without it the button is a second, weaker affordance.
  assert.equal(event.prevented, true);
  assert.equal(isInstallAvailable(), true);
  assert.deepEqual(seen, [true]);
  unsubscribe();
});

test("raising the prompt reports the outcome and retires the button", async () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  const event = fakePromptEvent("accepted");
  win.dispatch("beforeinstallprompt", event);

  assert.equal((await promptInstall()).outcome, "accepted");
  assert.equal(event.prompts, 1);
  // The browser allows one prompt() per event, so a second tap must not reach
  // it: an already-used event rejects, which would look like a dead button.
  assert.equal(isInstallAvailable(), false);
  assert.equal((await promptInstall()).outcome, "unavailable");
  assert.equal(event.prompts, 1);
});

test("a declined install is reported as dismissed, not as a failure", async () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  win.dispatch("beforeinstallprompt", fakePromptEvent("dismissed"));
  assert.equal((await promptInstall()).outcome, "dismissed");
});

test("a refused prompt reports failed and hands back the rejection", async () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  win.dispatch("beforeinstallprompt", {
    preventDefault() {},
    prompt() {
      throw new Error("prompt() can only be called once");
    },
  });

  const { outcome, error } = await promptInstall();
  assert.equal(outcome, "failed");
  // A tap that installs nothing is the one failure here a user sees, so the
  // whole exception has to survive for the debug panel rather than collapsing
  // into the word "failed".
  assert.match(String(error?.message), /called once/);
  assert.equal(isInstallAvailable(), false);
});

test("an event that cannot be cancelled is left to the browser", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  // Parking an event we failed to cancel would leave the user with two prompts
  // or, worse, one suppressed and one that never raises.
  win.dispatch("beforeinstallprompt", {});
  win.dispatch("beforeinstallprompt", undefined);
  assert.equal(isInstallAvailable(), false);
});

test("installing elsewhere stands the button down", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(isInstallAvailable(), true);

  // The browser menu and another tab on this origin can both install the app.
  win.dispatch("appinstalled", {});
  assert.equal(isInstallAvailable(), false);
});

test("a throwing subscriber cannot strand the others", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  let reached = false;
  const dropFirst = onInstallAvailabilityChange(() => {
    throw new Error("subscriber blew up");
  });
  const dropSecond = onInstallAvailabilityChange(() => {
    reached = true;
  });

  assert.doesNotThrow(() => win.dispatch("beforeinstallprompt", fakePromptEvent()));
  assert.equal(reached, true);
  dropFirst();
  dropSecond();
});

test("a dropped subscription stops hearing about availability", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  let calls = 0;
  const unsubscribe = onInstallAvailabilityChange(() => {
    calls += 1;
  });
  unsubscribe();
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(calls, 0);
});

test("a window without listener support is survivable", () => {
  assert.doesNotThrow(() => bindInstallPrompt({}));
  assert.equal(isInstallAvailable(), false);
});

test("an install in another tab retires this one's offer", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(isInstallAvailable(), true);

  // appinstalled reaches only the window the install ran in, so a second tab
  // would otherwise keep a button backed by an event the browser has already
  // invalidated -- a tap that installs nothing.
  win.deliverBroadcast("installed");
  assert.equal(isInstallAvailable(), false);
});

test("installing here tells the other tabs", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  win.dispatch("appinstalled", {});

  assert.deepEqual(
    win.broadcasts.map((message) => message.data),
    ["installed"],
  );
});

test("an unrelated broadcast is ignored", () => {
  const win = makeWindow();
  bindInstallPrompt(win);
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  win.deliverBroadcast("something-else");
  assert.equal(isInstallAvailable(), true);
});

test("a browser without BroadcastChannel still installs, just window-locally", () => {
  const win = makeWindow({ broadcast: false });
  assert.doesNotThrow(() => bindInstallPrompt(win));
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(isInstallAvailable(), true);
  assert.doesNotThrow(() => win.dispatch("appinstalled", {}));
  assert.equal(isInstallAvailable(), false);
});

test("a non-function subscriber is refused an unsubscribe that does harm", () => {
  bindInstallPrompt(makeWindow());
  const unsubscribe = onInstallAvailabilityChange(null);
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(() => unsubscribe());
});

test("a browser that refuses to open a channel still offers the install", () => {
  const win = makeWindow();
  // Blocked site data makes the constructor throw rather than making the API
  // absent, which is a different branch from the browser that lacks it.
  win.BroadcastChannel = function BlockedChannel() {
    throw new Error("site data is blocked");
  };

  assert.doesNotThrow(() => bindInstallPrompt(win));
  win.dispatch("beforeinstallprompt", fakePromptEvent());
  assert.equal(isInstallAvailable(), true);
  // Nothing to post to, and the local install must still stand the button down.
  assert.doesNotThrow(() => win.dispatch("appinstalled", {}));
  assert.equal(isInstallAvailable(), false);
});

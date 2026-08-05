import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  MEASUREMENT_ID,
  bindInstallTracking,
  detectDisplayMode,
  initAnalytics,
  trackEvent,
} from "../web/js/analytics.js";

// Analytics fails silently by design — a dropped event looks exactly like a
// quiet day in the GA console — so the wiring is only ever checked here. The
// PWA install events matter most: they fire once per user, in a standalone
// window nobody is watching a debug log in.
const WEB_DIR = path.join(process.cwd(), "web");

// Minimal window stand-in: records listeners so tests can dispatch at them, and
// answers matchMedia from an explicit set of matching queries.
function makeWindow({ displayModes = [], standalone = undefined } = {}) {
  const listeners = new Map();
  return {
    navigator: standalone === undefined ? {} : { standalone },
    matchMedia: (query) => ({
      matches: displayModes.some((mode) => query === `(display-mode: ${mode})`),
    }),
    addEventListener(type, handler) {
      const existing = listeners.get(type) || [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) || []) {
        handler(event);
      }
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

// dataLayer holds arguments objects, not arrays.
function calls(win) {
  return (win.dataLayer || []).map((entry) => Array.from(entry));
}

function eventsNamed(win, name) {
  return calls(win).filter((call) => call[0] === "event" && call[1] === name);
}

test("display mode reports the most app-like match", () => {
  assert.equal(detectDisplayMode(makeWindow({ displayModes: ["standalone"] })), "standalone");
  assert.equal(detectDisplayMode(makeWindow({ displayModes: ["minimal-ui"] })), "minimal-ui");
  assert.equal(detectDisplayMode(makeWindow({ displayModes: ["browser"] })), "browser");
  assert.equal(detectDisplayMode(makeWindow()), "browser");
  // A window-controls-overlay window matches standalone too; the more specific
  // mode has to win or every desktop install looks the same.
  assert.equal(
    detectDisplayMode(makeWindow({ displayModes: ["window-controls-overlay", "standalone"] })),
    "window-controls-overlay",
  );
  // iOS home-screen launches never match the media query.
  assert.equal(detectDisplayMode(makeWindow({ standalone: true })), "standalone");
  assert.equal(detectDisplayMode({}), "browser");
});

test("init attaches the launch context to config, never to a bare set", () => {
  const win = makeWindow({ displayModes: ["standalone"] });
  initAnalytics(win);

  const commands = calls(win).map((call) => call[0]);
  assert.deepEqual(commands, ["js", "config"]);

  const [, id, params] = calls(win).find((call) => call[0] === "config");
  assert.equal(id, MEASUREMENT_ID);
  // The automatic page_view is sent by config and carries its parameters.
  assert.equal(params.display_mode, "standalone");

  // Regression guard. gtag("set", {...}) reads like it sets a global parameter
  // for later hits, but GA4 does not carry custom parameters from it onto
  // events: display_mode set that way never appeared as ep.display_mode in a
  // real collect payload, verified on-device. Nothing here can observe that,
  // so the shape is pinned instead.
  assert.ok(!commands.includes("set"), 'display_mode must not be sent via gtag("set")');
});

test("init is inert without a window and keeps an existing gtag", () => {
  assert.equal(initAnalytics(null), null);

  const win = makeWindow();
  const seen = [];
  win.gtag = (...args) => seen.push(args);
  initAnalytics(win);
  // A gtag already on the page (a manually pasted snippet, say) must not be
  // replaced, or its dataLayer and ours diverge.
  assert.deepEqual(seen.map((call) => call[0]), ["js", "config"]);
});

test("trackEvent forwards params and reports when analytics is absent", () => {
  const win = makeWindow({ displayModes: ["standalone"] });
  initAnalytics(win);
  assert.equal(trackEvent("radio_download", { radio_make: "Baofeng" }, win), true);
  // Every event carries the launch context, since config parameters cannot be
  // relied on to reach events the way a bare set() cannot.
  assert.deepEqual(eventsNamed(win, "radio_download")[0][2], {
    display_mode: "standalone",
    radio_make: "Baofeng",
  });

  // An explicit value still wins over the automatic one.
  trackEvent("radio_upload", { display_mode: "browser" }, win);
  assert.equal(eventsNamed(win, "radio_upload")[0][2].display_mode, "browser");

  // Blocked or stripped analytics: callers must not have to guard.
  assert.equal(trackEvent("radio_download", {}, {}), false);
  assert.equal(trackEvent("radio_download", {}, null), false);
});

test("an install prompt is measured without suppressing the browser's own", () => {
  const win = makeWindow({ displayModes: ["browser"] });
  initAnalytics(win);

  let prevented = false;
  win.dispatch("beforeinstallprompt", {
    preventDefault() {
      prevented = true;
    },
  });

  const [prompt] = eventsNamed(win, "pwa_install_prompt");
  assert.ok(prompt, "beforeinstallprompt sent no event");
  assert.equal(prompt[2].display_mode, "browser");
  // preventDefault() hides Chrome's install UI, and there is no custom install
  // button here to put in its place.
  assert.equal(prevented, false);
});

test("the install choice is measured once the user answers", async () => {
  const win = makeWindow();
  initAnalytics(win);

  win.dispatch("beforeinstallprompt", {
    preventDefault() {},
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  await Promise.resolve();
  await Promise.resolve();

  const [choice] = eventsNamed(win, "pwa_install_choice");
  assert.ok(choice, "userChoice sent no event");
  assert.equal(choice[2].install_outcome, "accepted");
});

test("a prompt event without userChoice is survivable", () => {
  const win = makeWindow();
  initAnalytics(win);
  assert.doesNotThrow(() => win.dispatch("beforeinstallprompt", { preventDefault() {} }));
  assert.doesNotThrow(() => win.dispatch("beforeinstallprompt", undefined));
  assert.equal(eventsNamed(win, "pwa_install_prompt").length, 2);
});

test("appinstalled reports the mode the install happened from", () => {
  const win = makeWindow({ displayModes: ["browser"] });
  initAnalytics(win);
  win.dispatch("appinstalled", {});

  const [installed] = eventsNamed(win, "pwa_installed");
  assert.ok(installed, "appinstalled sent no event");
  assert.equal(installed[2].display_mode, "browser");
});

test("install tracking binds nothing on a window that cannot listen", () => {
  assert.doesNotThrow(() => bindInstallTracking({}));
  assert.doesNotThrow(() => bindInstallTracking(null));
});

test("every page loads analytics exactly once", () => {
  for (const page of ["index.html", "about.html"]) {
    const html = fs.readFileSync(path.join(WEB_DIR, page), "utf8");

    const loaders = html.match(/googletagmanager\.com\/gtag\/js\?id=([\w-]+)/g) || [];
    assert.equal(loaders.length, 1, `${page} should load gtag.js once`);
    assert.ok(loaders[0].endsWith(MEASUREMENT_ID), `${page} loads a stale measurement id`);

    const modules = html.match(/<script type="module" src="\.\/js\/analytics\.js"><\/script>/g) || [];
    assert.equal(modules.length, 1, `${page} should load the analytics module once`);

    // An inline snippet left behind next to the module would config the same
    // property twice and double every page_view.
    assert.doesNotMatch(html, /gtag\(\s*['"]config['"]/, `${page} still configs gtag inline`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ANALYTICS_HOSTS,
  MEASUREMENT_ID,
  bindInstallTracking,
  detectDisplayMode,
  initAnalytics,
  isAnalyticsHost,
  trackEvent,
} from "../web/js/analytics.js";

// Analytics fails silently by design — a dropped event looks exactly like a
// quiet day in the GA console — so the wiring is only ever checked here. The
// PWA install events matter most: they fire once per user, in a standalone
// window nobody is watching a debug log in. The host gate is checked just as
// hard: a dev server or a fork's Pages site reporting into the shared property
// is silent when it happens and unfixable afterwards, since GA4 does not let
// you delete events you wish you had not collected.
const WEB_DIR = path.join(process.cwd(), "web");
const ANALYTICS_MODULE = fs.readFileSync(path.join(WEB_DIR, "js", "analytics.js"), "utf8");

// Minimal window stand-in: records listeners so tests can dispatch at them,
// answers matchMedia from an explicit set of matching queries, and records
// every script the module appends to the document.
function makeWindow({ displayModes = [], standalone = undefined, hostname = "codeplug.org" } = {}) {
  const listeners = new Map();
  const injected = [];
  return {
    location: { hostname },
    injected,
    document: {
      createElement: () => ({}),
      head: {
        appendChild(node) {
          injected.push(node);
        },
      },
    },
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

test("only the production deployment reports", () => {
  assert.deepEqual([...ANALYTICS_HOSTS].sort(), ["codeplug.org", "www.codeplug.org"]);
  assert.equal(isAnalyticsHost(makeWindow({ hostname: "codeplug.org" })), true);
  // CNAME points at the apex, so an unredirected www visitor is real traffic.
  assert.equal(isAnalyticsHost(makeWindow({ hostname: "www.codeplug.org" })), true);
  assert.equal(isAnalyticsHost(makeWindow({ hostname: "localhost" })), false);
  assert.equal(isAnalyticsHost(makeWindow({ hostname: "jasiek.github.io" })), false);
  // Not a suffix match: a lookalike domain must not inherit the property.
  assert.equal(isAnalyticsHost(makeWindow({ hostname: "evil-codeplug.org" })), false);
  assert.equal(isAnalyticsHost({}), false);
});

test("the allowlist covers the domain the site is actually served from", () => {
  // CNAME is what GitHub Pages serves the app on. If the domain ever moves and
  // the allowlist is not moved with it, analytics goes silent — the failure
  // that would otherwise take months to notice.
  const cname = fs.readFileSync(path.join(process.cwd(), "CNAME"), "utf8").trim();
  assert.ok(ANALYTICS_HOSTS.includes(cname), `CNAME is ${cname}, which ANALYTICS_HOSTS does not include`);
});

test("nothing at all happens off the production host", () => {
  const win = makeWindow({ hostname: "localhost" });
  assert.equal(initAnalytics(win), null);
  // No vendor request, no gtag, and so no event any caller sends can escape.
  assert.deepEqual(win.injected, []);
  assert.equal(win.gtag, undefined);
  assert.deepEqual(win.dataLayer, undefined);
  assert.equal(trackEvent("radio_download", {}, win), false);
  assert.equal(win.listenerCount("appinstalled"), 0);
});

test("the vendor tag is requested by the module, once, on the production host", () => {
  const win = makeWindow();
  initAnalytics(win);
  assert.equal(win.injected.length, 1);
  assert.equal(win.injected[0].src, `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`);
  assert.equal(win.injected[0].async, true);
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

  // Content blockers commonly leave a gtag behind that throws. A clone must not
  // fail because of what reports on it.
  const blocked = makeWindow();
  blocked.gtag = () => {
    throw new Error("blocked");
  };
  assert.equal(trackEvent("radio_download", {}, blocked), false);
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

test("every page loads analytics exactly once, and only through the module", () => {
  for (const page of ["index.html", "about.html"]) {
    const html = fs.readFileSync(path.join(WEB_DIR, page), "utf8");

    const modules = html.match(/<script type="module" src="\.\/js\/analytics\.js"><\/script>/g) || [];
    assert.equal(modules.length, 1, `${page} should load the analytics module once`);

    // A static loader tag would fetch the vendor script on every fork and dev
    // server regardless of what the host gate in the module decides.
    assert.doesNotMatch(html, /googletagmanager\.com/, `${page} requests gtag.js outside the host gate`);

    // An inline snippet left behind next to the module would config the same
    // property twice and double every page_view.
    assert.doesNotMatch(html, /gtag\(\s*['"]config['"]/, `${page} still configs gtag inline`);
  }

  const loaders = ANALYTICS_MODULE.match(/googletagmanager\.com\/gtag\/js\?id=\$\{MEASUREMENT_ID\}/g) || [];
  assert.equal(loaders.length, 1, "the module should have exactly one loader URL, built from MEASUREMENT_ID");
});

test("the encoding declaration stays inside the first 1024 bytes", () => {
  // HTML requires it there. The analytics comment above it is long enough, and
  // non-ASCII enough, to push it out if it ever moves back below.
  for (const page of ["index.html", "about.html"]) {
    const html = fs.readFileSync(path.join(WEB_DIR, page));
    const at = html.indexOf("charset");
    assert.ok(at >= 0 && at < 1024, `${page} declares its encoding at byte ${at}`);
  }
});

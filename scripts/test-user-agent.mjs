import assert from "node:assert/strict";
import test from "node:test";

import {
  detectBrowserName,
  detectPlatformName,
  resetBrowserProbeForTests,
} from "../web/js/ui/format.js";
import { METRIC_ATTRIBUTES } from "../web/js/sentry.js";
import { withNavigator } from "./test-support/globals.mjs";

// Browser and platform as bounded telemetry tokens. Nearly every case here is
// an ordering trap rather than a lookup: every Chromium browser carries
// "Chrome" in its user agent, Android calls itself Linux, and iPadOS calls
// itself a Mac -- so the tests are written as real user agent strings, because
// a hand-simplified one would pass while the real thing failed.

// Real-world user agents, trimmed only of build numbers that do not matter.
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86";
const OPERA_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0";
const VIVALDI_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Vivaldi/7.0.3495.11";
const SAMSUNG_ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36";
const EDGE_ANDROID = "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.2903.87";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
const CHROMIUM_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/130.0.6723.116 Chrome/130.0.0.0 Safari/537.36";
const CHROME_OS = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Fake navigator with only what the detection reads.
function nav(userAgent, extra = {}) {
  return { userAgent, maxTouchPoints: 0, ...extra };
}

// Detect the browser for one user agent with the module's Brave cache cleared
// on both sides of the test. The cache is keyed on nothing -- it is one flag
// for the life of the page, which is right in a browser and wrong here, where
// one fake navigator would otherwise answer for every case after it.
function browserFor(t, userAgent, extra) {
  withNavigator(t, nav(userAgent, extra));
  resetBrowserProbeForTests();
  t.after(resetBrowserProbeForTests);
  return detectBrowserName();
}

test("a Chromium derivative reports itself, not Chrome", (t) => {
  // The failure this guards: all five of these carry "Chrome/" in their user
  // agent, so a naive check answers "chrome" for every one of them.
  assert.equal(browserFor(t, EDGE_WINDOWS), "edge");
});

test("Opera is not Chrome", (t) => {
  assert.equal(browserFor(t, OPERA_WINDOWS), "opera");
});

test("Vivaldi is not Chrome", (t) => {
  assert.equal(browserFor(t, VIVALDI_LINUX), "vivaldi");
});

test("Samsung Internet is not Chrome", (t) => {
  assert.equal(browserFor(t, SAMSUNG_ANDROID), "samsung");
});

test("Edge on Android is Edge", (t) => {
  // EdgA/ rather than Edg/, and it trails a Chrome token as usual.
  assert.equal(browserFor(t, EDGE_ANDROID), "edge");
});

test("a plain Chromium build is not Chrome either", (t) => {
  // Chromium's user agent carries both "Chromium/" and "Chrome/", so this only
  // works because Chromium is tested first -- and it is safe to test first
  // because Chrome's own user agent never says "Chromium/".
  assert.equal(browserFor(t, CHROMIUM_LINUX), "chromium");
});

test("Chrome is Chrome", (t) => {
  assert.equal(browserFor(t, CHROME_MAC), "chrome");
});

test("Firefox is read from the user agent, which offers no client hints", (t) => {
  assert.equal(browserFor(t, FIREFOX_LINUX), "firefox");
});

test("Safari is Safari, and every Chromium browser also claims Safari", (t) => {
  assert.equal(browserFor(t, SAFARI_MAC), "safari");
});

test("a browser on iOS reports its brand, and the platform says it is WebKit", (t) => {
  // Chrome on iOS is Safari's engine wearing Chrome's name. Reporting the brand
  // is right -- it is what the user chose -- and the platform is what says the
  // engine underneath has no Web Serial at all.
  assert.equal(browserFor(t, CHROME_IPHONE), "chrome");
});

test("client hints win over the user agent where the browser offers them", (t) => {
  // A Chromium derivative names itself honestly here instead of hiding behind
  // Chrome's token, so this is the more reliable source where it exists.
  const brands = [
    { brand: "Not:A-Brand", version: "24" },
    { brand: "Chromium", version: "131" },
    { brand: "Microsoft Edge", version: "131" },
  ];
  // The user agent alone would still say edge, so the case is only meaningful
  // with a user agent that does not.
  assert.equal(browserFor(t, CHROME_MAC, { userAgentData: { brands } }), "edge");
});

test("the GREASE brand designed to break parsers is not mistaken for a browser", (t) => {
  const brands = [
    { brand: "Not:A-Brand", version: "24" },
    { brand: "Chromium", version: "131" },
    { brand: "Google Chrome", version: "131" },
  ];
  assert.equal(browserFor(t, CHROME_MAC, { userAgentData: { brands } }), "chrome");
});

test("an unrecognised browser reports other, never the raw user agent", (t) => {
  // The point of a separate function from detectBrowserVersion(), which falls
  // back to the whole user agent -- right for a GitHub issue a person reads,
  // unbounded cardinality and a fingerprint as a metric attribute.
  const answer = browserFor(t, "Mozilla/5.0 (SomeConsole; rv:1) SomeEngine/2.0");
  assert.equal(answer, "other");
});

test("Brave is only knowable asynchronously, and is Chrome until it settles", async (t) => {
  withNavigator(t, nav(CHROME_MAC, { brave: { isBrave: async () => true } }));
  resetBrowserProbeForTests();
  t.after(resetBrowserProbeForTests);
  // Brave ships a user agent byte-identical to Chrome's on purpose, so the
  // first call cannot know better. That is the documented cost, not a bug.
  assert.equal(detectBrowserName(), "chrome");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detectBrowserName(), "brave");
});

test("a Brave probe that throws costs the answer, not the report", async (t) => {
  withNavigator(t, nav(CHROME_MAC, {
    brave: {
      isBrave: async () => {
        throw new Error("blocked");
      },
    },
  }));
  resetBrowserProbeForTests();
  t.after(resetBrowserProbeForTests);
  assert.equal(detectBrowserName(), "chrome");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detectBrowserName(), "chrome");
});

test("iPadOS is iOS even though it calls itself a Mac", (t) => {
  // iPadOS sends a desktop Macintosh user agent, so touch points are the only
  // thing separating an iPad from a real Mac -- and getting this wrong would
  // file every iPad's missing Web Serial under macOS.
  withNavigator(t, nav(SAFARI_MAC, { maxTouchPoints: 5 }));
  assert.equal(detectPlatformName(), "ios");
});

test("a real Mac is macOS", (t) => {
  withNavigator(t, nav(SAFARI_MAC));
  assert.equal(detectPlatformName(), "macos");
});

test("Android is Android even though it calls itself Linux", (t) => {
  // The Android user agent contains "Linux", so order is what keeps these apart
  // -- and they are the two platforms whose serial support differs most.
  withNavigator(t, nav(SAMSUNG_ANDROID));
  assert.equal(detectPlatformName(), "android");
});

test("desktop Linux is Linux", (t) => {
  withNavigator(t, nav(FIREFOX_LINUX));
  assert.equal(detectPlatformName(), "linux");
});

test("ChromeOS is told apart from Linux", (t) => {
  withNavigator(t, nav(CHROME_OS));
  assert.equal(detectPlatformName(), "chromeos");
});

test("an iPhone is iOS", (t) => {
  withNavigator(t, nav(SAFARI_IPHONE));
  assert.equal(detectPlatformName(), "ios");
});

test("Windows is Windows", (t) => {
  withNavigator(t, nav(EDGE_WINDOWS));
  assert.equal(detectPlatformName(), "windows");
});

test("an unrecognised platform reports other", (t) => {
  withNavigator(t, nav("Mozilla/5.0 (SomeConsole)"));
  assert.equal(detectPlatformName(), "other");
});

test("both tokens are declared, or web/js/sentry.js would drop them", () => {
  assert.ok(METRIC_ATTRIBUTES.includes("browser"));
  assert.ok(METRIC_ATTRIBUTES.includes("platform"));
});

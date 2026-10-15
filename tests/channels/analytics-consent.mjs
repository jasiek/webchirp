import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSENT_KEY,
  MEASUREMENT_ID,
  REPLAY_LIMIT,
  deferAnalytics,
  initAnalytics,
  replayDeferredAnalytics,
  trackEvent,
} from "../../web/js/analytics.ts";
import { CONSENT_BANNER_ID } from "../../web/js/consent-banner.ts";
import { installIndexPage } from "../support/index-page.mjs";
import { dispatch, keydownEvent } from "../support/ui-interactions.mjs";

// The consent gate in front of Google Analytics, on the real pages. Nothing
// may be requested from Google, and no GA cookie set, until the visitor
// presses Accept; Decline must leave no trace, not even in the offline replay
// queue; the answer must survive a reload and be changeable from the footer.
// A regression here is invisible from the outside -- GA simply receives a
// little more -- so this is the only place it would be caught.

// The production host, the only place the gate is reached at all.
const PRODUCTION = "https://webchirp.org/";
const GTAG_SRC = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
const REPLAY_KEY = "webchirp-analytics-replay";

// Load a page on the production host and run the analytics module on it, as
// its module script does.
function openPage(page = "index.html") {
  const installed = installIndexPage({ origin: PRODUCTION, page });
  initAnalytics(installed.window);
  return installed;
}

// What a reload keeps is the origin's storage; the document, the window's
// globals and the module's per-page state are all new.
function reloadPage(page = "index.html") {
  const storage = globalThis.localStorage;
  const kept = Array.from({ length: storage.length }, (_, i) => [storage.key(i), storage.getItem(storage.key(i))]);
  const installed = installIndexPage({ origin: PRODUCTION, page });
  for (const [key, value] of kept) {
    installed.window.localStorage.setItem(key, value);
  }
  initAnalytics(installed.window);
  return installed;
}

function banner(document) {
  return document.getElementById(CONSENT_BANNER_ID);
}

function choiceButton(document, choice) {
  return banner(document)?.querySelector(`button[data-consent="${choice}"]`);
}

function gtagScripts(document) {
  return [...document.querySelectorAll("script")].filter((script) => script.src.includes("googletagmanager.com"));
}

// dataLayer holds arguments objects, not arrays.
function calls(window) {
  return (window.dataLayer || []).map((entry) => Array.from(entry));
}

function settingsControl(document) {
  return document.querySelector("[data-analytics-consent-settings]");
}

test("before an answer the banner asks and nothing reaches Google", async () => {
  const { window, document } = openPage();
  const shown = banner(document);
  assert.ok(shown, "no consent banner on a first visit");

  const decline = choiceButton(document, "denied");
  const accept = choiceButton(document, "granted");
  assert.equal(decline.textContent, "Decline");
  assert.equal(accept.textContent, "Accept");
  // Equal prominence: one class for both, nothing focused or pre-selected.
  assert.equal(decline.className, accept.className);
  assert.ok(![decline, accept].includes(document.activeElement), "a choice is focused for the visitor");
  assert.ok(!decline.hasAttribute("autofocus") && !accept.hasAttribute("autofocus"));

  const policy = shown.querySelector("a");
  assert.equal(new URL(policy.href).pathname, "/privacy.html");

  // Tracked events wait; nothing is loaded, defined or stored for them.
  assert.equal(trackEvent("app_ready", {}, window), false);
  assert.deepEqual(gtagScripts(document), []);
  assert.equal(window.gtag, undefined);
  assert.equal(window.dataLayer, undefined);
  assert.doesNotMatch(document.cookie, /(^|;\s*)_ga/);
  assert.equal(window.localStorage.getItem(CONSENT_KEY), null);
  assert.equal(window.localStorage.getItem(REPLAY_KEY), null);

  // Never dismissed by anything but a choice: not a click elsewhere, not Escape.
  await dispatch(document.body, "click");
  document.body.dispatchEvent(keydownEvent("Escape"));
  assert.ok(banner(document), "the banner went away without an answer");
});

test("Accept loads gtag with every consent type denied but analytics, then sends what waited", async () => {
  const { window, document } = openPage();
  trackEvent("radio_selected", { radio: "Baofeng UV-5R" }, window);
  await dispatch(choiceButton(document, "granted"), "click");

  assert.equal(banner(document), null, "the banner stays up after Accept");
  assert.equal(window.localStorage.getItem(CONSENT_KEY), "granted");
  assert.deepEqual(gtagScripts(document).map((script) => script.src), [GTAG_SRC]);
  assert.equal(typeof window.gtag, "function");

  const sent = calls(window);
  assert.deepEqual(sent.map((call) => call.slice(0, 2).join(" ")).slice(0, 4), [
    "consent default",
    "consent update",
    `js ${sent[2][1]}`,
    `config ${MEASUREMENT_ID}`,
  ]);
  // The defaults come before anything else and deny all four v2 types; the
  // grant is analytics_storage alone.
  assert.deepEqual(sent[0][2], {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  assert.deepEqual(sent[1][2], { analytics_storage: "granted" });
  // The event tracked before the answer follows the config, with its params.
  const held = sent.filter((call) => call[0] === "event");
  assert.deepEqual(held.map((call) => call[1]), ["radio_selected"]);
  assert.equal(held[0][2].radio, "Baofeng UV-5R");

  assert.equal(trackEvent("radio_download", {}, window), true);
});

test("Decline loads nothing, drops what waited, and never queues for replay", async () => {
  const { window, document } = openPage();
  // A replay queue an earlier version left behind goes with the decline.
  window.localStorage.setItem(REPLAY_KEY, JSON.stringify({ events: [{ name: "app_ready", params: {} }], dropped: 0 }));
  trackEvent("app_ready", {}, window);
  await dispatch(choiceButton(document, "denied"), "click");

  assert.equal(banner(document), null, "the banner stays up after Decline");
  assert.equal(window.localStorage.getItem(CONSENT_KEY), "denied");
  assert.equal(window.localStorage.getItem(REPLAY_KEY), null);

  assert.equal(trackEvent("radio_download", {}, window), false);
  // An offline page after a decline has nothing to queue, and nothing replays.
  assert.equal(deferAnalytics(window), false);
  assert.equal(trackEvent("radio_upload", {}, window), false);
  assert.equal(replayDeferredAnalytics(window), 0);
  assert.equal(window.localStorage.getItem(REPLAY_KEY), null);

  assert.deepEqual(gtagScripts(document), []);
  assert.equal(window.gtag, undefined);
  assert.equal(window.dataLayer, undefined);
});

test("events held on an offline page reach the replay queue only through Accept", async () => {
  let { window, document } = openPage();
  assert.equal(deferAnalytics(window), true);
  trackEvent("radio_selected", {}, window);
  assert.equal(window.localStorage.getItem(REPLAY_KEY), null, "queued to storage before any answer");
  await dispatch(choiceButton(document, "denied"), "click");
  assert.equal(window.localStorage.getItem(REPLAY_KEY), null);

  ({ window, document } = openPage());
  deferAnalytics(window);
  trackEvent("radio_selected", {}, window);
  await dispatch(choiceButton(document, "granted"), "click");
  const queue = JSON.parse(window.localStorage.getItem(REPLAY_KEY));
  assert.deepEqual(queue.events.map((event) => event.name), ["radio_selected"]);
  assert.ok(!calls(window).some((call) => call[0] === "event"), "an offline page sent live");
});

test("only the newest events wait for an answer", async () => {
  const { window, document } = openPage();
  for (let i = 0; i < REPLAY_LIMIT + 5; i++) {
    trackEvent("channel_extra_opened", { channel_count: i }, window);
  }
  await dispatch(choiceButton(document, "granted"), "click");
  const held = calls(window).filter((call) => call[0] === "event");
  assert.equal(held.length, REPLAY_LIMIT);
  assert.equal(held[0][2].channel_count, 5);
});

test("the answer survives a reload", async () => {
  let { window, document } = openPage();
  await dispatch(choiceButton(document, "granted"), "click");
  ({ window, document } = reloadPage());
  assert.equal(banner(document), null, "asked again after an Accept");
  assert.deepEqual(gtagScripts(document).map((script) => script.src), [GTAG_SRC]);
  assert.equal(trackEvent("app_ready", {}, window), true);

  await dispatch(settingsControl(document), "click");
  await dispatch(choiceButton(document, "denied"), "click");
  ({ window, document } = reloadPage());
  assert.equal(banner(document), null, "asked again after a Decline");
  assert.deepEqual(gtagScripts(document), []);
  assert.equal(window.gtag, undefined);
  assert.equal(trackEvent("app_ready", {}, window), false);
});

test("Cookie settings reopens the banner, and a Decline there undoes an Accept", async () => {
  const { window, document } = openPage();
  const control = settingsControl(document);
  assert.equal(control.hidden, false, "Cookie settings stays hidden on the production host");
  assert.equal(control.textContent.trim(), "Cookie settings");

  await dispatch(choiceButton(document, "granted"), "click");
  // What gtag.js would have written by now, host-only and on the domain.
  document.cookie = "_ga=GA1.1.123.456; path=/";
  document.cookie = `_ga_${MEASUREMENT_ID.slice(2)}=GS1.1.789; path=/; domain=webchirp.org`;
  document.cookie = "unrelated=kept; path=/";

  await dispatch(control, "click");
  assert.ok(banner(document), "Cookie settings did not reopen the banner");
  assert.match(banner(document).textContent, /Right now you accept/);
  assert.notEqual(document.activeElement, choiceButton(document, "granted"));

  await dispatch(choiceButton(document, "denied"), "click");
  assert.equal(banner(document), null);
  assert.equal(window.localStorage.getItem(CONSENT_KEY), "denied");
  // The loaded tag is switched off, its grant withdrawn, and its cookies gone.
  assert.equal(window[`ga-disable-${MEASUREMENT_ID}`], true);
  assert.deepEqual(calls(window).at(-1), ["consent", "update", { analytics_storage: "denied" }]);
  assert.equal(document.cookie, "unrelated=kept");
  assert.equal(trackEvent("radio_download", {}, window), false);

  // Changing back needs no second tag.
  await dispatch(control, "click");
  assert.match(banner(document).textContent, /Right now you decline/);
  await dispatch(choiceButton(document, "granted"), "click");
  assert.equal(window[`ga-disable-${MEASUREMENT_ID}`], false);
  assert.deepEqual(calls(window).at(-1), ["consent", "update", { analytics_storage: "granted" }]);
  assert.equal(gtagScripts(document).length, 1);
  assert.equal(trackEvent("radio_download", {}, window), true);
});

test("about.html asks too and has the same Cookie settings control", async () => {
  const { document } = openPage("about.html");
  assert.ok(banner(document), "no consent banner on about.html");
  await dispatch(choiceButton(document, "denied"), "click");
  const control = settingsControl(document);
  assert.equal(control.hidden, false);
  await dispatch(control, "click");
  assert.ok(banner(document), "Cookie settings did not reopen the banner on about.html");
});

test("off the production host there is no banner and nothing to change", () => {
  for (const page of ["index.html", "about.html"]) {
    const { window, document } = installIndexPage({ page });
    assert.equal(initAnalytics(window), null);
    assert.equal(banner(document), null, `${page} asks for consent off the production host`);
    assert.equal(settingsControl(document).hidden, true, `${page} shows Cookie settings off the production host`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { TURNSTILE_TOKEN_TIMEOUT_MS, createTurnstileTokens } from "../../web/js/turnstile.ts";

// A turnstile global the test drives by hand: nothing is issued until the test
// calls issue(), fails() or timesOut(), so each case controls exactly when the
// widget answers.
function manualTurnstile() {
  const widget = { options: null, resets: 0, removed: [] };
  const api = {
    render(_container, options) {
      widget.options = options;
      return "widget-1";
    },
    reset() {
      widget.resets += 1;
    },
    remove(widgetId) {
      widget.removed.push(widgetId);
    },
  };
  return {
    widget,
    load: async () => api,
    issue: (token) => widget.options.callback(token),
    fails: (code) => widget.options["error-callback"](code),
    expires: () => widget.options["expired-callback"](),
    timesOut: () => widget.options["timeout-callback"](),
  };
}

function settled() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a token issued before anyone asks is kept for the next request, then the widget resets", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  await settled();
  assert.equal(turnstile.widget.options.sitekey, "site-key");
  turnstile.issue("first");
  assert.equal(await tokens.next(), "first");
  assert.equal(turnstile.widget.resets, 1, "a spent token starts the widget on the next one");
});

test("a request waiting for a token gets the next one issued, and no other request does", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  const first = tokens.next();
  const second = tokens.next();
  await settled();
  turnstile.issue("a");
  turnstile.issue("b");
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
});

test("an expired token is never handed out", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  await settled();
  turnstile.issue("stale");
  turnstile.expires();
  const pending = tokens.next();
  await settled();
  turnstile.issue("renewed");
  assert.equal(await pending, "renewed");
});

test("a widget error fails the waiting requests with Cloudflare's code", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  const pending = tokens.next();
  await settled();
  assert.equal(turnstile.widget.options["error-callback"]("110200"), true, "the error is reported handled");
  await assert.rejects(pending, /Cloudflare Turnstile check failed \(error 110200\)/);
});

test("an interactive challenge left unanswered fails the waiting request", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  const pending = tokens.next();
  await settled();
  turnstile.timesOut();
  await assert.rejects(pending, /timed out before it was completed/);
});

test("a widget that never issues a token fails the request at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  const pending = tokens.next();
  await settled();
  t.mock.timers.tick(TURNSTILE_TOKEN_TIMEOUT_MS);
  await assert.rejects(pending, /did not issue a token within 60 s/);
});

test("a script that cannot load fails every request with the reason", async () => {
  const tokens = createTurnstileTokens({}, "site-key", async () => {
    throw new Error("blocked");
  });
  await assert.rejects(tokens.next(), /blocked/);
});

test("removing the widget fails pending requests and releases it", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  const pending = tokens.next();
  await settled();
  tokens.remove();
  await assert.rejects(pending, /closed/);
  await settled();
  assert.deepEqual(turnstile.widget.removed, ["widget-1"]);
  await assert.rejects(tokens.next(), /closed/);
});

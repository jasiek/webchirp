import assert from "node:assert/strict";
import test from "node:test";

import { TURNSTILE_TOKEN_TIMEOUT_MS, createTurnstileTokens, turnstileWaitReason } from "../../web/js/turnstile.ts";

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
    interactive: () => widget.options["before-interactive-callback"](),
    ticked: () => widget.options["after-interactive-callback"](),
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

test("a script request that never settles still fails the request at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tokens = createTurnstileTokens({}, "site-key", () => new Promise(() => {}));
  const pending = tokens.next();
  t.mock.timers.tick(TURNSTILE_TOKEN_TIMEOUT_MS);
  await assert.rejects(pending, /did not issue a token within 60 s/);
});

test("removing the widget ends a request still waiting on the script", async () => {
  const tokens = createTurnstileTokens({}, "site-key", () => new Promise(() => {}));
  const pending = tokens.next();
  tokens.remove();
  await assert.rejects(pending, /closed/);
});

test("the state follows what the widget reports, and every change is heard", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  const heard = [];
  tokens.subscribe(() => heard.push(tokens.state().kind));
  assert.deepEqual(tokens.state(), { kind: "checking" });
  await settled();

  turnstile.interactive();
  turnstile.ticked();
  turnstile.issue("first");
  turnstile.expires();
  turnstile.fails("600010");
  assert.deepEqual(tokens.state(), { kind: "failed", code: "600010" });
  turnstile.timesOut();
  turnstile.issue("second");
  assert.deepEqual(heard, ["interactive", "checking", "ready", "expired", "failed", "timed-out", "ready"]);

  assert.equal(await tokens.next(), "second");
  assert.deepEqual(tokens.state(), { kind: "checking" }, "a spent token leaves the widget on the next one");
});

test("waiting() says whether a request is waiting for its token", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  let heard = 0;
  tokens.subscribe(() => {
    heard += 1;
  });
  assert.equal(tokens.waiting(), false);
  const pending = tokens.next();
  assert.equal(tokens.waiting(), true);
  assert.equal(heard, 1, "a request starting to wait is heard");
  await settled();
  turnstile.issue("token");
  assert.equal(tokens.waiting(), false, "no longer waiting once its token is handed over");
  assert.equal(await pending, "token");
});

test("a script that cannot load leaves the check unavailable", async () => {
  const tokens = createTurnstileTokens({}, "site-key", async () => {
    throw new Error("blocked");
  });
  await settled();
  assert.deepEqual(tokens.state(), { kind: "unavailable" });
});

test("a removed widget forgets its listeners", async () => {
  const turnstile = manualTurnstile();
  const tokens = createTurnstileTokens({}, "site-key", turnstile.load);
  let heard = 0;
  tokens.subscribe(() => {
    heard += 1;
  });
  await settled();
  tokens.remove();
  turnstile.issue("late");
  assert.equal(heard, 0);
});

test("every state but ready says why a request would wait, each in its own words", () => {
  const states = [
    { kind: "checking" },
    { kind: "interactive" },
    { kind: "expired" },
    { kind: "timed-out" },
    { kind: "failed", code: "600010" },
    { kind: "unavailable" },
  ];
  const reasons = states.map(turnstileWaitReason);
  assert.equal(turnstileWaitReason({ kind: "ready" }), "");
  assert.ok(reasons.every((reason) => reason.length > 0), reasons.join("\n"));
  assert.equal(new Set(reasons).size, reasons.length, "no two states read the same");
  assert.match(turnstileWaitReason({ kind: "failed", code: "600010" }), /600010/);
});

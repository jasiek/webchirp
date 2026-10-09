import assert from "node:assert/strict";
import test from "node:test";
import "../support/register-cdn-imports.mjs";

import { createDebugLog } from "../../web/js/ui/debug-log.ts";
import { initOptions, initSentry, resetSentryForTests } from "../../web/js/sentry.js";
import { markBootstrapFailure } from "../../web/js/runtime-bootstrap.ts";
import { fakeDebugDom } from "../support/fake-dom.mjs";

test("debug output is folded initially and toggles both hidden regions together", () => {
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom });
  log.bindEvents();

  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "false");
  assert.equal(dom.debugActionsEl.hidden, true);
  assert.equal(dom.debugOutputContentEl.hidden, true);

  dom.debugToggleEl.click();
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
  assert.equal(dom.debugActionsEl.hidden, false);
  assert.equal(dom.debugOutputContentEl.hidden, false);

  dom.debugToggleEl.click();
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "false");
  assert.equal(dom.debugActionsEl.hidden, true);
  assert.equal(dom.debugOutputContentEl.hidden, true);
});

test("routine logs stay folded but explicitly reported errors expand the panel", () => {
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom });
  log.bindEvents();

  log.logDebug("Loaded error.csv without errors.");
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "false");

  log.logError("Driver import failed");
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
  assert.equal(dom.debugActionsEl.hidden, false);
  assert.equal(dom.debugOutputContentEl.hidden, false);

  dom.debugToggleEl.click();
  log.logError("Worker stopped");
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
  assert.equal(dom.debugActionsEl.hidden, false);
  assert.equal(dom.debugOutputContentEl.hidden, false);
});

test("a delayed clipboard failure reopens a panel collapsed while copying", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        async writeText() {
          throw new Error("Clipboard permission denied");
        },
      },
    },
  });

  try {
    const dom = fakeDebugDom();
    const log = createDebugLog({ dom });
    log.bindEvents();
    dom.debugToggleEl.click();

    const copying = log.copyToClipboard();
    dom.debugToggleEl.click();
    assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "false");

    await copying;
    assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
    assert.match(dom.debugOutputEl.value, /DEBUG COPY ERROR/);
    assert.match(dom.debugOutputEl.value, /Clipboard permission denied/);
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

// One failure must produce one Sentry event. A failed runtime bootstrap is
// reported as a runtime crash by web/js/runtime-rpc.ts and then returns through
// whichever action was in flight, so reportActionError sees it a second time.

function makeSentrySdk() {
  const captured = [];
  return {
    captured,
    init() {},
    withScope(fn) {
      const tags = {};
      this.pendingTags = tags;
      fn({ setTag: (key, value) => { tags[key] = value; } });
      this.pendingTags = null;
    },
    captureException(error) {
      captured.push({ error, tags: this.pendingTags || {} });
    },
  };
}

function makeSentryWindow() {
  return {
    location: { hostname: "codeplug.org" },
    addEventListener() {},
    removeEventListener() {},
  };
}

test("a bootstrap failure returning through an action is captured only once", async () => {
  resetSentryForTests();
  const sdk = makeSentrySdk();
  await initSentry(makeSentryWindow(), { loadSdk: async () => sdk });

  const log = createDebugLog({ dom: fakeDebugDom() });

  // What web/js/runtime-rpc.ts rethrows once it has already reported the crash.
  const crash = markBootstrapFailure(new Error("RuntimeError: seeding failed"));
  log.reportActionError("Download", crash);

  assert.equal(sdk.captured.length, 0, "the crash was already captured as a runtime crash");
  // The user still has to be told which action died.
  assert.match(String(log.getLastErrorSummary()), /seeding failed/);
  resetSentryForTests();
});

test("an ordinary action failure is still captured by the action funnel", async () => {
  resetSentryForTests();
  const sdk = makeSentrySdk();
  await initSentry(makeSentryWindow(), { loadSdk: async () => sdk });

  const log = createDebugLog({ dom: fakeDebugDom() });
  log.reportActionError("Download", new Error("Failed to fetch"));

  assert.equal(sdk.captured.length, 1);
  assert.equal(sdk.captured[0].error.message, "Failed to fetch");
  resetSentryForTests();
});

test("runtime errors keep their message through debug output and Sentry when stacks omit it", async (t) => {
  const { createRuntimeRpcClient } = await import("../../web/js/runtime-rpc.ts?error-reporting-test");
  const original = new Error("Traceback (most recent call last):\nchirp.errors.InvalidDataError: No channels found");
  original.name = "PythonError";
  original.stack = "new_error@pyodide.asm.js:10:10028\n307@wasm-function[307]";
  // Use a separate module instance, and clear its callbacks on completion.
  // Fail argument conversion inside a real handler, before interpreter boot,
  // so the test cannot depend on catalog-fetch fallback ordering.
  t.after(() => createRuntimeRpcClient({}));
  const payload = { sessionId: { toString() { throw original; } } };
  resetSentryForTests();
  t.after(resetSentryForTests);
  const sdk = makeSentrySdk();
  await initSentry(makeSentryWindow(), { loadSdk: async () => sdk });
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom });
  const runtimeLines = [];
  const runtime = createRuntimeRpcClient({ logDebug: (line) => runtimeLines.push(line) });
  await assert.rejects(runtime.closeRadioSession(payload), (error) => {
    assert.equal(error, original);
    assert.equal(error.message, original.message);
    assert.equal(error.stack, original.stack);
    log.reportActionError("Import CSV", error);
    return true;
  });
  assert.ok(runtimeLines.some((line) => line.includes(original.message) && line.includes(original.stack)));
  assert.ok(dom.debugOutputEl.value.includes(original.message));
  assert.ok(dom.debugOutputEl.value.includes(original.stack));
  assert.equal(sdk.captured.length, 1);
  const sent = sdk.captured[0].error;
  assert.equal(sent, original);
  assert.equal(sent.message, original.message);
  assert.ok(!sent.message.includes("wasm-function"));
  assert.equal(sent.stack, original.stack);
  assert.notEqual(initOptions().beforeSend({}, { originalException: sent }), null,
    "a native failure outside typed RPC is not classified from traceback text");
});

test("input the form rejected is shown to the user and never captured", async () => {
  resetSentryForTests();
  const sdk = makeSentrySdk();
  await initSentry(makeSentryWindow(), { loadSdk: async () => sdk });

  const shown = [];
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom, notice: { show: (options) => shown.push(options) } });
  log.reportActionRejected("RSGB ETCC query", new Error("Set a location first."));

  // The whole point: a form the user can fix reaches them as an instruction,
  // not a defect. Nothing is filed, and the debug panel is not thrown open in
  // their face the way a real failure throws it.
  assert.equal(sdk.captured.length, 0, "an unfilled form is not a Sentry event");
  assert.deepEqual(shown.map((options) => options.message), ["Set a location first."]);
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "false");
  // The panel still has all of it, which is the rule that holds for every
  // failure however it is surfaced.
  assert.match(String(dom.debugOutputEl.value), /RSGB ETCC QUERY BLOCKED/);
  resetSentryForTests();
});

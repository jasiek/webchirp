import assert from "node:assert/strict";
import test from "node:test";

import { createDebugLog } from "../web/js/ui/debug-log.js";
import { initSentry, resetSentryForTests } from "../web/js/sentry.js";
import { markBootstrapFailure } from "../web/js/runtime-bootstrap.mjs";

class FakeElement {
  constructor({ hidden = false } = {}) {
    this.attributes = new Map();
    this.hidden = hidden;
    this.listeners = new Map();
    this.value = "";
  }

  addEventListener(type, handler) {
    this.listeners.set(String(type), handler);
  }

  click() {
    this.listeners.get("click")?.();
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  focus() {}

  select() {}
}

function fakeDom() {
  const debugToggleEl = new FakeElement();
  debugToggleEl.setAttribute("aria-expanded", "false");
  return {
    debugToggleEl,
    debugActionsEl: new FakeElement({ hidden: true }),
    debugOutputContentEl: new FakeElement({ hidden: true }),
    debugOutputEl: new FakeElement(),
    debugClearEl: new FakeElement(),
    debugCopyEl: new FakeElement(),
  };
}

test("debug output is folded initially and toggles both hidden regions together", () => {
  const dom = fakeDom();
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
  const dom = fakeDom();
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
    const dom = fakeDom();
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
// reported as a runtime crash by runtime-rpc.js and then returns through
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

  const log = createDebugLog({ dom: fakeDom() });

  // What runtime-rpc.js rethrows once it has already reported the crash.
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

  const log = createDebugLog({ dom: fakeDom() });
  log.reportActionError("Download", new Error("Failed to fetch"));

  assert.equal(sdk.captured.length, 1);
  assert.equal(sdk.captured[0].error.message, "Failed to fetch");
  resetSentryForTests();
});

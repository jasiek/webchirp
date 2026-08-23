import assert from "node:assert/strict";
import test from "node:test";

import { createDebugLog } from "../web/js/ui/debug-log.js";

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

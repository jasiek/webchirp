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

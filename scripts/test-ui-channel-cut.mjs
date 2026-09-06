import assert from "node:assert/strict";
import test from "node:test";

// UI-level regression test for Cut with an async clipboard write: the rows
// deleted must be the rows that were serialized, not whatever is selected
// when the (possibly permission-gated) write finally resolves.
//
// Self-contained fake DOM: every selector resolves to an element so
// createUiController/init can run headless; elements record listeners and
// support dispatchEvent for driving clicks.
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.eventListeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.type = "";
    this.title = "";
    this._value = "";
    this._textContent = "";
    this._innerHTML = "";
  }

  get value() {
    if (this.tagName === "SELECT" && !this._value) {
      return this.children[0]?.value || "";
    }
    return this._value;
  }

  set value(next) {
    this._value = String(next ?? "");
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(next) {
    this._textContent = String(next ?? "");
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(next) {
    this._innerHTML = String(next ?? "");
    this.children = [];
    this._value = "";
  }

  setAttribute(name, val) {
    this.attributes.set(String(name), String(val));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === "SELECT" && !this._value) {
      this._value = child.value || "";
    }
    return child;
  }

  // The channel grid delegates cell events to the tbody, so a dispatched event
  // has to be resolvable back to its cell the same way the browser does it.
  matches(selector) {
    if (selector.startsWith(".")) {
      return this.className === selector.slice(1);
    }
    const attribute = selector.match(/^(\w+)\[data-([\w-]+)\]$/);
    if (attribute) {
      const [, tag, name] = attribute;
      return this.tagName === tag.toUpperCase() && this.dataset[name] !== undefined;
    }
    return false;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key).push(handler);
  }

  dispatchEvent(event) {
    for (const handler of this.eventListeners.get(String(event?.type || "")) || []) {
      handler(event);
    }
  }

  contains() {
    return false;
  }

  click() {}

  focus() {}

  querySelector() {
    return null;
  }

  querySelectorAll(selector) {
    if (selector === "tr") {
      return this.children.filter((child) => child.tagName === "TR");
    }
    return [];
  }
}

function installFakeDom() {
  const elements = new Map();
  const tagFor = (selector) =>
    selector.includes("select") || selector === "#radio-make" || selector === "#radio-model"
      ? "select"
      : "div";
  const document = {
    cookie: "",
    querySelector(selector) {
      const key = String(selector);
      if (!elements.has(key)) {
        elements.set(key, new FakeElement(tagFor(key)));
      }
      return elements.get(key);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener() {},
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener() {}, open() {}, getSelection: () => null },
  });
  const navigator = { userAgent: "FakeBrowser/1.0", language: "en-US", appVersion: "FakeBrowser/1.0" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value) => String(value) },
  });
  return { document, navigator };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

const SAMPLE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
  { Location: "2", Name: "Charlie", Frequency: "446.000000" },
];

// Drive the Import CSV path the way the file picker does: hand the hidden
// input a file and fire the change event it listens for.
async function importSampleCsv(document) {
  const fileInput = document.querySelector("#csv-file");
  fileInput.files = [{ name: "sample.csv", text: async () => "" }];
  fileInput.dispatchEvent({ type: "change" });
  await flushMicrotasks();
}

// The grid renders spacer rows around the windowed channel rows, so the
// channel rows are the ones carrying a row index.
function channelRows(document) {
  const tbody = document.querySelector("#mem-table tbody");
  return tbody.children.filter((tr) => tr.dataset.rowIdx !== undefined);
}

function tableNames(document) {
  return channelRows(document).map((tr) => tr.children[1]?.children[0]?.value ?? "");
}

// Cell events are delegated to the tbody; dispatch there with the button as
// the target, which is what bubbling gives the handler in a real browser.
function clickLocationButton(document, rowIdx) {
  const tbody = document.querySelector("#mem-table tbody");
  const button = channelRows(document)[rowIdx].children[0].children[0];
  tbody.dispatchEvent({
    type: "click",
    target: button,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
  });
}

test("cut deletes the rows captured at copy time, not the selection at write completion", async () => {
  const { document, navigator } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name", "Frequency"], columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: ["Location", "Name", "Frequency"], rows: SAMPLE_ROWS, errors: [] }),
  });

  // init() leaves the grid empty, so the channels these assertions operate on
  // come from a CSV import (the stubbed parser returns SAMPLE_ROWS whatever
  // the file holds).
  await ui.init(true);
  await importSampleCsv(document);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Charlie"]);

  // Select Alpha, then trigger Cut; the clipboard write stays pending as if
  // parked behind a browser permission prompt.
  clickLocationButton(document, 0);
  const write = createDeferred();
  navigator.clipboard = { writeText: () => write.promise };
  document.querySelector("#channel-cut").dispatchEvent({ type: "click" });
  await flushMicrotasks();
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Charlie"]);

  // While the write is pending, the user selects Charlie instead.
  clickLocationButton(document, 2);

  write.resolve();
  await flushMicrotasks();

  // Alpha (the row that was serialized) is gone; Charlie survives.
  assert.deepEqual(tableNames(document), ["Bravo", "Charlie"]);
});

// Regression: radios with has_tuning_step=False (e.g. Baofeng UV-5R) mark
// TStep read-only; paste must still restore the copied value instead of
// silently resetting it to the first enum option.
test("paste preserves read-only column values and matches unpadded numeric enums", async () => {
  const { document, navigator } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();

  const headers = ["Location", "Name", "Frequency", "TStep"];
  const columns = {
    TStep: {
      kind: "enum",
      editable: false,
      options: ["2.50", "5.00", "6.25", "10.00", "12.50", "25.00"],
    },
  };
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers, columns }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers, rows: [], errors: [] }),
  });

  await ui.init(true);
  // The app boots with no radio selected, so pick one the way a user does --
  // a make lists its models, a model chooses the radio. The column metadata
  // this test relies on is the selected driver's.
  const radioMakeEl = document.querySelector("#radio-make");
  const radioModelEl = document.querySelector("#radio-model");
  radioMakeEl.value = "Acme";
  radioMakeEl.dispatchEvent({ type: "change" });
  radioModelEl.value = "one:OneRadio";
  radioModelEl.dispatchEvent({ type: "change" });
  await flushMicrotasks();

  // Header-mapped TSV as produced by Copy (TStep "5.00") plus a
  // spreadsheet-style unpadded value ("12.5") that must match "12.50".
  const tsv =
    "Name\tFrequency\tTStep\n" +
    "Alpha\t146.520000\t5.00\n" +
    "Bravo\t146.940000\t12.5\n";
  navigator.clipboard = { readText: async () => tsv };
  document.querySelector("#channel-paste").dispatchEvent({ type: "click" });
  await flushMicrotasks();

  const tstepValues = channelRows(document).map((tr) => tr.children[3]?.children[0]?.value ?? "");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo"]);
  assert.deepEqual(tstepValues, ["5.00", "12.50"]);
});

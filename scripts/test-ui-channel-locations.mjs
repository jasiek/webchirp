import assert from "node:assert/strict";
import test from "node:test";

// Regression tests for Location semantics in the channel grid
// (https://github.com/jasiek/webchirp/issues/73). A Location is the memory
// slot a channel occupies, not its position in the list: codeplugs read from
// a radio are routinely sparse, and 147 of CHIRP's driver call sites number
// memories from 1 rather than 0. Editing the grid must therefore leave the
// slots of untouched channels alone.
//
// Self-contained fake DOM, matching scripts/test-ui-channel-cut.mjs.
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


// The UV-5R test image's real shape, trimmed: two low channels, then gaps.
// chirp/tests/images/Baofeng_UV-5R.img fills 37 of 128 slots this way.
const SPARSE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
  { Location: "25", Name: "HTAC1", Frequency: "443.000000" },
  { Location: "26", Name: "HTAC2", Frequency: "147.380000" },
  { Location: "124", Name: "VCALL", Frequency: "155.750000" },
];

const HEADERS = ["Location", "Name", "Frequency"];

function tableLocations(document) {
  return channelRows(document).map((tr) => tr.children[0]?.children[0]?.textContent ?? "");
}

// Boot the UI with a stubbed runtime whose driver reports `bounds` as the
// Location column's range, then load `rows` through the CSV import path.
async function bootWithRows(rows, bounds = { min: 0, max: 127 }) {
  const { document, navigator } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  const columns = { Location: { kind: "int", editable: false, ...bounds } };
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: rows.map((row) => ({ ...row })), errors: [] }),
  });
  await ui.init(true);
  const fileInput = document.querySelector("#csv-file");
  fileInput.files = [{ name: "sample.csv", text: async () => "" }];
  fileInput.dispatchEvent({ type: "change" });
  await flushMicrotasks();
  return { document, navigator, ui };
}

function click(document, selector) {
  document.querySelector(selector).dispatchEvent({ type: "click" });
}

test("a sparse codeplug loads with the radio's own memory numbering", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  // The gaps are the radio's, not a bug: nothing renumbers on load.
  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124"]);
});

test("insert takes the lowest free memory and leaves every other channel in place", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 2);
  click(document, "#channel-insert");
  await flushMicrotasks();

  // The blank row lands at index 2 and claims memory 2 — the first one free.
  // Before the fix this renumbered the list to 0-5, moving HTAC1 off 25 and
  // dropping VCALL from 124 entirely.
  assert.deepEqual(tableLocations(document), ["0", "1", "2", "25", "26", "124"]);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "", "HTAC1", "HTAC2", "VCALL"]);
});

test("insert on a 1-based radio never allocates memory 0", async () => {
  // 147 driver call sites use a lower bound of 1. Allocating 0 for them made
  // the upload fail mid-clone with "Location 0 is outside radio memory bounds".
  const { document } = await bootWithRows(
    [
      { Location: "1", Name: "Alpha", Frequency: "146.520000" },
      { Location: "3", Name: "Bravo", Frequency: "146.940000" },
    ],
    { min: 1, max: 128 },
  );
  clickLocationButton(document, 0);
  click(document, "#channel-insert");
  await flushMicrotasks();

  assert.deepEqual(tableLocations(document), ["2", "1", "3"]);
});

test("removing a channel frees its memory and moves no other channel", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 1);
  click(document, "#channel-remove");
  await flushMicrotasks();

  assert.deepEqual(tableLocations(document), ["0", "25", "26", "124"]);
  assert.deepEqual(tableNames(document), ["Alpha", "HTAC1", "HTAC2", "VCALL"]);
});

test("move swaps two channels' memories instead of renumbering the codeplug", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 2);
  click(document, "#channel-move-up");
  await flushMicrotasks();

  // HTAC1 and Bravo trade slots; the occupied set is untouched, so the
  // codeplug stays as sparse as the radio had it.
  assert.deepEqual(tableNames(document), ["Alpha", "HTAC1", "Bravo", "HTAC2", "VCALL"]);
  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124"]);
});

test("paste-overwrite gives pasted channels the memory they overwrite", async () => {
  const { document, navigator } = await bootWithRows(SPARSE_ROWS);
  // Locations in the clipboard belong to whatever codeplug it was copied
  // from; the destination slot has to win.
  navigator.clipboard = {
    readText: async () => "Location\tName\tFrequency\n7\tNew1\t145.000000\n8\tNew2\t145.100000\n",
  };
  let confirmed = "";
  window.confirm = (message) => {
    confirmed = message;
    return true;
  };
  clickLocationButton(document, 2);
  click(document, "#channel-paste");
  await flushMicrotasks();

  // The prompt names the memories being overwritten, so it has to report the
  // real slots rather than the row positions.
  assert.match(confirmed, /channels 25, 26/);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "New1", "New2", "VCALL"]);
  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124"]);
});

test("paste past the end of the list allocates free memories", async () => {
  const { document, navigator } = await bootWithRows(SPARSE_ROWS);
  navigator.clipboard = {
    readText: async () => "Name\tFrequency\nNew1\t145.000000\nNew2\t145.100000\n",
  };
  click(document, "#channel-paste");
  await flushMicrotasks();

  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124", "2", "3"]);
});

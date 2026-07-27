import assert from "node:assert/strict";
import test from "node:test";

import { classifyLoadableFile } from "../web/js/ui/codeplug-io.js";

// Drag-and-drop file loading is wired to window-level drag events, so the fake
// DOM here records window listeners and lets tests dispatch synthetic drag
// events at them. Everything else is auto-vivified: these tests only assert on
// the drop overlay, the status line and which runtime loader ran.
class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.classes.add(String(token)));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.classes.delete(String(token)));
  }

  toggle(token, force) {
    const key = String(token);
    if (force === true) {
      this.classes.add(key);
      return true;
    }
    if (force === false) {
      this.classes.delete(key);
      return false;
    }
    if (this.classes.has(key)) {
      this.classes.delete(key);
      return false;
    }
    this.classes.add(key);
    return true;
  }

  contains(token) {
    return this.classes.has(String(token));
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.eventListeners = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.type = "";
    this.title = "";
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
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
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  appendChild(child) {
    this.children.push(child);
    if (this.tagName === "SELECT" && !this._value) {
      this._value = child.value || "";
    }
    return child;
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

  querySelectorAll() {
    return [];
  }
}

// Collects window listeners so tests can fire drag events and await whatever
// async work the handler kicks off. emit() resolves to whether any handler
// called preventDefault(), which is what decides between "the app takes this
// drag" and "the browser navigates away from the app".
function createFakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      const key = String(type);
      if (!listeners.has(key)) {
        listeners.set(key, []);
      }
      listeners.get(key).push(handler);
    },
    open() {},
    getSelection: () => null,
    async emit(type, event) {
      let defaultPrevented = false;
      for (const handler of listeners.get(String(type)) || []) {
        await handler({
          ...event,
          type,
          preventDefault() {
            defaultPrevented = true;
          },
        });
      }
      return defaultPrevented;
    },
  };
}

function installFakeDom() {
  const elements = new Map();
  const document = {
    cookie: "",
    querySelector(selector) {
      const key = String(selector);
      if (!elements.has(key) && key.startsWith("#")) {
        elements.set(key, new FakeElement(key.includes("select") ? "select" : "div"));
      }
      return elements.get(key) || null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener() {},
  };

  const window = createFakeWindow();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "FakeBrowser/1.0", language: "en-US", appVersion: "FakeBrowser/1.0" },
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value) => String(value) },
  });

  return {
    window,
    dropOverlayEl: document.querySelector("#drop-overlay"),
    debugOutputEl: document.querySelector("#debug-output"),
    importChoiceModalEl: document.querySelector("#import-choice-modal"),
    importChoiceMergeEl: document.querySelector("#import-choice-merge"),
  };
}

// Let every already-resolved promise in the load chain settle.
function flushAsync() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const CATALOG = [
  {
    vendor: "Acme",
    model: "Alpha",
    module: "alpha",
    className: "AlphaRadio",
    key: "alpha:AlphaRadio",
    isLiveRadio: false,
  },
];

// Records which loader a drop reached and with what payload.
function createRuntimeApi() {
  const calls = { parseCsv: [], loadImage: [] };
  return {
    calls,
    api: {
      listRadios: async () => ({ radios: CATALOG }),
      getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
      getRadioMetadata: async () => ({ headers: ["Location", "Name", "Frequency"], columns: {} }),
      getRadioSettings: async () => ({
        supported: false,
        available: false,
        requiresImage: false,
        message: "",
        groups: [],
      }),
      parseCsv: async ({ csvText }) => {
        calls.parseCsv.push(csvText);
        // The built-in sample that init() loads parses to nothing, so the
        // editor starts empty and each test decides for itself whether a drop
        // has real channels to displace.
        const isBuiltInSample = csvText.includes("Simplex1");
        return {
          headers: ["Location", "Name", "Frequency"],
          rows: isBuiltInSample
            ? []
            : [{ Location: "0", Name: "Dropped", Frequency: "145.500000" }],
          errors: [],
        };
      },
      loadImage: async ({ imageBase64 }) => {
        calls.loadImage.push(imageBase64);
        return {
          module: "alpha",
          className: "AlphaRadio",
          vendor: "Acme",
          model: "Alpha",
          headers: ["Location", "Name", "Frequency"],
          rows: [{ Location: "0", Name: "FromImg", Frequency: "146.000000" }],
          settings: [],
        };
      },
    },
  };
}

function fakeFile(name, { text = "", bytes = [1, 2, 3] } = {}) {
  return {
    name,
    text: async () => text,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

function dropEvent(files) {
  return { dataTransfer: { types: ["Files"], files } };
}

async function bootUi() {
  const { calls, api } = createRuntimeApi();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi(api);
  // init() loads the built-in sample CSV, which routes through parseCsv too;
  // drop the record of it so assertions only see what the drop caused.
  await ui.init(true);
  calls.parseCsv.length = 0;
  return { ui, calls };
}

test("dropping a CSV file loads its channels through the CSV parser", async () => {
  const { window, debugOutputEl } = installFakeDom();
  const { calls } = await bootUi();

  await window.emit("drop", dropEvent([fakeFile("channels.csv", { text: "Location,Name\n0,A\n" })]));

  assert.equal(calls.parseCsv.length, 1);
  assert.match(calls.parseCsv[0], /Location,Name/);
  assert.equal(calls.loadImage.length, 0);
  assert.match(debugOutputEl.value, /STATUS Loaded 1 channel\(s\)/);
});

test("dropping an .img file loads it through the binary codeplug loader", async () => {
  const { window, debugOutputEl } = installFakeDom();
  const { calls } = await bootUi();

  await window.emit("drop", dropEvent([fakeFile("codeplug.img", { bytes: [0xff, 0x00, 0x42] })]));

  assert.equal(calls.loadImage.length, 1);
  assert.equal(calls.parseCsv.length, 0);
  // The .img bytes reach the runtime base64-encoded, not as a CSV parse.
  assert.equal(calls.loadImage[0], Buffer.from([0xff, 0x00, 0x42]).toString("base64"));
  assert.match(debugOutputEl.value, /STATUS Loaded binary codeplug for Acme Alpha/);
});

test("a dropped CSV goes through the same replace-or-merge prompt as Import CSV", async () => {
  const { window, debugOutputEl, importChoiceModalEl, importChoiceMergeEl } = installFakeDom();
  await bootUi();
  importChoiceModalEl.classList.add("hidden");

  // First drop fills the editor, so the second one has channels to displace.
  await window.emit("drop", dropEvent([fakeFile("first.csv", { text: "Location,Name\n0,A\n" })]));
  assert.equal(importChoiceModalEl.classList.contains("hidden"), true);

  const pending = window.emit("drop", dropEvent([fakeFile("second.csv", { text: "Location,Name\n0,B\n" })]));
  await flushAsync();
  assert.equal(
    importChoiceModalEl.classList.contains("hidden"),
    false,
    "a drop that would discard channels must ask first",
  );
  importChoiceMergeEl.dispatchEvent({ type: "click" });
  await pending;

  assert.match(debugOutputEl.value, /STATUS Merged 1 imported channel\(s\); 2 total/);
});

test("a drop is refused while an earlier load is still waiting on the prompt", async () => {
  const { window, debugOutputEl, importChoiceModalEl, importChoiceMergeEl } = installFakeDom();
  const { calls } = await bootUi();
  importChoiceModalEl.classList.add("hidden");

  await window.emit("drop", dropEvent([fakeFile("first.csv", { text: "Location,Name\n0,A\n" })]));
  const pending = window.emit("drop", dropEvent([fakeFile("second.csv", { text: "Location,Name\n0,B\n" })]));
  await flushAsync();
  assert.equal(importChoiceModalEl.classList.contains("hidden"), false);

  // Starting a third load here would overwrite second.csv's pending choice and
  // leave its promise unresolved forever.
  await window.emit("drop", dropEvent([fakeFile("third.csv", { text: "Location,Name\n0,C\n" })]));
  assert.match(debugOutputEl.value, /STATUS A file is already loading/);
  assert.equal(calls.parseCsv.length, 2, "third.csv must not reach the parser");

  // The refused drop must not have disturbed the load it collided with.
  importChoiceMergeEl.dispatchEvent({ type: "click" });
  await pending;
  assert.match(debugOutputEl.value, /STATUS Merged 1 imported channel\(s\); 2 total/);
});

test("dropping several files loads the first and records the rest as ignored", async () => {
  const { window, debugOutputEl } = installFakeDom();
  const { calls } = await bootUi();

  await window.emit("drop", dropEvent([
    fakeFile("first.csv", { text: "Location,Name\n0,A\n" }),
    fakeFile("second.csv", { text: "Location,Name\n0,B\n" }),
    fakeFile("third.img"),
  ]));

  assert.equal(calls.parseCsv.length, 1);
  assert.equal(calls.loadImage.length, 0);
  assert.match(debugOutputEl.value, /DROP first\.csv; ignoring 2 other file\(s\)/);
});

test("file drags are claimed from the browser, other drags are not", async () => {
  const { window } = installFakeDom();
  await bootUi();
  const fileDrag = { dataTransfer: { types: ["Files"] } };
  const textDrag = { dataTransfer: { types: ["text/plain"] } };

  // An unprevented dragover default means "not a drop target": the drop event
  // never fires and the browser navigates to the file instead.
  assert.equal(await window.emit("dragover", fileDrag), true);
  assert.equal(await window.emit("dragenter", fileDrag), true);
  assert.equal(await window.emit("drop", dropEvent([fakeFile("channels.csv", { text: "Location\n0\n" })])), true);

  assert.equal(await window.emit("dragover", textDrag), false, "text drags must keep native behaviour");
  assert.equal(await window.emit("dragenter", textDrag), false);
  assert.equal(await window.emit("drop", { dataTransfer: { types: ["text/plain"], files: [] } }), false);
});

test("dropping an unsupported file loads nothing and says what is accepted", async () => {
  const { window, debugOutputEl } = installFakeDom();
  const { calls } = await bootUi();

  await window.emit("drop", dropEvent([fakeFile("notes.txt", { text: "hello" })]));

  assert.equal(calls.parseCsv.length, 0);
  assert.equal(calls.loadImage.length, 0);
  assert.match(debugOutputEl.value, /notes\.txt/);
  assert.match(debugOutputEl.value, /\.csv/);
  assert.match(debugOutputEl.value, /\.img/);
});

test("the drop overlay follows the drag and clears on drop", async () => {
  const { window, dropOverlayEl } = installFakeDom();
  await bootUi();
  const overlayVisible = () => !dropOverlayEl.classList.contains("hidden");

  // The page starts with the overlay hidden by its markup class.
  dropOverlayEl.classList.add("hidden");
  assert.equal(overlayVisible(), false);

  // Nested enters (page, then a child element) must not require matching
  // leaves to be interleaved for the overlay to survive.
  await window.emit("dragenter", { dataTransfer: { types: ["Files"] } });
  await window.emit("dragenter", { dataTransfer: { types: ["Files"] } });
  assert.equal(overlayVisible(), true);
  await window.emit("dragleave", { dataTransfer: { types: ["Files"] } });
  assert.equal(overlayVisible(), true, "leaving a child element must keep the overlay up");
  await window.emit("dragleave", { dataTransfer: { types: ["Files"] } });
  assert.equal(overlayVisible(), false);

  await window.emit("dragenter", { dataTransfer: { types: ["Files"] } });
  assert.equal(overlayVisible(), true);
  await window.emit("drop", dropEvent([fakeFile("channels.csv", { text: "Location\n0\n" })]));
  assert.equal(overlayVisible(), false);
});

test("a text-only drag is left to the browser", async () => {
  const { window, dropOverlayEl } = installFakeDom();
  const { calls } = await bootUi();
  dropOverlayEl.classList.add("hidden");

  await window.emit("dragenter", { dataTransfer: { types: ["text/plain"] } });
  assert.equal(dropOverlayEl.classList.contains("hidden"), true);

  await window.emit("drop", { dataTransfer: { types: ["text/plain"], files: [] } });
  assert.equal(calls.parseCsv.length, 0);
  assert.equal(calls.loadImage.length, 0);
});

test("file kinds are classified by extension, case-insensitively", () => {
  assert.equal(classifyLoadableFile("channels.csv"), "csv");
  assert.equal(classifyLoadableFile("CHANNELS.CSV"), "csv");
  assert.equal(classifyLoadableFile("radio.img"), "img");
  assert.equal(classifyLoadableFile("Baofeng_UV-5R_20240101.IMG"), "img");
  assert.equal(classifyLoadableFile("dotted.name.csv"), "csv");
  assert.equal(classifyLoadableFile("notes.txt"), null);
  assert.equal(classifyLoadableFile("csv"), null);
  assert.equal(classifyLoadableFile(""), null);
  assert.equal(classifyLoadableFile(undefined), null);
});

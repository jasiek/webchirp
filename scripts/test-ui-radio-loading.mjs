import assert from "node:assert/strict";
import test from "node:test";

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
  constructor(tagName, ownerDocument, id = "") {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.eventListeners = new Map();
    this.classList = new FakeClassList();
    this._innerHTML = "";
    this._textContent = "";
    this._value = "";
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.checked = false;
    this.readOnly = false;
    this.type = "";
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    this._textContent = "";
    this._value = "";
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((child) => child.textContent).join("");
    }
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
    this._innerHTML = "";
  }

  get value() {
    if (this.tagName === "SELECT") {
      if (this._value) {
        return this._value;
      }
      return this.children[0]?.value || "";
    }
    return this._value;
  }

  set value(nextValue) {
    this._value = String(nextValue ?? "");
  }

  appendChild(child) {
    child.parentNode = this;
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
    const listeners = this.eventListeners.get(String(event?.type || "")) || [];
    for (const handler of listeners) {
      handler(event);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) || null;
  }

  contains(target) {
    if (target === this) {
      return true;
    }
    return this.children.some((child) => child.contains(target));
  }

  click() {}

  focus() {}

  querySelectorAll(selector) {
    if (selector === "tr") {
      return this.children.filter((child) => child.tagName === "TR");
    }
    return [];
  }

  querySelector() {
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.cookie = "";
    this.eventListeners = new Map();
  }

  register(selector, element) {
    this.elements.set(selector, element);
    return element;
  }

  querySelector(selector) {
    return this.elements.get(String(selector)) || null;
  }

  querySelectorAll(selector) {
    if (selector === ".left-panel select, .left-panel button, .left-panel input") {
      return Array.from(this.elements.values()).filter((element) =>
        ["SELECT", "BUTTON", "INPUT"].includes(element.tagName));
    }
    return [];
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key).push(handler);
  }
}

function registerElement(document, selector, tagName) {
  return document.register(selector, new FakeElement(tagName, document, selector.replace(/^#/, "")));
}

function installFakeDom() {
  const document = new FakeDocument();
  const selectors = new Map([
    ["#mem-table thead", "thead"],
    ["#mem-table tbody", "tbody"],
    ["#channel-editor", "div"],
    ["#settings-editor", "div"],
    ["#view-channels", "button"],
    ["#view-settings", "button"],
    ["#settings-tabs", "div"],
    ["#settings-summary", "div"],
    ["#settings-empty", "div"],
    ["#settings-content", "div"],
    ["#csv-file", "input"],
    ["#img-file", "input"],
    ["#debug-output", "textarea"],
    ["#report-issue", "button"],
    ["#webserial-support-warning", "p"],
    ["#live-radio-support-warning", "p"],
    ["#radio-make", "select"],
    ["#radio-model", "select"],
    ["#serial-connect-toggle", "button"],
    ["#radio-download", "button"],
    ["#radio-upload", "button"],
    ["#channel-insert", "button"],
    ["#channel-remove", "button"],
    ["#channel-menu-toggle", "button"],
    ["#channel-menu-popup", "div"],
    ["#channel-add-gmrs", "button"],
    ["#channel-add-frs", "button"],
    ["#channel-add-pmr446", "button"],
    ["#channel-import-przemienniki", "button"],
    ["#channel-import-repeaterbook", "button"],
    ["#przemienniki-modal", "div"],
    ["#przemienniki-form", "form"],
    ["#przemienniki-modal-title", "div"],
    ["#przemienniki-country", "select"],
    ["#przemienniki-band-list", "div"],
    ["#przemienniki-mode-list", "div"],
    ["#przemienniki-onlyworking", "input"],
    ["#przemienniki-latitude", "input"],
    ["#przemienniki-longitude", "input"],
    ["#przemienniki-range", "input"],
    ["#przemienniki-geolocate", "button"],
    ["#przemienniki-cancel", "button"],
    ["#load-sample", "button"],
    ["#import-csv", "button"],
    ["#export-csv", "button"],
    ["#export-binary", "button"],
    ["#import-binary", "button"],
    ["#serial-transaction", "button"],
    ["#tx-hex", "input"],
    ["#rx-bytes", "input"],
    ["#rx-timeout", "input"],
    ["#debug-clear", "button"],
  ]);

  for (const [selector, tagName] of selectors) {
    registerElement(document, selector, tagName);
  }

  const window = {
    addEventListener() {},
    open() {},
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "FakeBrowser/1.0",
      language: "en-US",
      appVersion: "FakeBrowser/1.0",
    },
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value) => String(value) },
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: FakeElement,
  });

  return {
    document,
    radioMakeEl: document.querySelector("#radio-make"),
    radioModelEl: document.querySelector("#radio-model"),
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("radio dropdowns show Loading... while CHIRP drivers are loading", async () => {
  const { radioMakeEl, radioModelEl } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const radioListDeferred = createDeferred();
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: () => radioListDeferred.promise,
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getRadioMetadata: async () => ({
      headers: ["Location", "Name"],
      columns: {},
    }),
    getRadioSettings: async () => ({
      supported: false,
      available: false,
      requiresImage: false,
      message: "No settings",
      groups: [],
    }),
    parseCsv: async () => ({
      headers: ["Location", "Name"],
      rows: [],
      errors: [],
    }),
  });

  const initPromise = ui.init(true);

  assert.equal(radioMakeEl.children.length, 1);
  assert.equal(radioModelEl.children.length, 1);
  assert.equal(radioMakeEl.children[0].textContent, "Loading...");
  assert.equal(radioModelEl.children[0].textContent, "Loading...");

  radioListDeferred.resolve({
    radios: [
      {
        vendor: "Acme",
        model: "Alpha",
        module: "alpha",
        className: "AlphaRadio",
        key: "alpha:AlphaRadio",
        isLiveRadio: false,
      },
      {
        vendor: "Acme",
        model: "Beta",
        module: "beta",
        className: "BetaRadio",
        key: "beta:BetaRadio",
        isLiveRadio: false,
      },
    ],
  });

  await initPromise;

  assert.deepEqual(
    radioMakeEl.children.map((option) => option.textContent),
    ["Acme"],
  );
  assert.deepEqual(
    radioModelEl.children.map((option) => option.textContent),
    ["Alpha", "Beta"],
  );
  assert.ok(!radioMakeEl.children.some((option) => option.textContent === "Loading..."));
  assert.ok(!radioModelEl.children.some((option) => option.textContent === "Loading..."));
});

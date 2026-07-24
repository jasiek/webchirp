import assert from "node:assert/strict";
import test from "node:test";

// Self-contained fake DOM so createUiController/init can run headless. Every
// selector resolves to an element; the repeater-API-base meta tag is
// registered per test so the configurable/disabled paths can be exercised.
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
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

function installFakeDom({ repeaterApiBase } = {}) {
  const elements = new Map();
  const tagFor = (selector) => (selector.includes("select") ? "select" : "div");
  const document = {
    cookie: "",
    querySelector(selector) {
      const key = String(selector);
      // Auto-vivify #id lookups so createUiController finds every element it
      // queries; non-id selectors (e.g. the meta tag) resolve to null unless
      // explicitly registered, matching a real absent element.
      if (!elements.has(key) && key.startsWith("#")) {
        elements.set(key, new FakeElement(tagFor(key)));
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

  // Register the meta tag only when a base is provided; omitting it leaves the
  // tag absent, which resolves to the built-in default (feature enabled).
  if (repeaterApiBase !== undefined) {
    const meta = new FakeElement("meta");
    meta.setAttribute("content", String(repeaterApiBase ?? ""));
    elements.set('meta[name="webchirp-repeater-api-base"]', meta);
  }

  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener() {}, open() {}, getSelection: () => null },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "FakeBrowser/1.0", language: "en-US", appVersion: "FakeBrowser/1.0" },
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value) => String(value) },
  });

  return {
    przemiennikiBtn: document.querySelector("#channel-import-przemienniki"),
    repeaterbookBtn: document.querySelector("#channel-import-repeaterbook"),
  };
}

const RUNTIME_API = {
  listRadios: async () => ({ radios: [] }),
  getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
  getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
  getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
  parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
};

async function bootUi() {
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi(RUNTIME_API);
  await ui.init(true);
  return ui;
}

test("online repeater-query buttons are hidden when the API base is blank", async () => {
  const { przemiennikiBtn, repeaterbookBtn } = installFakeDom({ repeaterApiBase: "" });
  await bootUi();
  assert.equal(przemiennikiBtn.hidden, true);
  assert.equal(repeaterbookBtn.hidden, true);
});

test("online repeater-query buttons stay visible with a configured API base", async () => {
  const { przemiennikiBtn, repeaterbookBtn } = installFakeDom({ repeaterApiBase: "https://proxy.example.com" });
  await bootUi();
  assert.equal(przemiennikiBtn.hidden, false);
  assert.equal(repeaterbookBtn.hidden, false);
});

test("online repeater-query buttons default to visible when no meta tag is present", async () => {
  const { przemiennikiBtn, repeaterbookBtn } = installFakeDom();
  await bootUi();
  assert.equal(przemiennikiBtn.hidden, false);
  assert.equal(repeaterbookBtn.hidden, false);
});

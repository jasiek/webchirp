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
  getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
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

test("coordinate edits fill the locator field once both halves are present", async () => {
  installFakeDom({ repeaterApiBase: "https://proxy.example.com" });
  await bootUi();
  const latEl = document.querySelector("#przemienniki-latitude");
  const lonEl = document.querySelector("#przemienniki-longitude");
  const locatorEl = document.querySelector("#przemienniki-locator");

  latEl.value = "52.2297";
  latEl.dispatchEvent({ type: "input" });
  // A lone latitude is not a position; Number("") would otherwise read the
  // blank longitude as 0 and encode a locator on the prime meridian.
  assert.equal(locatorEl.value, "");

  lonEl.value = "21.0122";
  lonEl.dispatchEvent({ type: "input" });
  assert.equal(locatorEl.value, "KO02MF");

  latEl.value = "";
  latEl.dispatchEvent({ type: "input" });
  assert.equal(locatorEl.value, "");
});

test("locator edits move the coordinates to the square's centre", async () => {
  installFakeDom({ repeaterApiBase: "https://proxy.example.com" });
  await bootUi();
  const latEl = document.querySelector("#przemienniki-latitude");
  const lonEl = document.querySelector("#przemienniki-longitude");
  const locatorEl = document.querySelector("#przemienniki-locator");

  locatorEl.value = "IO91WM";
  locatorEl.dispatchEvent({ type: "input" });
  assert.equal(latEl.value, "51.520833");
  assert.equal(lonEl.value, "-0.125000");

  // Lower case and 4-character precision both decode.
  locatorEl.value = "ko02";
  locatorEl.dispatchEvent({ type: "input" });
  assert.equal(latEl.value, "52.500000");
  assert.equal(lonEl.value, "21.000000");
});

test("partial or invalid locator text leaves the coordinates alone", async () => {
  installFakeDom({ repeaterApiBase: "https://proxy.example.com" });
  await bootUi();
  const latEl = document.querySelector("#przemienniki-latitude");
  const lonEl = document.querySelector("#przemienniki-longitude");
  const locatorEl = document.querySelector("#przemienniki-locator");

  latEl.value = "52.2297";
  lonEl.value = "21.0122";
  for (const text of ["", "I", "IO9", "99AB", "ZZ11"]) {
    locatorEl.value = text;
    locatorEl.dispatchEvent({ type: "input" });
    assert.equal(latEl.value, "52.2297", `coords survived "${text}"`);
    assert.equal(lonEl.value, "21.0122", `coords survived "${text}"`);
  }
});

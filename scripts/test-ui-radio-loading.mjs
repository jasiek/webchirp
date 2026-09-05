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

  scrollIntoView() {}

  matches(selector) {
    if (selector === "li[role='option']") {
      return this.tagName === "LI" && this.getAttribute("role") === "option";
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

  querySelectorAll(selector) {
    if (selector === "tr") {
      return this.children.filter((child) => child.tagName === "TR");
    }
    if (selector === "li[role='option']") {
      return this.children.filter((child) => child.matches(selector));
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

  // index.html always provides every element web/js/ui/dom.js requires, so an
  // unregistered selector stands for markup the test simply does not care
  // about — not a missing element. Auto-vivify it; tests register the specific
  // elements they assert on.
  querySelector(selector) {
    const key = String(selector);
    if (!this.elements.has(key)) {
      this.elements.set(key, new FakeElement("div", this));
    }
    return this.elements.get(key);
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

// Elements stubbed with a specific tag name, because the tag is load-bearing
// somewhere (sidebarControlEls filters on SELECT/BUTTON/INPUT). Anything else
// the UI queries auto-vivifies as a div. Every entry must still be an element
// dom.js declares — see the drift check at the bottom of this file.
const STUBBED_SELECTORS = new Map([
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
  ["#live-radio-support-warning", "p"],
  ["#radio-search", "input"],
  ["#radio-search-results", "ul"],
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
  ["#channel-import-irts", "button"],
  ["#repeater-query-form", "form"],
  ["#repeater-query-cancel", "button"],
  ["#import-csv", "button"],
  ["#export-csv", "button"],
  ["#export-binary", "button"],
  ["#import-binary", "button"],
  ["#debug-clear", "button"],
]);

function installFakeDom() {
  const document = new FakeDocument();

  for (const [selector, tagName] of STUBBED_SELECTORS) {
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
    radioSearchEl: document.querySelector("#radio-search"),
    radioSearchResultsEl: document.querySelector("#radio-search-results"),
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
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
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

test("search box shows narrowing make+model suggestions without touching dropdowns", async () => {
  const { radioSearchEl, radioSearchResultsEl, radioMakeEl, radioModelEl } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "Alpha", module: "alpha", className: "AlphaRadio", key: "alpha:AlphaRadio", isLiveRadio: false },
        { vendor: "Acme", model: "Beta", module: "beta", className: "BetaRadio", key: "beta:BetaRadio", isLiveRadio: false },
        { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5R", key: "uv5r:BaofengUV5R", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // A vendor query lists all of that vendor's models as "<Make> <Model>".
  radioSearchEl.value = "acme";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.equal(radioSearchResultsEl.hidden, false);
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["Acme Alpha", "Acme Beta"],
  );

  // A model query narrows the list to the matching radio.
  radioSearchEl.value = "uv-5r";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["Baofeng UV-5R"],
  );

  // Typing never narrows the make/model dropdowns themselves.
  assert.deepEqual(radioMakeEl.children.map((o) => o.textContent), ["Acme", "Baofeng"]);
  assert.deepEqual(radioModelEl.children.map((o) => o.textContent), ["Alpha", "Beta"]);

  // No matches shows an inert placeholder row.
  radioSearchEl.value = "nonesuch";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.deepEqual(radioSearchResultsEl.children.map((li) => li.textContent), ["No matching radios"]);
  assert.ok(radioSearchResultsEl.children[0].classList.contains("radio-search-empty"));

  // Clearing the box closes the suggestion list.
  radioSearchEl.value = "";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.equal(radioSearchResultsEl.hidden, true);
  assert.equal(radioSearchResultsEl.children.length, 0);
});

test("search suggestions disambiguate duplicates, cap results, and close on Escape", async () => {
  const { radioSearchEl, radioSearchResultsEl } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();

  // Two drivers sharing "Acme Twin" plus enough filler to exceed the 50-result cap.
  const radios = [
    { vendor: "Acme", model: "Twin", module: "twin_a", className: "TwinA", key: "twin_a:TwinA", isLiveRadio: false },
    { vendor: "Acme", model: "Twin", module: "twin_b", className: "TwinB", key: "twin_b:TwinB", isLiveRadio: false },
  ];
  for (let i = 0; i < 60; i += 1) {
    radios.push({
      vendor: "Bulk",
      model: `Filler${i}`,
      module: `filler${i}`,
      className: `Filler${i}Radio`,
      key: `filler${i}:Filler${i}Radio`,
      isLiveRadio: false,
    });
  }

  ui.setRuntimeApi({
    listRadios: async () => ({ radios }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // Duplicate "<Make> <Model>" labels are disambiguated by driver class.
  radioSearchEl.value = "twin";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["Acme Twin (TwinA)", "Acme Twin (TwinB)"],
  );

  // More than 50 matches: list is capped and a footer reports the overflow.
  radioSearchEl.value = "filler";
  radioSearchEl.dispatchEvent({ type: "input" });
  const optionItems = radioSearchResultsEl.querySelectorAll("li[role='option']");
  assert.equal(optionItems.length, 50);
  const footer = radioSearchResultsEl.children.at(-1);
  assert.ok(footer.classList.contains("radio-search-more"));
  assert.equal(footer.textContent, "10 more — keep typing to narrow down");

  // Escape closes the list without changing the input text.
  radioSearchEl.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(radioSearchResultsEl.hidden, true);
  assert.equal(radioSearchEl.value, "filler");
});

function tableHeaderTexts(document) {
  const headerRow = document.querySelector("#mem-table thead").children[0];
  return (headerRow?.children || []).map((th) => th.textContent);
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

const STALE_TEST_CATALOG = [
  { vendor: "Acme", model: "Alpha", module: "alpha", className: "AlphaRadio", key: "alpha:AlphaRadio", isLiveRadio: false },
  { vendor: "SlowCo", model: "Slow", module: "slow", className: "SlowRadio", key: "slow:SlowRadio", isLiveRadio: false },
  { vendor: "FastCo", model: "Fast", module: "fast", className: "FastRadio", key: "fast:FastRadio", isLiveRadio: false },
];

const EMPTY_SETTINGS = { supported: false, available: false, requiresImage: false, message: "", groups: [] };

test("stale metadata response does not overwrite a newer radio selection", async () => {
  const { radioMakeEl } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  const slowMetadata = createDeferred();

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async ({ module }) => {
      if (module === "slow") {
        return slowMetadata.promise;
      }
      const header = module === "fast" ? "FastHeader" : "AlphaHeader";
      return { headers: ["Location", header], columns: {} };
    },
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // Select the slow radio; its metadata response stays in flight.
  radioMakeEl.value = "SlowCo";
  radioMakeEl.dispatchEvent({ type: "change" });

  // Move on to the fast radio, whose metadata resolves immediately.
  radioMakeEl.value = "FastCo";
  radioMakeEl.dispatchEvent({ type: "change" });
  await flushMicrotasks();
  assert.ok(tableHeaderTexts(globalThis.document).includes("FastHeader"));

  // The slow radio's response arrives last; it must be discarded.
  slowMetadata.resolve({ headers: ["Location", "SlowHeader"], columns: {} });
  await flushMicrotasks();

  const headers = tableHeaderTexts(globalThis.document);
  assert.ok(headers.includes("FastHeader"));
  assert.ok(!headers.includes("SlowHeader"));
});

test("reselecting the loaded radio rejects partial loads in either completion order", async () => {
  const { createUiController } = await import("../web/js/ui.js");
  const settingsFor = (name) => ({
    supported: true,
    available: true,
    requiresImage: false,
    message: "",
    groups: [{ id: name, label: `${name} settings`, children: [] }],
  });

  for (const deferredPart of ["metadata", "settings"]) {
    const { radioMakeEl, radioModelEl } = installFakeDom();
    const ui = createUiController();
    const pending = createDeferred();
    const metadataCalls = [];
    const settingsCalls = [];
    const metadataFor = (name) => ({
      headers: ["Location", `${name}Header`],
      columns: {},
    });

    ui.setRuntimeApi({
      listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
      getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
      getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
      getRadioMetadata: async ({ module }) => {
        metadataCalls.push(module);
        return module === "slow" && deferredPart === "metadata"
          ? pending.promise
          : metadataFor(module);
      },
      getRadioSettings: async ({ module }) => {
        settingsCalls.push(module);
        return module === "slow" && deferredPart === "settings"
          ? pending.promise
          : settingsFor(module);
      },
      parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
    });

    await ui.init(true);
    // Startup does not mark its default as the last dropdown-loaded radio.
    // Complete Fast -> Alpha first so the final return to Alpha below must
    // take reloadForSelectedRadio()'s no-new-request path from issue #111.
    radioMakeEl.value = "FastCo";
    radioMakeEl.dispatchEvent({ type: "change" });
    await flushMicrotasks();
    radioMakeEl.value = "Acme";
    radioMakeEl.dispatchEvent({ type: "change" });
    await flushMicrotasks();

    assert.ok(tableHeaderTexts(globalThis.document).includes("alphaHeader"));
    assert.equal(globalThis.document.querySelector("#settings-tabs").textContent, "alpha settings");
    const alphaMetadataCalls = metadataCalls.filter((module) => module === "alpha").length;
    const alphaSettingsCalls = settingsCalls.filter((module) => module === "alpha").length;

    // One half of Slow's load resolves before the other. Returning to Alpha
    // must invalidate that work even though Alpha is already the last fully
    // loaded radio, regardless of which half arrived first.
    radioMakeEl.value = "SlowCo";
    radioMakeEl.dispatchEvent({ type: "change" });
    await flushMicrotasks();
    radioMakeEl.value = "Acme";
    radioMakeEl.dispatchEvent({ type: "change" });
    await flushMicrotasks();

    pending.resolve(
      deferredPart === "metadata" ? metadataFor("slow") : settingsFor("slow"),
    );
    await flushMicrotasks();

    const headers = tableHeaderTexts(globalThis.document);
    assert.equal(radioMakeEl.value, "Acme");
    assert.equal(radioModelEl.value, "alpha:AlphaRadio");
    assert.equal(metadataCalls.filter((module) => module === "alpha").length, alphaMetadataCalls);
    assert.equal(settingsCalls.filter((module) => module === "alpha").length, alphaSettingsCalls);
    assert.ok(headers.includes("alphaHeader"));
    assert.ok(!headers.includes("slowHeader"));
    assert.equal(globalThis.document.querySelector("#settings-tabs").textContent, "alpha settings");
  }
});

test("picking a search suggestion sets make/model and loads the radio once", async () => {
  const { radioSearchEl, radioSearchResultsEl, radioMakeEl, radioModelEl } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  const metadataCalls = [];

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async ({ module }) => {
      metadataCalls.push(module);
      return { headers: ["Location", "Name"], columns: {} };
    },
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);
  const callsAfterInit = metadataCalls.length;
  const noopKeyEvent = (key) => ({ type: "keydown", key, preventDefault() {}, stopPropagation() {} });

  // Typing only opens suggestions; no radio load happens yet.
  radioSearchEl.value = "slow";
  radioSearchEl.dispatchEvent({ type: "input" });
  radioSearchEl.value = "co";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.equal(metadataCalls.length, callsAfterInit);
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["SlowCo Slow", "FastCo Fast"],
  );

  // Arrow down highlights the second suggestion; Enter selects it.
  radioSearchEl.dispatchEvent(noopKeyEvent("ArrowDown"));
  radioSearchEl.dispatchEvent(noopKeyEvent("Enter"));
  await flushMicrotasks();

  assert.equal(radioMakeEl.value, "FastCo");
  assert.equal(radioModelEl.value, "fast:FastRadio");
  assert.equal(radioSearchEl.value, "FastCo Fast");
  assert.equal(radioSearchResultsEl.hidden, true);
  assert.equal(metadataCalls.length, callsAfterInit + 1);
  assert.equal(metadataCalls.at(-1), "fast");

  // Clicking a suggestion with the mouse selects it as well.
  radioSearchEl.value = "slow";
  radioSearchEl.dispatchEvent({ type: "input" });
  const slowItem = radioSearchResultsEl.children[0];
  radioSearchResultsEl.dispatchEvent({ type: "mousedown", target: slowItem, preventDefault() {} });
  await flushMicrotasks();

  assert.equal(radioMakeEl.value, "SlowCo");
  assert.equal(radioModelEl.value, "slow:SlowRadio");
  assert.equal(radioSearchEl.value, "SlowCo Slow");
  assert.equal(metadataCalls.at(-1), "slow");
});

// This file stubs a DOM for the UI to run against, so it can drift from the
// real page in a way index.html cannot: a stub for a deleted element keeps the
// test green while production has nothing there. It happened — the four
// #serial-transaction / #tx-hex / #rx-bytes / #rx-timeout stubs outlived the
// debug panel ff5607a removed, and nothing noticed. Pin the stub list to the
// element contract instead, so a removed id fails here as well as in
// test-dom-selectors.mjs.
test("every stubbed element is one dom.js actually declares", async () => {
  const { REQUIRED_ELEMENTS, ELEMENT_COLLECTIONS } = await import("../web/js/ui/dom.js");
  const declared = new Set([
    ...Object.values(REQUIRED_ELEMENTS),
    ...Object.values(ELEMENT_COLLECTIONS),
  ]);

  const orphaned = [...STUBBED_SELECTORS.keys()].filter((selector) => !declared.has(selector));
  assert.deepEqual(
    orphaned,
    [],
    "these selectors are stubbed but no longer required by the UI; the test is "
      + "asserting against a page shape production cannot have",
  );
});

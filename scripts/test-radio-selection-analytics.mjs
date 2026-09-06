import assert from "node:assert/strict";
import test from "node:test";

// What the radio picker reports, and when. The other UI tests run without a
// gtag, so every event they trigger is silently dropped; this file installs a
// recording gtag before the analytics module is imported so the events
// themselves can be asserted.
//
// Two rules are pinned here:
//   - Startup selects no radio, so nothing a first-time visitor does before
//     picking one is attributed to whichever radio sorts first in the catalog.
//   - A cookie restore is reported as radio_restored, not radio_selected: it
//     fires on every load a returning visitor makes, and counting it as a
//     selection weights the radio popularity reports by visit frequency.

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this._value = "";
    this._textContent = "";
  }

  // Mirrors how a real select resolves its value with nothing assigned: an
  // explicitly selected option wins, and otherwise the browser falls back to
  // the first ENABLED option. Returning children[0] regardless -- as this fake
  // used to -- hides the whole reason the placeholder carries selected as well
  // as disabled: without that flag a real select would skip the disabled
  // placeholder and report the first vendor, which is the implicit default
  // this PR removes.
  selectedValue() {
    if (this._value) {
      return this._value;
    }
    const selected = this.children.find((child) => child.selected);
    if (selected) {
      return selected.value || "";
    }
    return this.children.find((child) => !child.disabled)?.value || "";
  }

  get value() {
    if (this.tagName === "SELECT") {
      return this.selectedValue();
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
  }

  set innerHTML(next) {
    this._innerHTML = String(next ?? "");
    this.children = [];
    this._value = "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    this.listeners.set(String(type), handler);
  }

  dispatch(type, event = {}) {
    this.listeners.get(String(type))?.(event);
  }

  setAttribute() {}

  querySelectorAll() {
    return [];
  }
}

const CATALOG = [
  { vendor: "Abbree", model: "AR-518", module: "iradio_uv_5118", className: "AbbreeAR518Radio", key: "iradio_uv_5118:AbbreeAR518Radio", isLiveRadio: false },
  { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5R", key: "uv5r:BaofengUV5R", isLiveRadio: false },
];

// The globals the module graph reads at import time, installed once:
// web/js/analytics.js captures the window it reports through at module scope,
// so a window swapped in per test would never be the one events reach.
const events = [];
const fakeDocument = {
  cookie: "",
  createElement: (tagName) => new FakeElement(tagName),
};

Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    gtag: (kind, name, params) => events.push({ kind, name, params }),
    location: { hostname: "codeplug.org" },
    addEventListener() {},
  },
});

async function loadCatalog({ cookie = "" } = {}) {
  events.length = 0;
  fakeDocument.cookie = cookie;

  const dom = {
    radioMakeEl: new FakeElement("select"),
    radioModelEl: new FakeElement("select"),
    radioSearchEl: new FakeElement("input"),
    radioSearchResultsEl: new FakeElement("ul"),
  };
  const state = {
    runtimeApi: {
      getRadioMetadata: async () => ({ headers: [], columns: {} }),
    },
    radioCatalog: CATALOG,
    selectedRadio: null,
    radioMetadata: { headers: [], columns: {} },
    radioLoadSequence: 0,
    lastLoadedRadioKey: "",
    currentHeaders: [],
  };
  // Every refresh records the radio it would have gated the clone buttons on,
  // so a refresh that ran before the selection landed is visible to a test.
  const actionStates = [];
  const ctx = {
    dom,
    state,
    log: { logDebug() {} },
    actions: {
      updateSerialActionState() {
        actionStates.push(state.selectedRadio?.key ?? null);
      },
    },
    table: { render() {}, clearInvalidHighlights() {} },
    settings: { clearInvalid() {}, fetchForRadio: async () => ({ groups: [] }), applyLoadedState() {} },
  };

  const { createRadioCatalog } = await import("../web/js/ui/radio-catalog.js");
  const catalog = createRadioCatalog(ctx);
  ctx.catalog = catalog;
  return { catalog, dom, state, events, actionStates };
}

function radioEvents(events) {
  return events.filter((event) => String(event.name).startsWith("radio_"));
}

test("startup selects no radio and reports none", async () => {
  const { catalog, dom, state, events } = await loadCatalog();

  catalog.refreshMakeOptions();

  // The alphabetically first vendor is not chosen for the user.
  assert.equal(dom.radioMakeEl.value, "");
  assert.equal(dom.radioModelEl.value, "");
  assert.equal(state.selectedRadio, null);
  assert.deepEqual(radioEvents(events), []);
});

test("a restored cookie reports radio_restored, never a selection", async () => {
  const cookie = `webchirp_last_radio=${encodeURIComponent(JSON.stringify({ make: "Baofeng", key: "uv5r:BaofengUV5R" }))}`;
  const { catalog, state, events } = await loadCatalog({ cookie });

  catalog.refreshMakeOptions();
  assert.equal(catalog.restoreSelectedRadioCookie(), true);

  assert.equal(state.selectedRadio?.key, "uv5r:BaofengUV5R");
  assert.deepEqual(radioEvents(events).map((event) => event.name), ["radio_restored"]);
  assert.deepEqual(radioEvents(events)[0].params, {
    display_mode: "browser",
    radio: "Baofeng UV-5R",
    radio_module: "uv5r",
    radio_class: "BaofengUV5R",
  });
});

test("choosing a make lists models but selects and reports nothing", async () => {
  const { catalog, dom, state, events } = await loadCatalog();

  catalog.refreshMakeOptions();
  catalog.bindEvents();

  dom.radioMakeEl.value = "Baofeng";
  dom.radioMakeEl.dispatch("change");

  // The vendor's models are offered, with none of them chosen for the user:
  // defaulting to the first was the boot problem one level down, and it also
  // wrote that radio to the last-radio cookie.
  assert.deepEqual(
    dom.radioModelEl.children.map((option) => option.textContent),
    ["Select radio model...", "UV-5R"],
  );
  assert.equal(dom.radioModelEl.value, "");
  assert.equal(state.selectedRadio, null);
  assert.deepEqual(radioEvents(events), []);
});

test("choosing a model reports radio_selected with its method", async () => {
  const { catalog, dom, state, events } = await loadCatalog();

  catalog.refreshMakeOptions();
  catalog.bindEvents();

  dom.radioMakeEl.value = "Baofeng";
  dom.radioMakeEl.dispatch("change");
  dom.radioModelEl.value = "uv5r:BaofengUV5R";
  dom.radioModelEl.dispatch("change");

  const selections = radioEvents(events).filter((event) => event.name === "radio_selected");
  assert.deepEqual(selections.map((event) => event.params.method), ["model"]);
  assert.equal(selections.at(-1).params.radio, "Baofeng UV-5R");
  assert.equal(state.selectedRadio?.key, "uv5r:BaofengUV5R");
});

test("a detected image refreshes the clone buttons with the radio it selected", async () => {
  const { catalog, state, events, actionStates } = await loadCatalog();

  catalog.refreshMakeOptions();
  actionStates.length = 0;

  const selected = catalog.selectRadioByDetectedImage({
    module: "uv5r",
    className: "BaofengUV5R",
    vendor: "Baofeng",
    model: "UV-5R",
  });

  assert.equal(selected, true);
  assert.equal(state.selectedRadio?.key, "uv5r:BaofengUV5R");
  // The LAST refresh has to see the radio. Populating the model list runs one
  // with nothing selected, and settings only refresh the buttons for a driver
  // that has settings -- so a stale refresh here leaves Download and Upload
  // disabled reading "Select your radio..." against a radio that is selected.
  assert.equal(actionStates.at(-1), "uv5r:BaofengUV5R");
  assert.deepEqual(
    radioEvents(events).map((event) => [event.name, event.params.method]),
    [["radio_selected", "image"]],
  );
});

import assert from "node:assert/strict";
import test from "node:test";

// Issue #351: a binary import, a binary export or an upload awaits the
// runtime, and the radio can be changed while it does: by the radio search,
// or, during an upload, by dropping in a .img. What comes back belongs to the
// session the work
// started on, so it is applied only while that session is still
// state.radioSession: the settings an export or upload reports, the image's
// settings and grid, and a SettingsRefusedError's refused paths, which marked
// onto another radio's panel would flag a field that radio may not have and
// keep Save to radio disabled.
import { installIndexPage } from "../support/index-page.mjs";
import {
  createDeferred,
  dispatch,
  emit,
  flushMicrotasks,
  selectRadioBySearch,
} from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";

const CATALOG = [
  { vendor: "Acme", model: "Alpha", variant: "", module: "alpha", className: "AlphaRadio", key: "alpha:AlphaRadio", isLiveRadio: false },
  { vendor: "Acme", model: "Bravo", variant: "", module: "bravo", className: "BravoRadio", key: "bravo:BravoRadio", isLiveRadio: false },
];

const FREQ_PATH = ["band", "freq"];

// Both radios publish the same two tabs, so a refusal marked on the wrong
// radio would land on a field the test can see; only the Name differs.
function settingGroups(name) {
  return [
    {
      kind: "group", id: "basic", label: "Basic", path: ["basic"],
      children: [{
        kind: "setting", id: "name", label: "Name", path: ["basic", "name"],
        doc: null, volatile: false, warning: null,
        values: [{ type: "string", current: name, mutable: true, initialized: true, index: 0 }],
      }],
    },
    {
      kind: "group", id: "band", label: "Band", path: ["band"],
      children: [{
        kind: "setting", id: "freq", label: "Rx Frequency", path: FREQ_PATH,
        doc: null, volatile: false, warning: null,
        values: [{ type: "string", current: "50.000000", mutable: true, initialized: true, index: 0 }],
      }],
    },
  ];
}

function settingsFor(module) {
  return {
    supported: true, available: true, requiresImage: false, message: "",
    groups: settingGroups(module === "alpha" ? "Alpha" : "Bravo"),
  };
}

function refusal(method, action) {
  return runtimeCallError(
    "SettingsRefusedError",
    `The radio refused Band > Rx Frequency: out of range. Correct it in Settings, then ${action} again.`,
    { details: { issues: [{ path: FREQ_PATH, valueIndex: 0, message: "out of range" }] } },
    method,
  );
}

// The real page against a runtime whose radio-bound calls answer per radio;
// overrides replace any of them.
async function bootUi(t, overrides = {}) {
  const { window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async ({ module }) => settingsFor(module),
    validateRowsForUpload: async () => ({ valid: true, issues: [], warnings: [] }),
    validateRadioSettings: async ({ settings }) => ({
      valid: true, issues: [], settings, available: true, requiresImage: false, message: "", error: "",
    }),
    ...overrides,
  }));
  await ui.init(true);
  // A finished export saves through an object URL revoked a minute later;
  // neither exists in jsdom, and the timer would hold the process open.
  const { createObjectURL, revokeObjectURL } = URL;
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:test/0";
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  t.after(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    window.HTMLAnchorElement.prototype.click = anchorClick;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { ui, window, document: window.document };
}

// What the settings panel shows: the Name field's value and the flagged tabs.
function panelState(document) {
  const tabs = Array.from(document.querySelectorAll("#settings-tabs .settings-tab"));
  const inputs = Array.from(document.querySelectorAll("#settings-content .settings-field-control input"));
  return {
    values: inputs.map((input) => input.value),
    flaggedTabs: tabs.filter((tab) => tab.classList.contains("has-invalid")).map((tab) => tab.textContent),
    invalidFields: document.querySelectorAll("#settings-content .settings-field-control.is-invalid").length,
  };
}

function debugText(document) {
  return document.querySelector("#debug-output").value;
}

test("an export answered after the radio changed leaves the new radio's settings alone", async (t) => {
  const answer = createDeferred();
  const { document } = await bootUi(t, { exportImage: () => answer.promise });
  selectRadioBySearch(document, "Acme Alpha");
  await flushMicrotasks();

  const click = dispatch(document.querySelector("#export-binary"), "click");
  await flushMicrotasks();
  selectRadioBySearch(document, "Acme Bravo");
  await flushMicrotasks();
  assert.ok(panelState(document).values.includes("Bravo"));

  answer.resolve({ imageBase64: "AQID", settings: settingGroups("FromAlphaExport"), vendor: "Acme", model: "Alpha" });
  await click;

  const state = panelState(document);
  assert.ok(state.values.includes("Bravo"), "Bravo's settings stay in the panel");
  assert.ok(!state.values.includes("FromAlphaExport"));
  assert.match(debugText(document), /STATUS Exported Acme_Alpha/);
});

test("a setting refused by an export for another radio is not marked on the new one", async (t) => {
  const answer = createDeferred();
  const { document } = await bootUi(t, { exportImage: () => answer.promise });
  selectRadioBySearch(document, "Acme Alpha");
  await flushMicrotasks();

  const click = dispatch(document.querySelector("#export-binary"), "click");
  await flushMicrotasks();
  selectRadioBySearch(document, "Acme Bravo");
  await flushMicrotasks();

  answer.reject(refusal("export_image_base64", "export"));
  await click;

  assert.deepEqual(panelState(document).flaggedTabs, []);
  assert.equal(panelState(document).invalidFields, 0);
});

test("a setting refused by an upload is not marked on an image opened during it", async (t) => {
  // The radio search is disabled while a transfer runs, but a .img can still
  // be dropped in, and its load selects the image's radio and session.
  const answer = createDeferred();
  const { window, document } = await bootUi(t, {
    uploadSelectedRadio: () => answer.promise,
    loadImage: async () => ({
      module: "bravo",
      className: "BravoRadio",
      vendor: "Acme",
      model: "Bravo",
      headers: ["Location", "Name"],
      rows: [{ Location: "1", Name: "FromImg" }],
      settings: settingGroups("FromImage"),
    }),
  });
  selectRadioBySearch(document, "Acme Alpha");
  await flushMicrotasks();

  // With no port connected the button is disabled, but the handler is what is
  // under test, as in ui-refused-setting.
  const click = dispatch(document.querySelector("#radio-upload"), "click");
  await flushMicrotasks();
  await emit(window, "drop", {
    dataTransfer: {
      types: ["Files"],
      files: [{ name: "bravo.img", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }],
    },
  });
  await flushMicrotasks();
  assert.ok(panelState(document).values.includes("FromImage"), "the image's settings are shown");

  answer.reject(refusal("upload_selected_radio", "upload"));
  await click;
  await flushMicrotasks();

  assert.deepEqual(panelState(document).flaggedTabs, []);
  assert.equal(panelState(document).invalidFields, 0);
});

test("a radio picked while an image's schema loads cancels the import", async (t) => {
  const imageSchema = createDeferred();
  const { ui, window, document } = await bootUi(t, {
    getRadioMetadata: async ({ module }) => (module === "alpha"
      ? imageSchema.promise
      : { headers: ["Location", "Name"], columns: {} }),
    loadImage: async () => ({
      module: "alpha",
      className: "AlphaRadio",
      vendor: "Acme",
      model: "Alpha",
      headers: ["Location", "Name"],
      rows: [{ Location: "1", Name: "FromImg" }],
      settings: settingGroups("FromImage"),
    }),
  });

  const drop = emit(window, "drop", {
    dataTransfer: {
      types: ["Files"],
      files: [{ name: "alpha.img", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }],
    },
  });
  await flushMicrotasks();
  selectRadioBySearch(document, "Acme Bravo");
  await flushMicrotasks();

  imageSchema.resolve({ headers: ["Location", "Name"], columns: {} });
  await drop;
  await flushMicrotasks();

  const state = panelState(document);
  assert.ok(state.values.includes("Bravo"), "Bravo's settings stay in the panel");
  assert.ok(!state.values.includes("FromImage"));
  assert.ok(!ui.selectedRowsForOperations().some((row) => row.Name === "FromImg"), "the image's rows are not kept");
  assert.match(debugText(document), /STATUS Import cancelled: the selected radio changed\./);
  assert.doesNotMatch(debugText(document), /Loaded binary codeplug/);
});

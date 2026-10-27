import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { domEvent, flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";

// A driver can check a setting only while writing it (kguv9dplus checks a VFO
// frequency against its band inside the apply callback), so the upload
// preflight passes and the write itself refuses the value. The runtime then
// raises SettingsRefusedError with the refused settings in its details, and
// the panel marks them the way it marks a preflight finding: the field in
// red, its tab flagged and opened.

const CATALOG = [{
  vendor: "Acme", model: "Refuser", variant: "",
  module: "acme", className: "Radio", key: "acme:Radio", isLiveRadio: false,
}];

const FREQ_PATH = ["band", "freq"];

// Two tabs, so opening the refused setting's tab is observable: the panel
// starts on the first.
const SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [
    {
      kind: "group", id: "basic", label: "Basic", path: ["basic"],
      children: [{
        kind: "setting", id: "name", label: "Name", path: ["basic", "name"],
        doc: null, volatile: false, warning: null,
        values: [{ type: "string", current: "Acme", mutable: true, initialized: true, index: 0 }],
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
  ],
};

const REFUSAL_MESSAGE = "Frequency 50.000000 is not with in 108.000000-180.997500";

// The failure as the dispatcher throws it for a write the driver refused.
function refusal(method, action) {
  return runtimeCallError(
    "SettingsRefusedError",
    `The radio refused Band > Rx Frequency: ${REFUSAL_MESSAGE}. Correct it in Settings, then ${action} again.`,
    { details: { issues: [{ path: FREQ_PATH, valueIndex: 0, message: REFUSAL_MESSAGE }] } },
    method,
  );
}

// Load the page with a runtime whose export and upload throw what the
// given functions return, and select the radio so its settings render.
async function pageWithFailingWrites({ exportError, uploadError }) {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => structuredClone(SETTINGS),
    validateRowsForUpload: async () => ({ valid: true, issues: [], warnings: [] }),
    validateRadioSettings: async ({ settings }) => ({
      valid: true, issues: [], settings, available: true, requiresImage: false, message: "", error: "",
    }),
    exportImage: async () => {
      throw exportError();
    },
    uploadSelectedRadio: async () => {
      throw uploadError();
    },
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Refuser");
  await flushMicrotasks();
  return document;
}

// What the panel shows for the refused field and the tabs.
function panelState(document) {
  const tabs = Array.from(document.querySelectorAll("#settings-tabs .settings-tab"));
  const active = tabs.find((tab) => tab.classList.contains("is-active"));
  const freqControl = Array.from(document.querySelectorAll("#settings-content .settings-field-control"))
    .find((control) => control.querySelector("input")?.value === "50.000000");
  return {
    activeTab: active?.textContent,
    flaggedTabs: tabs.filter((tab) => tab.classList.contains("has-invalid")).map((tab) => tab.textContent),
    freqInvalid: Boolean(freqControl?.classList.contains("is-invalid")),
    freqError: freqControl?.querySelector(".settings-field-error")?.textContent ?? "",
    freqInput: freqControl?.querySelector("input") ?? null,
  };
}

test("a setting the radio refused on export is marked, and its tab opened", async () => {
  const document = await pageWithFailingWrites({
    exportError: () => refusal("export_image_base64", "export"),
    uploadError: () => new Error("not under test"),
  });
  assert.equal(panelState(document).activeTab, "Basic", "the panel should start on the first tab");

  document.querySelector("#export-binary").dispatchEvent(domEvent({ type: "click" }));
  await flushMicrotasks();

  const state = panelState(document);
  assert.equal(state.activeTab, "Band");
  assert.deepEqual(state.flaggedTabs, ["Band"]);
  assert.equal(state.freqInvalid, true);
  assert.equal(state.freqError, REFUSAL_MESSAGE);

  // Correcting the field clears the mark, as for any other invalid value.
  state.freqInput.value = "146.000000";
  state.freqInput.dispatchEvent(domEvent({ type: "change" }));
  await flushMicrotasks();
  assert.deepEqual(panelState(document).flaggedTabs, []);
});

test("a setting the radio refused on upload is marked, and its tab opened", async () => {
  const document = await pageWithFailingWrites({
    exportError: () => new Error("not under test"),
    uploadError: () => refusal("upload_selected_radio", "upload"),
  });

  // The click a user makes; with no port connected the button is disabled,
  // but the handler is what is under test, as in ui-settings-empty-reply.
  document.querySelector("#radio-upload").dispatchEvent(domEvent({ type: "click" }));
  await flushMicrotasks();

  const state = panelState(document);
  assert.equal(state.activeTab, "Band");
  assert.equal(state.freqInvalid, true);
  assert.equal(state.freqError, REFUSAL_MESSAGE);
});

test("a write that fails for any other reason leaves the panel unmarked", async () => {
  const document = await pageWithFailingWrites({
    exportError: () => runtimeCallError("RuntimeUnsupportedError", "Something else broke.", {}, "export_image_base64"),
    uploadError: () => new Error("not under test"),
  });

  document.querySelector("#export-binary").dispatchEvent(domEvent({ type: "click" }));
  await flushMicrotasks();

  const state = panelState(document);
  assert.equal(state.activeTab, "Basic");
  assert.deepEqual(state.flaggedTabs, []);
});

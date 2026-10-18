import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { dispatch, flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const CATALOG = [{
  vendor: "Acme", model: "Tabbed", variant: "",
  module: "tabbed", className: "Radio", key: "tabbed:Radio", isLiveRadio: false,
}];

// A leaf setting in the given group, holding one value of the given shape.
function setting(group, id, value) {
  return {
    kind: "setting", id, label: id, path: [group, id],
    doc: null, volatile: false, warning: null,
    values: [{ mutable: true, index: 0, ...value }],
  };
}

// Two tabs, so a tab switch has somewhere to go, and one control of each kind
// on the first: a checkbox, a select and a bounded number field.
const TABBED_SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [
    {
      kind: "group", id: "basic", label: "Basic", path: ["basic"],
      children: [
        setting("basic", "beep", { type: "boolean", current: false }),
        setting("basic", "power", { type: "enum", current: "Low", options: ["Low", "High"] }),
        setting("basic", "squelch", { type: "integer", current: 3, min: 0, max: 9 }),
      ],
    },
    {
      kind: "group", id: "advanced", label: "Advanced", path: ["advanced"],
      children: [setting("advanced", "callsign", { type: "string", current: "N0CALL" })],
    },
  ],
};

// Boot the page with TABBED_SETTINGS loaded and the Settings view open.
async function openSettingsView() {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => structuredClone(TABBED_SETTINGS),
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Tabbed");
  await flushMicrotasks();
  await dispatch(document.querySelector("#view-settings"), "click");
  return document;
}

// The control the user would edit, by the order its setting appears in.
function controls(document) {
  return Array.from(document.querySelectorAll("#settings-content input, #settings-content select"));
}

function tabButton(document, label) {
  return Array.from(document.querySelectorAll("#settings-tabs .settings-tab"))
    .find((button) => button.textContent === label);
}

test("toggling a checkbox or picking an option keeps keyboard focus on that control", async () => {
  const document = await openSettingsView();
  const [beep, power] = controls(document);

  beep.focus();
  beep.checked = true;
  await dispatch(beep, "change");
  assert.ok(beep.isConnected, "the checkbox was rebuilt instead of updated");
  assert.equal(document.activeElement, beep);
  assert.equal(controls(document)[0].checked, true);

  power.focus();
  power.value = "High";
  await dispatch(power, "change");
  assert.ok(power.isConnected, "the select was rebuilt instead of updated");
  assert.equal(document.activeElement, power);
  assert.equal(power.value, "High");
});

test("an out-of-range value is flagged and cleared in place, and a fixed one shows as stored", async () => {
  const document = await openSettingsView();
  const squelch = controls(document)[2];
  const wrapper = squelch.closest(".settings-field-control");
  const basicTab = tabButton(document, "Basic");

  squelch.focus();
  squelch.value = "12";
  await dispatch(squelch, "change");
  assert.equal(document.activeElement, squelch);
  assert.ok(wrapper.classList.contains("is-invalid"));
  assert.equal(wrapper.querySelector(".settings-field-error")?.textContent, "Value must be at most 9.");
  assert.ok(basicTab.classList.contains("has-invalid"));
  assert.match(document.querySelector("#settings-summary").textContent, /1 invalid value\b/);

  // The field shows the value the panel stored, not the text typed for it.
  squelch.value = "07";
  await dispatch(squelch, "change");
  assert.equal(document.activeElement, squelch);
  assert.equal(squelch.value, "7");
  assert.ok(!wrapper.classList.contains("is-invalid"));
  assert.equal(wrapper.querySelectorAll(".settings-field-error").length, 0);
  assert.ok(!basicTab.classList.contains("has-invalid"));
  assert.match(document.querySelector("#settings-summary").textContent, /ready to write/);
});

test("switching tabs keeps keyboard focus on the tab pressed and keeps earlier edits", async () => {
  const document = await openSettingsView();
  const beep = controls(document)[0];
  beep.checked = true;
  await dispatch(beep, "change");

  const advancedTab = tabButton(document, "Advanced");
  advancedTab.focus();
  await dispatch(advancedTab, "click");
  assert.ok(advancedTab.isConnected, "the tab strip was rebuilt");
  assert.equal(document.activeElement, advancedTab);
  assert.ok(advancedTab.classList.contains("is-active"));
  assert.ok(!tabButton(document, "Basic").classList.contains("is-active"));
  assert.deepEqual(controls(document).map((control) => control.value), ["N0CALL"]);

  const basicTab = tabButton(document, "Basic");
  basicTab.focus();
  await dispatch(basicTab, "click");
  assert.equal(document.activeElement, basicTab);
  assert.equal(controls(document)[0].checked, true);
});

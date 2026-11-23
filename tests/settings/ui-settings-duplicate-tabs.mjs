import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { dispatch, flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const CATALOG = [{
  vendor: "Acme", model: "Twins", variant: "",
  module: "twins", className: "Radio", key: "twins:Radio", isLiveRadio: false,
}];

function setting(group, id, value) {
  return {
    kind: "setting", id, label: id, path: [group, id],
    doc: null, volatile: false, warning: null,
    values: [{ mutable: true, index: 0, ...value }],
  };
}

// CHIRP's RadioSettings is a list, so nothing stops a driver giving two
// top-level groups the same name: kguv920pa names both its Repeater and
// Remote Control groups "rmt_grp". The tabs are told apart by position.
const TWIN_SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [
    {
      kind: "group", id: "rmt_grp", label: "Repeater", path: ["rmt_grp"],
      children: [setting("rmt_grp", "rpt_tone", { type: "integer", current: 1, min: 0, max: 9 })],
    },
    {
      kind: "group", id: "rmt_grp", label: "Remote Control", path: ["rmt_grp"],
      children: [setting("rmt_grp", "remote_code", { type: "string", current: "ABC" })],
    },
  ],
};

async function openSettingsView() {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => structuredClone(TWIN_SETTINGS),
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Twins");
  await flushMicrotasks();
  await dispatch(document.querySelector("#view-settings"), "click");
  return document;
}

function controls(document) {
  return Array.from(document.querySelectorAll("#settings-content input, #settings-content select"));
}

function tabButton(document, label) {
  return Array.from(document.querySelectorAll("#settings-tabs .settings-tab"))
    .find((button) => button.textContent === label);
}

test("two top-level groups sharing a name each open as their own tab", async () => {
  const document = await openSettingsView();
  const repeater = tabButton(document, "Repeater");
  const remote = tabButton(document, "Remote Control");
  assert.ok(repeater.classList.contains("is-active"));
  assert.ok(!remote.classList.contains("is-active"));
  assert.deepEqual(controls(document).map((control) => control.value), ["1"]);

  await dispatch(remote, "click");
  assert.ok(remote.classList.contains("is-active"), "the clicked tab should be active");
  assert.ok(!repeater.classList.contains("is-active"), "only the clicked tab should be active");
  assert.deepEqual(controls(document).map((control) => control.value), ["ABC"]);

  await dispatch(repeater, "click");
  assert.ok(repeater.classList.contains("is-active"));
  assert.ok(!remote.classList.contains("is-active"));
  assert.deepEqual(controls(document).map((control) => control.value), ["1"]);
});

test("an invalid value marks only the tab that holds it when names repeat", async () => {
  const document = await openSettingsView();
  const field = controls(document)[0];
  field.value = "12";
  await dispatch(field, "change");
  assert.ok(tabButton(document, "Repeater").classList.contains("has-invalid"));
  assert.ok(!tabButton(document, "Remote Control").classList.contains("has-invalid"));
});

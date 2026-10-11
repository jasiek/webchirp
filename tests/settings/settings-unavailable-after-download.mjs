import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const CATALOG = [{
  vendor: "Acme", model: "Broken", variant: "",
  module: "broken", className: "Radio", key: "broken:Radio", isLiveRadio: false,
}];

const HEADERS = ["Location", "Name"];

const SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [{
    kind: "group", id: "basic", label: "Basic", path: ["basic"],
    children: [{
      kind: "setting", id: "beep", label: "Beep", path: ["basic", "beep"],
      doc: null, volatile: false, warning: null,
      values: [{ type: "string", current: "On", mutable: true, index: 0 }],
    }],
  }],
};

// A download whose driver could not read its settings answers with none. If
// the user had the Settings view open, the recovered channels must not stay
// hidden behind a view that is now disabled.
test("a download without settings leaves the Settings view for Channels", async () => {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS, columns: {} }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => SETTINGS,
    parseCsv: async () => ({ headers: HEADERS, rows: [], errors: [] }),
    downloadSelectedRadio: async () => ({
      headers: HEADERS,
      rows: [{ Location: "1", Name: "ONE" }],
      settings: [],
    }),
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Broken");
  await flushMicrotasks();

  const settingsTab = document.querySelector("#view-settings");
  const channelsTab = document.querySelector("#view-channels");
  settingsTab.click();
  assert.ok(settingsTab.classList.contains("is-active"), "the Settings view should be open");

  // index.html ships the button disabled until a port connects.
  const downloadEl = document.querySelector("#radio-download");
  downloadEl.disabled = false;
  downloadEl.click();
  await flushMicrotasks();
  await flushMicrotasks();

  assert.ok(channelsTab.classList.contains("is-active"), "the Channels view should be showing");
  assert.equal(settingsTab.disabled, true, "the Settings tab should be off");
});

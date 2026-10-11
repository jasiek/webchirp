import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { dispatch, flushMicrotasks, selectRadioBySearch } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const CATALOG = [{
  vendor: "Acme", model: "Guarded", variant: "",
  module: "guarded", className: "Radio", key: "guarded:Radio", isLiveRadio: false,
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

// The runtime answers an export with the settings it applied. When it could
// not read them it answers with none, which is not the radio having none: the
// panel must keep the tree the user is looking at, or the next upload would
// send nothing and report success while the edits were dropped.
test("an export reply without settings does not empty the settings panel", async (t) => {
  const { window } = installIndexPage();
  const { document } = window;
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS, columns: {} }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => SETTINGS,
    parseCsv: async () => ({ headers: HEADERS, rows: [], errors: [] }),
    exportImage: async () => ({ imageBase64: "AQID", settings: [] }),
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme Guarded");
  await flushMicrotasks();

  // jsdom cannot create object URLs or follow an anchor; neither is under test.
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

  const field = () => document.querySelector("#settings-content input");
  assert.equal(field()?.value, "On", "the panel starts with the radio's tree");

  await dispatch(document.querySelector("#export-binary"), "click");
  await flushMicrotasks();

  assert.equal(field()?.value, "On", "the tree survives an export that echoed none");
  assert.equal(document.querySelector("#view-settings").disabled, false);
});

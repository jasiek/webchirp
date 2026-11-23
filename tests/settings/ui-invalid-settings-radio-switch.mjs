import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage, pageElement } from "../support/index-page.mjs";
import {
  dispatch,
  domEvent,
  flushMicrotasks,
  selectRadioBySearch,
  setInputFiles,
} from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

// Issue #348: an invalid radio setting blocks Save to radio. Leaving that
// radio -- picking another in the search box, or loading an image of a radio
// with no settings -- dropped the invalid values, but nothing repainted the
// button once the new radio turned out to have no settings, so it stayed
// disabled with "Fix invalid radio settings before upload" for good.
// Reselecting the radio already loaded dropped the bookkeeping while its
// fields stayed red.

const HEADERS = ["Location", "Name"];
const SETTINGS_RADIO = {
  vendor: "Acme", model: "Settings", variant: "",
  module: "acme", className: "SettingsRadio", key: "acme:SettingsRadio", isLiveRadio: false,
};
const PLAIN_RADIO = {
  vendor: "Acme", model: "Plain", variant: "",
  module: "acme", className: "PlainRadio", key: "acme:PlainRadio", isLiveRadio: false,
};

function integerSetting(id, current) {
  return {
    kind: "setting", id, label: id, path: ["basic", id],
    doc: null, volatile: false, warning: null,
    values: [{ type: "integer", current, min: 0, max: 10, mutable: true, initialized: true, index: 0 }],
  };
}

const SETTINGS = {
  supported: true, available: true, requiresImage: false, message: "",
  groups: [{
    kind: "group", id: "basic", label: "Basic", path: ["basic"],
    children: [integerSetting("squelch", 3), integerSetting("volume", 5)],
  }],
};
const NO_SETTINGS = { supported: false, available: false, requiresImage: true, message: "", groups: [] };

const INVALID_TITLE = "Fix invalid radio settings before upload";

// Boots the page with the settings radio selected and a port connected.
async function bootUi() {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [SETTINGS_RADIO, PLAIN_RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async ({ className }) => (className === SETTINGS_RADIO.className ? SETTINGS : NO_SETTINGS),
    loadImage: async () => ({
      module: PLAIN_RADIO.module,
      className: PLAIN_RADIO.className,
      vendor: PLAIN_RADIO.vendor,
      model: PLAIN_RADIO.model,
      headers: HEADERS,
      rows: [{ Location: "1", Name: "ONE" }],
      settings: [],
    }),
    serialConnect: async () => ({ connected: true, transport: "webserial", message: "ok" }),
    serialDisconnect: async () => ({ connected: false, message: "bye" }),
  }));
  ui.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
  await ui.init(true);
  selectRadioBySearch(document, "Acme Settings");
  await flushMicrotasks();
  await dispatch(pageElement("serialConnectToggleEl"), "click");
  return document;
}

function settingInput(document, index) {
  return document.querySelectorAll("#settings-content input")[index];
}

// Type a value into a setting and leave it, as a user does.
function typeSetting(document, index, text) {
  const input = settingInput(document, index);
  input.value = text;
  input.dispatchEvent(domEvent({ type: "change" }));
}

// Enter an out-of-range value, which blocks the upload.
async function makeSettingInvalid(document) {
  typeSetting(document, 0, "999");
  const uploadEl = pageElement("radioUploadEl");
  assert.equal(uploadEl.disabled, true, "an invalid setting should block the upload");
  assert.equal(uploadEl.title, INVALID_TITLE);
  return uploadEl;
}

test("switching to a radio without settings unblocks the upload", async () => {
  const document = await bootUi();
  const uploadEl = await makeSettingInvalid(document);

  selectRadioBySearch(document, "Acme Plain");
  await flushMicrotasks();

  assert.equal(uploadEl.disabled, false, "the new radio has no invalid settings to fix");
  assert.notEqual(uploadEl.title, INVALID_TITLE);
});

test("loading an image of a radio without settings unblocks the upload", async () => {
  const document = await bootUi();
  const uploadEl = await makeSettingInvalid(document);

  const fileInput = document.querySelector("#codeplug-file");
  setInputFiles(fileInput, [{ name: "plain.img", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }]);
  await dispatch(fileInput, "change");
  await flushMicrotasks();

  assert.equal(uploadEl.disabled, false, "the image's radio has no invalid settings to fix");
  assert.notEqual(uploadEl.title, INVALID_TITLE);
});

test("reselecting the loaded radio keeps its invalid settings", async () => {
  const document = await bootUi();
  const uploadEl = await makeSettingInvalid(document);

  selectRadioBySearch(document, "Acme Settings");
  await flushMicrotasks();
  // A valid edit to another field must not count the red one as fixed.
  typeSetting(document, 1, "7");

  const summaryEl = pageElement("settingsSummaryEl");
  assert.match(summaryEl.textContent, /1 invalid value/);
  assert.equal(uploadEl.disabled, true, "the red field still blocks the upload");
  assert.equal(uploadEl.title, INVALID_TITLE);
});

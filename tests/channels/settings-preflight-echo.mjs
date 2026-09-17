import assert from "node:assert/strict";
import test from "node:test";

import { FakeElement, flushMicrotasks, installFakeDom } from "../support/fake-dom.mjs";

// The upload preflight sends the edited settings tree to the runtime and takes
// the tree that comes back. That echo is only worth keeping when the runtime
// could read the settings and accepted every value: it answers with an empty
// list when it could not check them at all (no cached image, a driver without
// has_settings, or a get_settings() that raised), and on a rejected value the
// tree it returns still holds the radio's pre-edit value, because the
// set_value that failed never took. Either one, applied blindly, throws away
// what the user typed just as they press Upload.

const RADIO = {
  vendor: "Baofeng",
  model: "UV-5R",
  module: "uv5r",
  className: "BaofengUV5R",
};

// One string setting under one group, in the shape
// web/python/webchirp_bridge/radio_settings.py serializes.
function settingsTree(currentValue) {
  return [
    {
      kind: "group",
      id: "basic",
      label: "Basic",
      path: ["basic"],
      children: [
        {
          kind: "setting",
          id: "name",
          label: "Radio name",
          path: ["basic", "name"],
          mutable: true,
          values: [
            {
              index: 0,
              type: "string",
              mutable: true,
              initialized: true,
              current: currentValue,
              minLength: 0,
              maxLength: 8,
              charset: "",
              autopad: false,
            },
          ],
        },
      ],
    },
  ];
}

function settingValue(groups) {
  return groups?.[0]?.children?.[0]?.values?.[0]?.current;
}

// Real settings panel, real serial actions, stubbed runtime and grid: the wipe
// only shows up in how the two modules hand the tree between them.
async function makeUploadHarness({ validateSettings, upload }) {
  const { restore } = installFakeDom();
  const { createSettingsPanel } = await import("../../web/js/ui/settings-panel.js");
  const { createSerialActions } = await import("../../web/js/ui/serial-actions.js");

  const domKeys = [
    "appShellEl",
    "cloneProgressBarEl",
    "cloneProgressEl",
    "cloneProgressLabelEl",
    "cloneProgressPercentEl",
    "liveRadioSupportWarningEl",
    "radioDownloadEl",
    "radioUploadEl",
    "serialConnectToggleEl",
    "settingsContentEl",
    "settingsEmptyEl",
    "settingsSummaryEl",
    "settingsTabsEl",
    "unsupportedBrowserContinueEl",
    "unsupportedBrowserIosInfoEl",
    "unsupportedBrowserJspiInfoEl",
    "unsupportedBrowserOverlayEl",
    "unsupportedBrowserSerialInfoEl",
    "viewSettingsEl",
    "webusbConnectToggleEl",
  ];
  const dom = Object.fromEntries(domKeys.map((key) => [key, new FakeElement()]));
  dom.sidebarControlEls = [dom.radioDownloadEl, dom.radioUploadEl];

  const uploadPayloads = [];
  const debugLines = [];
  const state = {
    selectedRadio: RADIO,
    currentRows: [{ Location: 1, Name: "CH1" }],
    currentEditorView: "settings",
    radioLoadSequence: 0,
    runtimeApi: {
      validateRowsForUpload: async () => ({ valid: true, issues: [], warnings: [] }),
      validateRadioSettings: async () => validateSettings(),
      uploadSelectedRadio: async (payload) => {
        uploadPayloads.push(payload);
        return upload ? upload(payload) : { uploaded: true, settings: [] };
      },
    },
  };
  const ctx = {
    dom,
    state,
    log: {
      setStatus() {},
      logSerial() {},
      logDebug(line) {
        debugLines.push(String(line));
      },
      logError() {},
      reportActionError() {},
      reportActionCancelled() {},
    },
    actions: {
      setEditorView() {},
      updateSerialActionState() {},
      currentViewLabel: () => "Radio Settings",
    },
    table: {
      applyValidationIssues() {},
      clearInvalidHighlights() {},
      render() {},
      resetRowSelection() {},
      sortRowsByLocation() {},
    },
  };
  ctx.settings = createSettingsPanel(ctx);
  const serial = createSerialActions(ctx);
  serial.bindEvents();
  ctx.settings.replaceState({
    supported: true,
    available: true,
    requiresImage: false,
    message: "",
    groups: settingsTree("EDITED"),
  });
  ctx.settings.updateViewButtons();

  async function pressUpload() {
    await dom.radioUploadEl.dispatch("click");
    await flushMicrotasks();
    await flushMicrotasks();
  }

  return { ctx, dom, pressUpload, uploadPayloads, debugLines, restore };
}

test("an unchecked settings reply leaves the edited tree in place", async (t) => {
  const harness = await makeUploadHarness({
    // The three runtime paths that cannot check the settings all answer like
    // this: valid, so channels alone still upload, with nothing to echo back.
    validateSettings: () => ({
      valid: true,
      issues: [],
      settings: [],
      available: false,
      message: "Radio-wide settings are unavailable until this driver's backing state is loaded.",
      error: "boom",
    }),
    upload: () => ({ uploaded: true, settings: [] }),
  });
  t.after(harness.restore);

  await harness.pressUpload();

  assert.equal(settingValue(harness.ctx.settings.getGroups()), "EDITED");
  assert.equal(harness.ctx.settings.radioHasSettings(), true);
  // The Radio Settings button stays live; the wipe used to disable it.
  assert.equal(harness.dom.viewSettingsEl.disabled, false);
  // And the write carries the user's settings rather than an empty tree.
  assert.equal(harness.uploadPayloads.length, 1);
  assert.equal(settingValue(harness.uploadPayloads[0].settings), "EDITED");
  assert.ok(harness.debugLines.some((line) => line.startsWith("PREFLIGHT SETTINGS UNCHECKED")));
});

test("a rejected value keeps the user's edit on screen and blocks the upload", async (t) => {
  const harness = await makeUploadHarness({
    // A rejected set_value leaves the runtime's tree holding the radio's own
    // value, which is what it serializes back.
    validateSettings: () => ({
      valid: false,
      issues: [{ path: ["basic", "name"], valueIndex: 0, message: "Value must be 8 characters" }],
      settings: settingsTree("FROMRADIO"),
      available: true,
      message: "",
      error: "",
    }),
  });
  t.after(harness.restore);

  await harness.pressUpload();

  assert.equal(settingValue(harness.ctx.settings.getGroups()), "EDITED");
  assert.equal(harness.ctx.settings.hasInvalidSettings(), true);
  assert.equal(harness.uploadPayloads.length, 0);
});

test("an accepted settings reply still replaces the tree with the runtime's echo", async (t) => {
  const harness = await makeUploadHarness({
    validateSettings: () => ({
      valid: true,
      issues: [],
      settings: settingsTree("EDITED  "),
      available: true,
      message: "",
      error: "",
    }),
    upload: () => ({ uploaded: true, settings: settingsTree("EDITED  ") }),
  });
  t.after(harness.restore);

  await harness.pressUpload();

  assert.equal(settingValue(harness.ctx.settings.getGroups()), "EDITED  ");
  assert.equal(harness.uploadPayloads.length, 1);
});

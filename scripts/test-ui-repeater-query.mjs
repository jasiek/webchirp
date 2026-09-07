import assert from "node:assert/strict";
import test from "node:test";

import { FakeElement, installFakeDom } from "./test-support/fake-dom.mjs";

// The shared fake DOM lets createUiController/init run headless: every #id
// resolves to an element, while the repeater-API-base meta tag is registered
// per test so the configurable/disabled paths can be exercised.
function installUiDom({ repeaterApiBase } = {}) {
  const { document } = installFakeDom();

  // Register the meta tag only when a base is provided; omitting it leaves the
  // tag absent (a non-id selector resolves to null), which resolves to the
  // built-in default (feature enabled).
  if (repeaterApiBase !== undefined) {
    const meta = new FakeElement("meta", document);
    meta.setAttribute("content", String(repeaterApiBase ?? ""));
    document.register('meta[name="webchirp-repeater-api-base"]', meta);
  }

  return {
    przemiennikiBtn: document.querySelector("#channel-import-przemienniki"),
    repeaterbookBtn: document.querySelector("#channel-import-repeaterbook"),
    irtsBtn: document.querySelector("#channel-import-irts"),
  };
}

const RUNTIME_API = {
  listRadios: async () => ({ radios: [] }),
  getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
  getDefaultHeaders: async () => ({ headers: ["Location", "Name", "Frequency"] }),
  getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
  getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
  parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
};

async function bootUi() {
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi(RUNTIME_API);
  await ui.init(true);
  return ui;
}

test("a blank API base hides proxy sources but leaves IRTS visible", async () => {
  const { przemiennikiBtn, repeaterbookBtn, irtsBtn } = installUiDom({ repeaterApiBase: "" });
  await bootUi();
  assert.equal(przemiennikiBtn.hidden, true);
  assert.equal(repeaterbookBtn.hidden, true);
  assert.equal(irtsBtn.hidden, false);
});

test("online repeater-query buttons stay visible with a configured API base", async () => {
  const { przemiennikiBtn, repeaterbookBtn, irtsBtn } = installUiDom({ repeaterApiBase: "https://proxy.example.com" });
  await bootUi();
  assert.equal(przemiennikiBtn.hidden, false);
  assert.equal(repeaterbookBtn.hidden, false);
  assert.equal(irtsBtn.hidden, false);
});

test("online repeater-query buttons default to visible when no meta tag is present", async () => {
  const { przemiennikiBtn, repeaterbookBtn, irtsBtn } = installUiDom();
  await bootUi();
  assert.equal(przemiennikiBtn.hidden, false);
  assert.equal(repeaterbookBtn.hidden, false);
  assert.equal(irtsBtn.hidden, false);
});

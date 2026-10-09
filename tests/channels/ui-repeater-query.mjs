import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

// index.html, booted headless. Its repeater-API-base meta tag is set per test
// so the configurable/disabled paths can be exercised.
function installUiDom({ repeaterApiBase } = {}) {
  const { document } = installIndexPage();

  // index.html ships the tag; a base given here replaces its content, and
  // omitting one removes the tag, which resolves to the built-in default
  // (feature enabled).
  const meta = document.querySelector('meta[name="webchirp-repeater-api-base"]');
  if (repeaterApiBase === undefined) {
    meta.remove();
  } else {
    meta.setAttribute("content", String(repeaterApiBase ?? ""));
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
  getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
  getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
  getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
  parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
};

async function bootUi() {
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions(RUNTIME_API));
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

import assert from "node:assert/strict";
import test from "node:test";

import { installFakeDom } from "../support/fake-dom.mjs";

// A ?radio= link is how a per-model page (web/radios/, built by
// scripts/build-model-pages.mjs) hands its visitor an app already pointed at
// the radio the page was about. The key in the link is the catalog's own
// module:class, which is what makes the two generated things agree.
const CATALOG = {
  radios: [
    { vendor: "Acme", model: "Alpha", module: "alpha", className: "AlphaRadio", key: "alpha:AlphaRadio", isLiveRadio: false },
    { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5RGeneric", key: "uv5r:BaofengUV5RGeneric", isLiveRadio: false },
  ],
};

function stubRuntimeApi(ui) {
  ui.setRuntimeApi({
    listRadios: async () => CATALOG,
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });
}

async function bootWith(search) {
  const { document, restore } = installFakeDom({ window: { location: { search } } });
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  stubRuntimeApi(ui);
  await ui.init(true);
  return {
    selectionName: document.querySelector("#radio-selection-name").textContent,
    restore,
  };
}

test("a ?radio= link preselects the radio its page is about", async () => {
  const { selectionName, restore } = await bootWith("?radio=uv5r%3ABaofengUV5RGeneric");
  try {
    assert.match(selectionName, /UV-5R/);
  } finally {
    restore();
  }
});

test("a ?radio= key the catalog no longer has leaves the app unselected", async () => {
  // The pages are generated from one catalog and served against another after
  // a CHIRP bump, so a stale key is expected rather than exceptional -- it must
  // not take the boot down or select some arbitrary other radio.
  const { selectionName, restore } = await bootWith("?radio=gone%3AVanishedRadio");
  try {
    assert.equal(selectionName, "No radio model selected");
  } finally {
    restore();
  }
});

test("no ?radio= at all still boots to an unselected app", async () => {
  const { selectionName, restore } = await bootWith("");
  try {
    assert.equal(selectionName, "No radio model selected");
  } finally {
    restore();
  }
});

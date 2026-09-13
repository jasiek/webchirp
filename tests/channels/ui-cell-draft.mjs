import assert from "node:assert/strict";
import test from "node:test";

// Regression test for issue #94: a scroll or resize re-renders the row window,
// and the re-render used to commit whatever was in the focused editor. A
// half-typed frequency does not validate, so the commit wrote the previous
// value back over the caret text. The draft has to survive the re-render and be
// committed only when the cell is really left.
//
// The fake DOM lives in tests/support/fake-dom.mjs; it has no layout, so
// renderRowWindow renders every row and scrolling exercises the re-render
// rather than the windowing arithmetic.
import {
  channelRows,
  flushMicrotasks,
  importSampleCsv,
  installFakeDom,
  selectRadioBySearch,
} from "../support/fake-dom.mjs";

const SAMPLE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
];

const SCHEMA = {
  headers: ["Location", "Name", "Frequency"],
  columns: {
    Location: { kind: "int", editable: false, min: 0, max: 127 },
    Name: { kind: "text", editable: true, maxLength: 6 },
    Frequency: { kind: "freq", editable: true, bands: [[144_000_000, 148_000_000]] },
  },
};

// Bring the grid up on a radio whose Frequency column really has bands, so the
// band check the bug depended on is live.
async function gridWithTwoChannels() {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: SCHEMA.headers }),
    getRadioMetadata: async () => SCHEMA,
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: SCHEMA.headers, rows: SAMPLE_ROWS, errors: [] }),
  });
  await ui.init(true);
  await selectRadioBySearch(document, "Acme One");
  await importSampleCsv(document);
  return { document };
}

// The Frequency editor of a rendered channel row.
function frequencyEditor(document, rowIdx) {
  return channelRows(document)[rowIdx].children[2].children[0];
}

function scrollGrid(document) {
  document.querySelector("#mem-table-scroll").dispatchEvent({ type: "scroll" });
}

test("a half-typed frequency survives a scroll re-render", async () => {
  const { document } = await gridWithTwoChannels();
  const editor = frequencyEditor(document, 1);
  editor.value = "146.";
  document.activeElement = editor;

  scrollGrid(document);
  await flushMicrotasks();

  assert.equal(frequencyEditor(document, 1).value, "146.");
  // Nothing was written to the row either: the draft is still a draft.
  assert.equal(channelRows(document)[1].children[2].children[0].value, "146.");
});

test("an out-of-band partial value is not reverted mid-typing", async () => {
  const { document } = await gridWithTwoChannels();
  const editor = frequencyEditor(document, 0);
  // "14" parses fine but is outside the driver's 2 m band, which is what used
  // to make the scroll commit snap the cell back to 146.520000.
  editor.value = "14";
  document.activeElement = editor;

  scrollGrid(document);
  await flushMicrotasks();

  assert.equal(frequencyEditor(document, 0).value, "14");
});

test("leaving the cell still commits, and still rejects an invalid value", async () => {
  const { document } = await gridWithTwoChannels();
  const editor = frequencyEditor(document, 0);
  editor.value = "146.";
  document.activeElement = editor;

  document.querySelector("#mem-table tbody").dispatchEvent({ type: "focusout", target: editor });

  assert.equal(editor.value, "146.520000");
});

test("an accepted edit committed on blur outlives the next re-render", async () => {
  const { document } = await gridWithTwoChannels();
  const editor = frequencyEditor(document, 1);
  editor.value = "145.500000";
  document.activeElement = editor;

  document.querySelector("#mem-table tbody").dispatchEvent({ type: "focusout", target: editor });
  document.activeElement = null;
  scrollGrid(document);
  await flushMicrotasks();

  assert.equal(frequencyEditor(document, 1).value, "145.500000");
});

import assert from "node:assert/strict";
import test from "node:test";

// The channel grid takes its natural width from its editors, so a text input
// left at the browser's 20-character default made every text column ~150px
// wide whatever it held -- with seventeen columns that overflowed the desktop
// window with space no value was using. createCellEditor() now sizes each
// input from the CHIRP column metadata (columnCharBudget() in
// web/js/ui/channel-table.js); these tests pin that mapping, since a
// regression to a fixed width is invisible to every other assertion here.
import {
  channelRows,
  flushMicrotasks,
  installFakeDom,
  selectRadioBySearch,
} from "./test-support/fake-dom.mjs";

const HEADERS = ["Location", "Name", "Frequency", "Offset", "Duplex", "Comment"];

// Sizes for one rendered channel row, keyed by column. Selects carry no size:
// a select is already exactly as wide as the widest option its driver offers.
async function editorSizes(columns) {
  const { document } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: [], errors: [] }),
  });

  await ui.init(true);
  // Without a selected radio the driver's column metadata is never fetched.
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();
  // The grid starts empty, so add the row whose editors are measured.
  document.querySelector("#channel-insert").dispatchEvent({ type: "click" });
  await flushMicrotasks();

  const row = channelRows(document)[0];
  return Object.fromEntries(
    row.children.map((td) => [td.dataset.column, td.children[0]?.size]),
  );
}

test("text editors are sized from the column metadata, not the browser default", async () => {
  const sizes = await editorSizes({
    Name: { kind: "text", editable: true, maxLength: 7 },
    Frequency: { kind: "freq", editable: true, bands: [] },
    Offset: { kind: "freq", editable: true, bands: [] },
    Duplex: { kind: "enum", editable: true, options: ["", "-", "+", "split"] },
    Comment: { kind: "text", editable: true },
  });

  // A length-limited field asks for exactly its limit.
  assert.equal(sizes.Name, 7);
  // A frequency asks for the ten characters of "145.787500".
  assert.equal(sizes.Frequency, 10);
  assert.equal(sizes.Offset, 10);
  // Free text has no natural width, so it gets the readable default.
  assert.equal(sizes.Comment, 12);
  // Selects size themselves from their options; nothing overrides that.
  assert.equal(sizes.Duplex, undefined);
});

test("a driver's own limits set the column width, within bounds", async () => {
  const sizes = await editorSizes({
    // A radio with no name field at all reports a zero length: the column
    // shrinks to its header rather than reserving room for a value that
    // cannot exist. A size of zero is not a legal input width, hence the 1.
    Name: { kind: "text", editable: false, maxLength: 0 },
    // A generous limit is capped, so one roomy driver cannot blow the column
    // back out; a longer value still scrolls inside the input.
    Comment: { kind: "text", editable: true, maxLength: 64 },
  });

  assert.equal(sizes.Name, 1);
  assert.equal(sizes.Comment, 12);
});

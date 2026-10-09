import assert from "node:assert/strict";
import test from "node:test";

// UI-level regression test for Cut with an async clipboard write: the rows
// deleted must be the rows that were serialized, not whatever is selected
// when the (possibly permission-gated) write finally resolves.
//
// The page is index.html in jsdom (tests/support/index-page.mjs), so
// createUiController/init run headless against the real markup, and clicks
// are real events that bubble to the grid's delegated listeners.
import { installIndexPage } from "../support/index-page.mjs";
import {
  channelRows,
  clickLocationButton,
  createDeferred,
  domEvent,
  flushMicrotasks,
  importSampleCsv,
  selectRadioBySearch,
  tableNames,
} from "../support/ui-interactions.mjs";
import { fakeRowCheck, withRadioSessions } from "../support/fake-runtime-api.mjs";

const SAMPLE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
  { Location: "2", Name: "Charlie", Frequency: "446.000000" },
];

test("cut deletes the rows captured at copy time, not the selection at write completion", async () => {
  const { document, navigator } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();

  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name", "Frequency"], columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: ["Location", "Name", "Frequency"], rows: SAMPLE_ROWS, errors: [] }),
  }));

  // init() leaves the grid empty, so the channels these assertions operate on
  // come from a CSV import (the stubbed parser returns SAMPLE_ROWS whatever
  // the file holds).
  await ui.init(true);
  await importSampleCsv(document);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Charlie"]);

  // Select Alpha, then trigger Cut; the clipboard write stays pending as if
  // parked behind a browser permission prompt.
  clickLocationButton(document, 0);
  const write = createDeferred();
  navigator.clipboard = { writeText: () => write.promise };
  document.querySelector("#channel-cut").dispatchEvent(domEvent({ type: "click" }));
  await flushMicrotasks();
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Charlie"]);

  // While the write is pending, the user selects Charlie instead.
  clickLocationButton(document, 2);

  write.resolve();
  await flushMicrotasks();

  // Alpha (the row that was serialized) is gone; Charlie survives.
  assert.deepEqual(tableNames(document), ["Bravo", "Charlie"]);
});

// Regression: radios with has_tuning_step=False (e.g. Baofeng UV-5R) mark
// TStep read-only; paste must still restore the copied value instead of
// silently resetting it to the first enum option. The runtime decides both
// halves (normalize_cell in web/python/webchirp_bridge/row_normalization.py,
// pinned by tests/channels/row-normalization.mjs) when a write is marked
// allowReadOnly; what the grid owes it is that mark, and one call for the
// whole paste.
test("paste preserves read-only column values and matches unpadded numeric enums", async () => {
  const { document, navigator } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();

  const headers = ["Location", "Name", "Frequency", "TStep"];
  const columns = {
    TStep: {
      kind: "enum",
      editable: false,
      options: ["2.50", "5.00", "6.25", "10.00", "12.50", "25.00"],
    },
  };
  // The runtime's answer for this radio's read-only TStep: refused from a
  // cell edit, matched by numeric value from a paste.
  const rowCheck = fakeRowCheck({
    verdict(column, value, previous, { allowReadOnly }) {
      if (column !== "TStep") {
        return { value, accepted: true };
      }
      const match = columns.TStep.options.find((option) => Number.parseFloat(option) === Number.parseFloat(value));
      return allowReadOnly && match ? { value: match, accepted: true } : { value: previous, accepted: false };
    },
  });
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers, columns }),
    normalizeAndValidateRows: rowCheck.normalizeAndValidateRows,
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers, rows: [], errors: [] }),
  }));

  await ui.init(true);
  // Without a selected radio the driver's column metadata is never fetched.
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();

  // Header-mapped TSV as produced by Copy (TStep "5.00") plus a
  // spreadsheet-style unpadded value ("12.5") that must match "12.50".
  const tsv =
    "Name\tFrequency\tTStep\n" +
    "Alpha\t146.520000\t5.00\n" +
    "Bravo\t146.940000\t12.5\n";
  navigator.clipboard = { readText: async () => tsv };
  document.querySelector("#channel-paste").dispatchEvent(domEvent({ type: "click" }));
  await flushMicrotasks();

  const tstepValues = channelRows(document).map((tr) => tr.children[3]?.children[0]?.value ?? "");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo"]);
  assert.deepEqual(tstepValues, ["5.00", "12.50"]);

  // One runtime call for the paste, carrying both rows, every write marked as
  // a builder's so the read-only column may take it.
  assert.equal(rowCheck.calls.length, 1);
  assert.equal(rowCheck.calls[0].rows.length, 2);
  const tstepEdits = rowCheck.calls[0].rows.map(({ edits }) => edits.find((edit) => edit.column === "TStep"));
  assert.deepEqual(tstepEdits, [
    { column: "TStep", value: "5.00", allowReadOnly: true },
    { column: "TStep", value: "12.5", allowReadOnly: true },
  ]);
});

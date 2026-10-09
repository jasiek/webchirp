import assert from "node:assert/strict";
import test from "node:test";

// A committed cell goes to the runtime (normalize_and_validate_rows,
// web/python/webchirp_bridge/row_validation.py), which stores the value by
// the radio's own rules and judges the row with the driver's validate_memory.
// That call waits in the runtime's FIFO queue, so the grid shows the typed
// value at once, marked pending, and takes the answer when it comes -- but
// only while it still describes the row: a second edit of the row or a change
// of radio makes an older answer stale (submitRowEdits in
// web/js/ui/channel-table.ts).
//
// The rules themselves are pinned against the real runtime by
// tests/channels/row-normalization.mjs and tests/channels/row-edit-check.mjs;
// here the runtime is a stand-in (fakeRowCheck) whose answers each test
// controls, so what is tested is what the grid does with them.
import {
  channelRows,
  clickLocationButton,
  flushMicrotasks,
  importSampleCsv,
  installFakeDom,
  selectRadioBySearch,
} from "../support/fake-dom.mjs";
import { fakeRowCheck, withRadioSessions } from "../support/fake-runtime-api.mjs";

const HEADERS = ["Location", "Name", "Frequency"];
const SAMPLE_ROWS = [
  { Location: "0", Name: "ALPHA", Frequency: "146.520000" },
  { Location: "1", Name: "BRAVO", Frequency: "146.940000" },
];
const COLUMNS = {
  Location: { kind: "int", editable: false, min: 0, max: 127 },
  Name: { kind: "text", editable: true, maxLength: 7 },
  Frequency: { kind: "freq", editable: true, bands: [[144_000_000, 148_000_000]] },
};
const RADIOS = [
  { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
  { vendor: "Acme", model: "Two", module: "two", className: "TwoRadio", key: "two:TwoRadio", isLiveRadio: false },
];

// What each stand-in radio does to a Name: radio One cuts it to 5 characters
// and says so, radio Two to 3. Different answers per radio are what let a test
// see whose answer a cell took.
function nameVerdict(column, value, _previous, { payload }) {
  if (column !== "Name") {
    return { value, accepted: true };
  }
  const limit = payload.module === "two" ? 3 : 5;
  return value.length > limit
    ? { value: value.slice(0, limit), accepted: true, note: `Truncated to ${limit} characters` }
    : { value, accepted: true };
}

async function grid(rowCheckOptions = {}) {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  const rowCheck = fakeRowCheck({ verdict: nameVerdict, ...rowCheckOptions });
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: RADIOS }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: COLUMNS }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: SAMPLE_ROWS.map((row) => ({ ...row })), errors: [] }),
    normalizeAndValidateRows: rowCheck.normalizeAndValidateRows,
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();
  await importSampleCsv(document);
  return { document, rowCheck };
}

function cell(document, rowIdx, column) {
  return channelRows(document)[rowIdx].children[HEADERS.indexOf(column)];
}

// Type into a cell and leave it, as a user does: the editor loses focus and
// the grid commits what it holds.
function commit(document, rowIdx, column, text) {
  const editor = cell(document, rowIdx, column).children[0];
  editor.value = text;
  document.activeElement = editor;
  document.querySelector("#mem-table tbody").dispatchEvent({ type: "focusout", target: editor });
  document.activeElement = null;
}

test("a committed cell shows what was typed, pending, then what the runtime stored", async () => {
  const { document, rowCheck } = await grid({ held: true });

  commit(document, 0, "Name", "LONGNAME");
  await flushMicrotasks();

  // Pending: the typed text, still editable, marked as not yet answered.
  assert.equal(cell(document, 0, "Name").children[0].value, "LONGNAME");
  assert.equal(cell(document, 0, "Name").children[0].disabled, false);
  assert.equal(cell(document, 0, "Name").classList.contains("is-pending"), true);
  assert.equal(rowCheck.calls.length, 1, "one call for one committed cell");
  assert.deepEqual(rowCheck.calls[0].rows[0].edits, [{ column: "Name", value: "LONGNAME" }]);
  // The row is sent as it stood before the edit, so a refused value can fall
  // back to what the cell held.
  assert.equal(rowCheck.calls[0].rows[0].row.Name, "ALPHA");

  rowCheck.release();
  await flushMicrotasks();

  assert.equal(cell(document, 0, "Name").children[0].value, "LONGN");
  assert.equal(cell(document, 0, "Name").classList.contains("is-pending"), false);
  assert.equal(cell(document, 0, "Name").title, "Truncated to 5 characters");
  assert.match(document.querySelector("#debug-output").value, /ROW CHECK channel=0 column=Name: Truncated to 5 characters/);
});

test("leaving a cell without changing it asks the runtime nothing", async () => {
  const { document, rowCheck } = await grid();

  commit(document, 1, "Name", "BRAVO");
  await flushMicrotasks();

  assert.equal(rowCheck.calls.length, 0);
});

test("a driver's objection to the row is shown when the cell is committed", async () => {
  const { document } = await grid({
    // The driver refuses this frequency although the column's bands allow it,
    // as the UV-5R's does for 220 MHz (tests/channels/row-edit-check.mjs).
    findings: (row) => (row.Frequency === "147.000000"
      ? { issues: [{ column: "Frequency", message: "Frequency 147.000000 is out of supported range" }], warnings: [] }
      : { issues: [], warnings: [] }),
  });

  commit(document, 1, "Frequency", "147.000000");
  await flushMicrotasks();

  const frequency = cell(document, 1, "Frequency");
  assert.equal(frequency.children[0].value, "147.000000", "the value is kept: it is the driver's to refuse at upload");
  assert.equal(frequency.classList.contains("is-invalid"), true);
  assert.equal(frequency.title, "Frequency 147.000000 is out of supported range");
  assert.match(
    document.querySelector("#debug-output").value,
    /ROW CHECK INVALID channel=1 column=Frequency: Frequency 147\.000000 is out of supported range/,
  );

  // Fixing the value clears the mark: the row is judged again and the driver
  // has nothing more to say.
  commit(document, 1, "Frequency", "146.000000");
  await flushMicrotasks();
  assert.equal(cell(document, 1, "Frequency").classList.contains("is-invalid"), false);
  assert.equal(cell(document, 1, "Frequency").title, "");
});

test("an answer overtaken by a second edit of the cell is discarded", async () => {
  const { document, rowCheck } = await grid({ held: true });

  commit(document, 0, "Name", "FIRSTEDIT");
  await flushMicrotasks();
  commit(document, 0, "Name", "SECONDEDIT");
  await flushMicrotasks();
  assert.equal(rowCheck.calls.length, 2);
  // The second request carries the latest text against the value the cell
  // held before either edit, so it alone can settle the cell.
  assert.deepEqual(rowCheck.calls[1].rows[0].edits, [{ column: "Name", value: "SECONDEDIT" }]);
  assert.equal(rowCheck.calls[1].rows[0].row.Name, "ALPHA");

  // The first answer arrives first and describes a value the cell no longer
  // holds: it must not land.
  rowCheck.release(0);
  await flushMicrotasks();
  assert.equal(cell(document, 0, "Name").children[0].value, "SECONDEDIT");
  assert.equal(cell(document, 0, "Name").classList.contains("is-pending"), true);

  rowCheck.release();
  await flushMicrotasks();
  assert.equal(cell(document, 0, "Name").children[0].value, "SECON");
  assert.equal(cell(document, 0, "Name").classList.contains("is-pending"), false);
});

test("an answer for a radio no longer selected is discarded and the edit checked again", async () => {
  const { document, rowCheck } = await grid({ held: true });

  commit(document, 0, "Name", "LONGNAME");
  await flushMicrotasks();
  assert.equal(rowCheck.calls[0].module, "one");

  selectRadioBySearch(document, "Acme Two");
  await flushMicrotasks();

  // Radio One's answer (5 characters) arrives after the change: discarded,
  // and the still-pending edit is sent again for radio Two.
  rowCheck.release(0);
  await flushMicrotasks();
  assert.equal(cell(document, 0, "Name").children[0].value, "LONGNAME");
  assert.equal(rowCheck.calls.length, 2);
  assert.equal(rowCheck.calls[1].module, "two");
  assert.deepEqual(rowCheck.calls[1].rows[0].edits, [{ column: "Name", value: "LONGNAME" }]);

  rowCheck.release();
  await flushMicrotasks();
  assert.equal(cell(document, 0, "Name").children[0].value, "LON");
  assert.equal(cell(document, 0, "Name").classList.contains("is-pending"), false);
});

test("a paste is checked in one call, however many rows and cells it writes", async () => {
  const { document, rowCheck } = await grid();
  const navigator = globalThis.navigator;
  navigator.clipboard = {
    readText: async () => "Name\tFrequency\nCHARLIE\t145.100000\nDELTA\t145.200000\nECHO\t145.300000\n",
  };

  document.querySelector("#channel-paste").dispatchEvent({ type: "click" });
  await flushMicrotasks();

  assert.equal(rowCheck.calls.length, 1);
  assert.equal(rowCheck.calls[0].rows.length, 3);
  assert.deepEqual(
    rowCheck.calls[0].rows.map(({ edits }) => edits.map(({ column }) => column)),
    [["Name", "Frequency"], ["Name", "Frequency"], ["Name", "Frequency"]],
  );
  // The runtime's answer is what the grid shows.
  const names = channelRows(document).map((tr) => tr.children[1].children[0].value);
  assert.deepEqual(names, ["ALPHA", "BRAVO", "CHARL", "DELTA", "ECHO"]);
});

test("an answer for a row that moved to another memory is discarded and the edit checked again", async () => {
  // Review of #224: Move Up/Down hands the channel a different memory, and
  // the driver's findings depend on the memory the row lands on, so an answer
  // computed for the old one must not be applied.
  const { document, rowCheck } = await grid({ held: true });

  commit(document, 0, "Name", "LONGNAME");
  await flushMicrotasks();
  assert.equal(rowCheck.calls[0].rows[0].row.Location, "0");

  clickLocationButton(document, 0);
  document.querySelector("#channel-move-down").dispatchEvent({ type: "click" });
  await flushMicrotasks();

  rowCheck.release(0);
  await flushMicrotasks();
  const moved = () => cell(document, 1, "Name");
  assert.equal(moved().children[0].value, "LONGNAME", "the answer for memory 0 did not land");
  assert.equal(moved().classList.contains("is-pending"), true);
  assert.equal(rowCheck.calls.length, 2, "the edit is checked again where the channel now is");
  assert.equal(rowCheck.calls[1].rows[0].row.Location, "1");
  assert.deepEqual(rowCheck.calls[1].rows[0].edits, [{ column: "Name", value: "LONGNAME" }]);

  rowCheck.release();
  await flushMicrotasks();
  assert.equal(moved().children[0].value, "LONGN");
  assert.equal(moved().classList.contains("is-pending"), false);
});

test("a band plan built against a radio no longer selected is built again for the new one", async () => {
  // Review of #224: a builder awaiting the runtime's verdicts used to take the
  // answer for the radio it started on even after the user picked another,
  // and inserted rows normalized by the wrong driver.
  const { document, rowCheck } = await grid({ held: true });

  document.querySelector("#channel-add-pmr446").dispatchEvent({ type: "click" });
  await flushMicrotasks();
  assert.equal(rowCheck.calls.length, 1);
  assert.equal(rowCheck.calls[0].module, "one");

  selectRadioBySearch(document, "Acme Two");
  await flushMicrotasks();
  rowCheck.release(0);
  await flushMicrotasks();

  // Radio One's verdicts are dropped and the builder asks radio Two.
  assert.equal(rowCheck.calls.length, 2);
  assert.equal(rowCheck.calls[1].module, "two");
  assert.equal(channelRows(document).length, 2, "nothing is inserted on a stale answer");

  rowCheck.release();
  await flushMicrotasks();
  rowCheck.release();
  await flushMicrotasks();
  const names = channelRows(document).map((tr) => tr.children[1].children[0].value);
  assert.equal(names.length, 18);
  assert.deepEqual(names.slice(2), Array(16).fill("PMR"), "radio Two cuts names to 3 characters");
});

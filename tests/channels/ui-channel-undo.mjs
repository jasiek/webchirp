import assert from "node:assert/strict";
import test from "node:test";

// Undo and redo of the channel grid (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z;
// recordUndoStep and friends in web/js/ui/channel-table.ts). Every edit
// records the rows as they were before it; loading another codeplug clears
// the history.
import { installIndexPage } from "../support/index-page.mjs";
import {
  channelRows,
  clickLocationButton,
  dispatch,
  flushMicrotasks,
  importSampleCsv,
  selectRadioBySearch,
  tableNames,
} from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const HEADERS = ["Location", "Name", "Frequency"];
const ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
  { Location: "4", Name: "Delta", Frequency: "147.000000" },
];

async function boot() {
  const { document, window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({
      headers: HEADERS,
      columns: { Location: { kind: "int", editable: false, min: 0, max: 9 } },
    }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: ROWS.map((row) => ({ ...row })), errors: [] }),
  }));
  await ui.init(true);
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();
  await importSampleCsv(document);
  return { document, window };
}

async function press(document, window, key, { shift = false, target = document.body } = {}) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: shift, bubbles: true }));
  await flushMicrotasks();
}

function lastStatus(document) {
  const lines = document.querySelector("#debug-output").value.split("\n");
  return lines.filter((line) => line.includes("STATUS ")).at(-1)?.replace(/^.*STATUS /, "") ?? "";
}

function nameEditor(document, index) {
  return channelRows(document)[index].children[1].children[0];
}

async function typeName(document, index, value) {
  const editor = nameEditor(document, index);
  editor.focus();
  editor.value = value;
  editor.blur();
  await flushMicrotasks();
}

test("Ctrl+Z undoes a cell edit and Ctrl+Y redoes it", async () => {
  const { document, window } = await boot();
  await typeName(document, 1, "Brava");
  assert.deepEqual(tableNames(document), ["Alpha", "Brava", "Delta"]);

  await press(document, window, "z");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);
  assert.equal(lastStatus(document), "Undo: Edit Name of channel 1.");

  await press(document, window, "y");
  assert.deepEqual(tableNames(document), ["Alpha", "Brava", "Delta"]);
  assert.equal(lastStatus(document), "Redo: Edit Name of channel 1.");

  // Ctrl+Shift+Z redoes too.
  await press(document, window, "z");
  await press(document, window, "z", { shift: true });
  assert.deepEqual(tableNames(document), ["Alpha", "Brava", "Delta"]);
});

test("undo steps back through edits one at a time, and a new edit drops redo", async () => {
  const { document, window } = await boot();
  clickLocationButton(document, 2);
  await dispatch(document.querySelector("#channel-remove"), "click");
  await typeName(document, 0, "Alfa");
  assert.deepEqual(tableNames(document), ["Alfa", "Bravo"]);

  await press(document, window, "z");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo"]);
  await press(document, window, "z");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);
  await press(document, window, "z");
  assert.equal(lastStatus(document), "Nothing to undo.");

  await press(document, window, "y");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo"]);
  await typeName(document, 1, "Bravissimo");
  await press(document, window, "y");
  assert.equal(lastStatus(document), "Nothing to redo.");
});

test("undo takes back a band plan, Insert and a move", async () => {
  const { document, window } = await boot();
  await dispatch(document.querySelector("#channel-add-murs"), "click");
  await flushMicrotasks();
  assert.equal(channelRows(document).length, 8);
  await press(document, window, "z");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);

  await dispatch(document.querySelector("#channel-insert"), "click");
  assert.equal(channelRows(document).length, 4);
  await press(document, window, "z");
  assert.equal(channelRows(document).length, 3);

  clickLocationButton(document, 0);
  await dispatch(document.querySelector("#channel-move-down"), "click");
  assert.deepEqual(tableNames(document), ["Bravo", "Alpha", "Delta"]);
  await press(document, window, "z");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);
});

test("in a cell with uncommitted typing the browser's own undo wins", async () => {
  const { document, window } = await boot();
  await typeName(document, 1, "Brava");
  const editor = nameEditor(document, 0);
  editor.focus();
  editor.value = "Alph";
  const event = new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  editor.dispatchEvent(event);
  await flushMicrotasks();
  assert.equal(event.defaultPrevented, false, "left to the browser");
  assert.equal(nameEditor(document, 1).value, "Brava", "the grid was not undone");

  // In a cell whose value is committed, the keys undo the grid.
  editor.value = "Alpha";
  await press(document, window, "z", { target: editor });
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);
});

// With channels already loaded, importing asks whether to replace or merge.
async function importAgain(document, choice) {
  await importSampleCsv(document);
  await dispatch(document.querySelector(`#import-choice-${choice}`), "click");
  await flushMicrotasks();
}

test("loading another codeplug clears the history", async () => {
  const { document, window } = await boot();
  await typeName(document, 1, "Brava");
  await importAgain(document, "replace");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);
  await press(document, window, "z");
  assert.equal(lastStatus(document), "Nothing to undo.");
});

test("merging an import is undone like an edit", async () => {
  const { document, window } = await boot();
  await importAgain(document, "merge");
  assert.equal(channelRows(document).length, 6);
  await press(document, window, "z");
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta"]);
});

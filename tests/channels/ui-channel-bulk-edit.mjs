import assert from "node:assert/strict";
import test from "node:test";

import {
  channelRows,
  clickLocationButton,
  flushMicrotasks,
  installFakeDom,
  keydownEvent,
} from "../support/fake-dom.mjs";

// The bulk channel editor (web/js/ui/channel-bulk-edit.js), issue #146: one
// modal that writes the fields the user ticked onto every selected channel.
//
// Driven through createUiController, like the per-channel extras editor tests,
// because what the modal offers is decided by the grid's schema and by what the
// driver reports -- not by the module in isolation.
const HEADERS = ["Location", "Name", "Frequency", "Mode", "Power", "Comment"];

const COLUMNS = {
  Location: { kind: "int", min: 0, max: 127, editable: false },
  Name: { kind: "text", maxLength: 7, editable: true },
  Frequency: { kind: "freq", bands: [[136_000_000, 174_000_000], [400_000_000, 480_000_000]], editable: true },
  Mode: { kind: "enum", options: ["FM", "NFM"], default: "FM", editable: true },
  Power: { kind: "enum", options: ["High", "Low"], default: "High", editable: true },
  // Read-only for this radio: the modal must not offer a field the grid itself
  // refuses to write.
  Comment: { kind: "text", editable: false },
};

const RADIO = {
  vendor: "Baofeng",
  model: "BF-888",
  module: "h777",
  className: "H777Radio",
  key: "h777:H777Radio",
  isLiveRadio: false,
};

const EXTRA_FIELDS = [
  { name: "bcl", label: "Busy Channel Lockout", type: "boolean", mutable: true, current: false },
  { name: "scode", label: "S-CODE", type: "enum", options: ["1", "2", "3"], mutable: true, current: "1" },
  { name: "voxlevel", label: "VOX level", type: "integer", min: 0, max: 5, mutable: false, current: 3 },
];

const IMAGE_ROWS = [
  { Location: "1", Name: "Alpha", Frequency: "145.500000", Mode: "FM", Power: "High", Comment: "one" },
  { Location: "2", Name: "Bravo", Frequency: "145.600000", Mode: "NFM", Power: "Low", Comment: "two" },
  { Location: "3", Name: "Charlie", Frequency: "145.700000", Mode: "FM", Power: "High", Comment: "three" },
];

async function boot({ getChannelExtra } = {}) {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi({
    listRadios: async () => ({ radios: [RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: COLUMNS }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
    loadImage: async () => ({
      module: RADIO.module,
      className: RADIO.className,
      vendor: RADIO.vendor,
      model: RADIO.model,
      headers: HEADERS,
      rows: IMAGE_ROWS.map((row) => ({ ...row })),
      settings: [],
    }),
    getChannelExtra: async (payload) =>
      (getChannelExtra ? getChannelExtra(payload) : { available: true, message: "", fields: EXTRA_FIELDS }),
  });
  await ui.init(true);
  // index.html ships every modal hidden; the DOM stub vivifies elements with no
  // classes, so without this the Escape handler finds them all "open".
  for (const selector of ["#channel-extra-modal", "#channel-bulk-edit-modal", "#import-choice-modal"]) {
    document.querySelector(selector).classList.add("hidden");
  }

  const imgInput = document.querySelector("#img-file");
  imgInput.files = [{
    name: "codeplug.img",
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  }];
  imgInput.dispatchEvent({ type: "change" });
  await flushMicrotasks();

  // Captured with nothing selected, which is when selectedRowsForOperations()
  // hands back the live row array itself -- the row objects the modal mutates.
  const allRows = ui.selectedRowsForOperations();
  return { document, rows: () => allRows, status: () => document.querySelector("#debug-output").value };
}

function modalIsOpen(document) {
  return !document.querySelector("#channel-bulk-edit-modal").classList.contains("hidden");
}

async function openBulkEditor(document) {
  document.querySelector("#channel-bulk-edit").dispatchEvent({ type: "click" });
  await flushMicrotasks();
}

function fieldNames(document) {
  return document.querySelector("#channel-bulk-edit-grid")
    .querySelectorAll("[name]")
    .map((el) => el.name);
}

function controlFor(document, name) {
  return document.querySelector("#channel-bulk-edit-grid").querySelector(`[name="${name}"]`);
}

// Tick a field's opt-in checkbox and give its control a value.
function setField(document, name, value) {
  const control = controlFor(document, name);
  assert.ok(control, `no bulk field named ${name}`);
  control.value = String(value);
  const toggle = document.querySelector("#channel-bulk-edit-grid")
    .querySelector(`[data-field="${name}"]`);
  assert.ok(toggle, `no opt-in checkbox for ${name}`);
  toggle.checked = true;
}

async function applyModal(document) {
  await document.querySelector("#channel-bulk-edit-form").dispatch("submit");
  await flushMicrotasks();
}

// All rows in grid order, read out of the rendered editors.
function gridValues(document, columnIdx) {
  return channelRows(document).map((tr) => tr.children[columnIdx]?.children[0]?.value ?? "");
}

test("the modal offers one field per editable column, plus the driver's extras", async () => {
  const { document } = await boot();
  clickLocationButton(document, 0);
  await openBulkEditor(document);
  assert.ok(modalIsOpen(document));
  assert.deepEqual(fieldNames(document), [
    // Location is the memory slot and Comment is read-only on this radio;
    // neither may be offered. The immutable extra is dropped for the same
    // reason.
    "column:Name",
    "column:Frequency",
    "column:Mode",
    "column:Power",
    "extra:bcl",
    "extra:scode",
  ]);
  assert.match(
    document.querySelector("#channel-bulk-edit-title").textContent,
    /Edit 1 selected channel$/,
  );
});

test("only the ticked fields are written, and to every selected channel", async () => {
  const { document, rows } = await boot();
  clickLocationButton(document, 0);
  clickLocationButton(document, 1, { ctrlKey: true });
  await openBulkEditor(document);
  assert.match(
    document.querySelector("#channel-bulk-edit-title").textContent,
    /Edit 2 selected channels$/,
  );
  setField(document, "column:Mode", "NFM");
  setField(document, "column:Power", "Low");
  // Set on the control but never ticked: it must not reach a single row.
  controlFor(document, "column:Name").value = "ZZZ";
  await applyModal(document);

  assert.equal(modalIsOpen(document), false);
  const all = rows();
  // The third channel was not selected, so it keeps its own Mode and Power.
  assert.deepEqual(all.map((row) => row.Mode), ["NFM", "NFM", "FM"]);
  assert.deepEqual(all.map((row) => row.Power), ["Low", "Low", "High"]);
  // Name was typed into but never ticked, so no row picked it up.
  assert.deepEqual(all.map((row) => row.Name), ["Alpha", "Bravo", "Charlie"]);
  // And the grid shows what the rows now hold.
  assert.deepEqual(gridValues(document, HEADERS.indexOf("Mode")), ["NFM", "NFM", "FM"]);
});

test("driver extras are stored per row under the row sidecar", async () => {
  const { document, rows } = await boot();
  clickLocationButton(document, 0);
  clickLocationButton(document, 1, { shiftKey: true });
  await openBulkEditor(document);
  setField(document, "extra:bcl", "On");
  setField(document, "extra:scode", "3");
  await applyModal(document);

  const all = rows();
  assert.deepEqual(all[0].__extra, { bcl: true, scode: "3" });
  assert.deepEqual(all[1].__extra, { bcl: true, scode: "3" });
  assert.equal(all[2].__extra, undefined, "an unselected channel gains no sidecar");
});

test("a value the driver rejects leaves the channel as it was and is reported", async () => {
  const { document, rows, status } = await boot();
  clickLocationButton(document, 0);
  await openBulkEditor(document);
  // Out of every band this radio advertises, so normalizeCellValue rejects it.
  setField(document, "column:Frequency", "999.000000");
  await applyModal(document);

  assert.equal(rows()[0].Frequency, "145.500000");
  assert.match(status(), /rejected/);
});

test("applying with nothing ticked changes no channel", async () => {
  const { document, rows } = await boot();
  clickLocationButton(document, 0);
  await openBulkEditor(document);
  await applyModal(document);
  assert.equal(modalIsOpen(document), false);
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"]);
});

test("the button says what to do rather than editing the whole grid", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document);
  assert.equal(modalIsOpen(document), false, "nothing selected, so there is nothing to bulk edit");
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"]);
});

test("a driver with no extras still offers the column fields", async () => {
  const { document } = await boot({
    getChannelExtra: async () => ({ available: false, message: "No extras here.", fields: [] }),
  });
  clickLocationButton(document, 0);
  await openBulkEditor(document);
  assert.deepEqual(
    fieldNames(document),
    ["column:Name", "column:Frequency", "column:Mode", "column:Power"],
  );
});

test("a failed extras read leaves the modal usable and says so", async () => {
  const { document, rows } = await boot({
    getChannelExtra: async () => {
      throw new Error("driver exploded");
    },
  });
  clickLocationButton(document, 0);
  await openBulkEditor(document);
  assert.ok(modalIsOpen(document));
  assert.match(
    document.querySelector("#channel-bulk-edit-message").textContent,
    /could not be read/,
  );
  setField(document, "column:Mode", "NFM");
  await applyModal(document);
  assert.equal(rows()[0].Mode, "NFM");
});

test("Escape closes the bulk editor", async () => {
  const { document } = await boot();
  clickLocationButton(document, 0);
  await openBulkEditor(document);
  document.dispatchEvent(keydownEvent("Escape"));
  assert.equal(modalIsOpen(document), false);
});

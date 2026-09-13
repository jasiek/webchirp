import assert from "node:assert/strict";
import test from "node:test";

// The bulk-edit modal (web/js/ui/channel-bulk-edit.js): one checkbox/label/
// control row per editable grid column plus the driver's per-channel extras,
// writing only the checked fields onto every selected channel.
//
// Driven through createUiController rather than the module alone, because what
// the modal offers is decided elsewhere -- the column schema by the selected
// radio, the extras by the runtime, the selection by the grid.
import {
  clickLocationButton,
  flushMicrotasks,
  importSampleCsv,
  installFakeDom,
  selectRadioBySearch,
} from "../support/fake-dom.mjs";

const HEADERS = ["Location", "Name", "Frequency", "Mode", "Comment"];

const COLUMNS = {
  Location: { kind: "int", editable: false, min: 0, max: 127 },
  Name: { kind: "text", editable: true, maxLength: 7 },
  Frequency: { kind: "freq", editable: true, bands: [[136000000, 174000000]] },
  Mode: { kind: "enum", editable: true, options: ["FM", "NFM"] },
  Comment: { kind: "text", editable: true },
};

const SAMPLE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000", Mode: "FM", Comment: "" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000", Mode: "FM", Comment: "" },
  { Location: "2", Name: "Charlie", Frequency: "145.500000", Mode: "FM", Comment: "" },
];

// One mutable extra and one the driver refuses to write: bulk-edit offers only
// the first, because a checkbox for a value no channel can accept is clutter.
const EXTRA_FIELDS = [
  {
    name: "bcl",
    label: "Busy Channel Lockout",
    doc: "Prevents transmitting on a channel that is already in use",
    type: "boolean",
    mutable: true,
    current: false,
  },
  { name: "voxlevel", label: "VOX level", type: "integer", min: 0, max: 5, mutable: false, current: 3 },
];

async function boot() {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const extraCalls = [];
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [{
        vendor: "Baofeng",
        model: "BF-888",
        module: "h777",
        className: "H777Radio",
        key: "h777:H777Radio",
        isLiveRadio: false,
      }],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS, columns: COLUMNS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: COLUMNS }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
    parseCsv: async () => ({ headers: HEADERS, rows: SAMPLE_ROWS.map((row) => ({ ...row })), errors: [] }),
    getChannelExtra: async (payload) => {
      extraCalls.push(payload);
      return { available: true, message: "", fields: EXTRA_FIELDS };
    },
  });
  await ui.init(true);
  // index.html ships every modal hidden; the DOM stub vivifies elements with
  // no classes at all, so isModalOpen() would read them all as open.
  for (const selector of ["#channel-bulk-edit-modal", "#channel-extra-modal", "#import-choice-modal"]) {
    document.querySelector(selector).classList.add("hidden");
  }
  selectRadioBySearch(document, "Baofeng BF-888");
  await flushMicrotasks();
  await importSampleCsv(document);
  // Every row in the grid. selectedRowsForOperations() answers with the
  // selection whenever there is one, so the rows the edit ran on are
  // deselected first (ctrl-click toggles one off) -- which is also the only
  // way to read back the channels the edit was supposed to leave alone.
  function allRows(selected = []) {
    for (const rowIdx of selected) {
      clickLocationButton(document, rowIdx, { ctrlKey: true });
    }
    return ui.selectedRowsForOperations();
  }
  return { document, extraCalls, allRows };
}

// Selects the given grid rows and opens the modal on them.
async function openBulkEdit(document, rowIndexes) {
  rowIndexes.forEach((rowIdx, position) => {
    clickLocationButton(document, rowIdx, position === 0 ? {} : { ctrlKey: true });
  });
  document.querySelector("#channel-bulk-edit").dispatchEvent({ type: "click" });
  await flushMicrotasks();
}

// One field's three cells, found from its value control: the control carries
// the field name, and the grid holds toggle/label/control in that order.
function fieldRow(document, name) {
  const grid = document.querySelector("#channel-bulk-edit-grid");
  const control = grid.querySelector(`[name="${name}"]`);
  assert.ok(control, `the modal has no control for ${name}`);
  const controlCell = control.parentNode;
  const index = grid.children.indexOf(controlCell);
  const labelCell = grid.children[index - 1];
  return {
    control,
    controlCell,
    labelCell,
    checkbox: grid.children[index - 2].children[0],
    label: labelCell.children[0].textContent,
    doc: labelCell.querySelector(".channel-bulk-edit-doc")?.textContent ?? "",
    dimmed: controlCell.classList.contains("is-off"),
  };
}

function modalIsOpen(document) {
  return !document.querySelector("#channel-bulk-edit-modal").classList.contains("hidden");
}

async function apply(document) {
  await document.querySelector("#channel-bulk-edit-form").dispatch("submit");
  await flushMicrotasks();
}

test("every field carries a description, columns from CHIRP and extras from the driver", async () => {
  const { document } = await boot();
  await openBulkEdit(document, [0, 1]);

  assert.ok(modalIsOpen(document));
  // CHIRP's own column help, composed in web/js/ui/column-docs.js and pinned
  // to the submodule by tests/build/column-docs.mjs.
  assert.equal(fieldRow(document, "Mode").doc, "Transmit/receive modulation (FM, AM, SSB, etc)");
  assert.equal(fieldRow(document, "Name").doc, "Memory label (stored in radio)");
  assert.equal(fieldRow(document, "Frequency").doc, "Receive frequency");
  assert.equal(fieldRow(document, "Comment").doc, "Human-readable comment (not stored in radio)");
  // An extra's description is the driver's, which is the only place it exists.
  assert.equal(
    fieldRow(document, "bcl").doc,
    "Prevents transmitting on a channel that is already in use",
  );

  const grid = document.querySelector("#channel-bulk-edit-grid");
  assert.equal(grid.querySelector('[name="Location"]'), null, "Location is a slot, not an attribute");
  assert.equal(grid.querySelector('[name="voxlevel"]'), null, "an immutable extra has nothing to offer");
});

test("every field starts unchecked, editable and dimmed", async () => {
  const { document } = await boot();
  await openBulkEdit(document, [0, 1]);

  for (const name of ["Name", "Mode", "bcl"]) {
    const field = fieldRow(document, name);
    assert.equal(field.checkbox.checked, false, `${name} should start unchecked`);
    assert.notEqual(field.control.disabled, true, `${name} must stay editable while unchecked`);
    assert.equal(field.dimmed, true, `${name} should read as not being written`);
  }
});

test("editing a field checks its box, and only that field's box", async () => {
  const { document } = await boot();
  await openBulkEdit(document, [0, 1]);

  const mode = fieldRow(document, "Mode");
  mode.control.value = "NFM";
  mode.control.dispatchEvent({ type: "change", target: mode.control });

  assert.equal(fieldRow(document, "Mode").checkbox.checked, true);
  assert.equal(fieldRow(document, "Mode").dimmed, false, "an opted-in field is no longer dimmed");
  assert.equal(fieldRow(document, "Name").checkbox.checked, false);

  // Typing counts too: a text field reports "input" long before "change".
  const name = fieldRow(document, "Name");
  name.control.value = "Delta";
  name.control.dispatchEvent({ type: "input", target: name.control });
  assert.equal(fieldRow(document, "Name").checkbox.checked, true);
});

test("applying writes only the checked fields, and only to the selected channels", async () => {
  const { document, allRows } = await boot();
  await openBulkEdit(document, [0, 1]);

  const mode = fieldRow(document, "Mode");
  mode.control.value = "NFM";
  mode.control.dispatchEvent({ type: "change", target: mode.control });
  const bcl = fieldRow(document, "bcl");
  bcl.control.checked = true;
  bcl.control.dispatchEvent({ type: "change", target: bcl.control });

  await apply(document);

  assert.equal(modalIsOpen(document), false, "a clean apply closes the modal");
  const after = allRows([0, 1]);
  assert.deepEqual(after.map((row) => row.Mode), ["NFM", "NFM", "FM"]);
  assert.deepEqual(after.map((row) => row.Name), ["Alpha", "Bravo", "Charlie"], "Name was never checked");
  assert.deepEqual(after.map((row) => row.__extra?.bcl), [true, true, undefined]);
});

test("unchecking a field keeps what was typed but leaves the channels alone", async () => {
  const { document, allRows } = await boot();
  await openBulkEdit(document, [0, 1]);

  const name = fieldRow(document, "Name");
  name.control.value = "Delta";
  name.control.dispatchEvent({ type: "input", target: name.control });
  const mode = fieldRow(document, "Mode");
  mode.control.value = "NFM";
  mode.control.dispatchEvent({ type: "change", target: mode.control });

  // Second thoughts about the name only.
  name.checkbox.checked = false;
  name.checkbox.dispatchEvent({ type: "change", target: name.checkbox });

  const reread = fieldRow(document, "Name");
  assert.equal(reread.control.value, "Delta", "the typed value survives being switched off");
  assert.equal(reread.dimmed, true);

  await apply(document);
  const after = allRows([0, 1]);
  assert.deepEqual(after.map((row) => row.Name), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(after.map((row) => row.Mode), ["NFM", "NFM", "FM"]);
});

test("a checked field with an invalid value blocks the whole apply", async () => {
  const { document, allRows } = await boot();
  await openBulkEdit(document, [0, 1]);

  const frequency = fieldRow(document, "Frequency");
  frequency.control.value = "not a frequency";
  frequency.control.dispatchEvent({ type: "input", target: frequency.control });
  const mode = fieldRow(document, "Mode");
  mode.control.value = "NFM";
  mode.control.dispatchEvent({ type: "change", target: mode.control });

  await apply(document);

  assert.equal(modalIsOpen(document), true, "the modal stays open on a rejected value");
  assert.equal(fieldRow(document, "Frequency").controlCell.classList.contains("is-invalid"), true);
  assert.deepEqual(
    allRows([0, 1]).map((row) => row.Mode),
    ["FM", "FM", "FM"],
    "one bad field must not let the good ones through",
  );
});

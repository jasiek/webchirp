import assert from "node:assert/strict";
import test from "node:test";

import {
  channelRows,
  clickLocationButton,
  flushMicrotasks,
  installFakeDom,
  keydownEvent,
} from "../support/fake-dom.mjs";

// The bulk editor (web/js/ui/channel-bulk-edit.js): the toolbar button the
// grid's selection gates, and the modal that writes one form into every
// selected channel.
//
// Driven through createUiController rather than the module alone, because the
// feature is a conversation between three parts -- the grid owns the
// selection, the driver owns the extras, and the modal owns what is written --
// and only the controller wires those together.
//
// The rows arrive through the binary import path: driver extras come off a
// radio or an image, never out of a CSV, so that is the load that produces the
// state the extras half of this form applies to.
const HEADERS = ["Location", "Name", "Frequency", "Mode", "TStep", "Comment"];

// CHIRP's own column metadata, as get_radio_metadata reports it. TStep is the
// read-only case: drivers with has_tuning_step=False publish it that way, and
// a column nobody may edit in a cell must not be editable in bulk either.
const COLUMNS = {
  Location: { kind: "int", min: 1, max: 128, editable: false },
  Name: { kind: "text", maxLength: 6, validChars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " },
  Frequency: { kind: "freq", bands: [[136_000_000, 174_000_000], [400_000_000, 480_000_000]] },
  Mode: { kind: "enum", options: ["FM", "NFM"] },
  TStep: { kind: "enum", options: ["5.00", "12.50"], editable: false },
  Comment: { kind: "text" },
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
  {
    Location: "1", Name: "ALPHA", Frequency: "446.006250", Mode: "FM", TStep: "5.00", Comment: "",
    __extra: { bcl: true },
  },
  { Location: "2", Name: "BRAVO", Frequency: "446.018750", Mode: "FM", TStep: "5.00", Comment: "" },
  { Location: "3", Name: "CHRLIE", Frequency: "446.031250", Mode: "NFM", TStep: "5.00", Comment: "" },
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
      rows: IMAGE_ROWS.map((row) => ({ ...row, __extra: row.__extra ? { ...row.__extra } : undefined })),
      settings: [],
    }),
    getChannelExtra: async (payload) => (
      getChannelExtra
        ? getChannelExtra(payload)
        : { available: true, message: "", fields: EXTRA_FIELDS }
    ),
  });
  await ui.init(true);
  // index.html ships every modal with the hidden class; the DOM stub vivifies
  // elements with no classes at all, so without this the Escape handler finds
  // the import prompt "open" and never reaches this editor.
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

  // Every row in the grid, not just the selected ones: selectedRowsForOperations
  // narrows to the selection when there is one, and an applied bulk edit leaves
  // the selection in place. Clearing it first is what a user does by
  // ctrl-clicking the row back off.
  function allRows() {
    for (const tr of channelRows(document)) {
      const rowIdx = Number(tr.dataset.rowIdx);
      if (tr.classList.contains("is-selected")) {
        clickLocationButton(document, rowIdx, { ctrlKey: true });
      }
    }
    return ui.selectedRowsForOperations();
  }

  return { document, rows: allRows };
}

function bulkButton(document) {
  return document.querySelector("#channel-bulk-edit");
}

function modalIsOpen(document) {
  return !document.querySelector("#channel-bulk-edit-modal").classList.contains("hidden");
}

function fieldNames(document) {
  return document.querySelector("#channel-bulk-edit-grid")
    .querySelectorAll("input, select")
    .map((control) => control.name)
    .filter((name) => !name.startsWith("apply-"));
}

function controlFor(document, name) {
  return document.querySelector("#channel-bulk-edit-grid").querySelector(`[name="${name}"]`);
}

function toggleFor(document, name) {
  return document.querySelector("#channel-bulk-edit-grid").querySelector(`[name="apply-${name}"]`);
}

// Selects the given rows the way a user does: click the first Location button,
// then ctrl-click the rest.
function selectRows(document, indexes) {
  indexes.forEach((rowIdx, position) => {
    clickLocationButton(document, rowIdx, position === 0 ? {} : { ctrlKey: true });
  });
}

async function openBulkEditor(document, indexes) {
  selectRows(document, indexes);
  bulkButton(document).click();
  await flushMicrotasks();
}

// Types a value into a field the way a user does, which is also what arms it.
function typeInto(document, name, value) {
  const control = controlFor(document, name);
  control.value = value;
  control.dispatchEvent({ type: "input" });
  return control;
}

async function applyModal(document) {
  await document.querySelector("#channel-bulk-edit-form").dispatch("submit");
  await flushMicrotasks();
}

test("the bulk-edit button is live only while channels are selected", async () => {
  const { document } = await boot();
  assert.equal(bulkButton(document).disabled, true, "nothing is selected after a load");

  clickLocationButton(document, 0);
  assert.equal(bulkButton(document).disabled, false);

  // Ctrl-clicking the same row again deselects it, which takes the button back
  // out: the grid's other actions fall back to every channel, and this one
  // must not.
  clickLocationButton(document, 0, { ctrlKey: true });
  assert.equal(bulkButton(document).disabled, true);
});

test("the form lists the editable columns and the driver's extras", async () => {
  const { document } = await boot();
  await openBulkEditor(document, [0, 1]);

  assert.ok(modalIsOpen(document));
  assert.deepEqual(
    fieldNames(document),
    [
      "column-Name",
      "column-Frequency",
      "column-Mode",
      "column-Comment",
      "extra-bcl",
      "extra-scode",
    ],
    "Location and the read-only TStep are absent, and so is the immutable extra",
  );
  assert.match(
    document.querySelector("#channel-bulk-edit-title").textContent,
    /2 selected channels/,
  );
  // Fields open on the first selected channel's own values -- the selection has
  // no single value to show, and that is the channel the user started from.
  assert.equal(controlFor(document, "column-Name").value, "ALPHA");
  assert.equal(controlFor(document, "extra-bcl").checked, true);
});

test("applying writes the armed fields into every selected channel", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 2]);

  typeInto(document, "column-Mode", "NFM");
  typeInto(document, "column-Comment", "Club net");
  await applyModal(document);

  assert.equal(modalIsOpen(document), false, "a successful apply closes the modal");
  const [first, second, third] = rows();
  assert.equal(first.Mode, "NFM");
  assert.equal(first.Comment, "Club net");
  assert.equal(third.Mode, "NFM");
  assert.equal(third.Comment, "Club net");
  // The unselected channel is untouched, and so is every field nobody armed.
  assert.equal(second.Mode, "FM");
  assert.equal(second.Comment, "");
  assert.equal(first.Name, "ALPHA", "a field left alone keeps each channel's own value");
  assert.equal(third.Name, "CHRLIE");
});

test("an armed extra reaches every selected channel's sidecar", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [1, 2]);

  typeInto(document, "extra-scode", "3");
  await applyModal(document);

  assert.deepEqual(rows()[1].__extra, { scode: "3" });
  assert.deepEqual(rows()[2].__extra, { scode: "3" });
  // The channel nobody selected keeps what it carried and gains nothing: an
  // empty sidecar is what tells the upload path to leave the driver's defaults
  // alone.
  assert.deepEqual(rows()[0].__extra, { bcl: true });
});

test("a field the user never touched is not written", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  // The Name field is showing channel 1's own ALPHA. Applying without arming it
  // must not spread that name over the selection.
  typeInto(document, "column-Mode", "NFM");
  await applyModal(document);

  assert.equal(rows()[1].Name, "BRAVO");
  assert.equal(rows()[1].Mode, "NFM");
});

test("ticking a field arms it without retyping the value it shows", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  const toggle = toggleFor(document, "column-Name");
  toggle.checked = true;
  toggle.dispatchEvent({ type: "change" });
  await applyModal(document);

  assert.equal(rows()[1].Name, "ALPHA", "the shown value is what a ticked field writes");
});

test("applying with nothing armed says so and leaves the form open", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);
  await applyModal(document);

  assert.equal(modalIsOpen(document), true);
  assert.match(
    document.querySelector("#channel-bulk-edit-message").textContent,
    /Tick at least one field/,
  );
  assert.equal(rows()[1].Name, "BRAVO", "nothing was written");
});

test("a value outside the driver's bounds blocks the apply", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  typeInto(document, "extra-scode", "2");
  typeInto(document, "column-Name", "THIS NAME IS FAR TOO LONG");
  await applyModal(document);

  assert.equal(modalIsOpen(document), true, "an invalid value keeps the form open");
  assert.match(
    document.querySelector("#channel-bulk-edit-message").textContent,
    /Fix 1 highlighted value/,
  );
  // Nothing at all is written, not even the field that was fine: a partial
  // apply the user has to finish by hand is worse than none.
  assert.equal(rows()[1].__extra, undefined);
});

test("a frequency the radio has no band for is reported, not stored", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  typeInto(document, "column-Frequency", "88.500000");
  await applyModal(document);

  assert.equal(rows()[0].Frequency, "446.006250", "the rejected write left the row alone");
  assert.match(
    document.querySelector("#debug-output").value,
    /did not accept the value given for Frequency/,
  );
});

test("a driver with no extras still offers the grid's own columns", async () => {
  const { document, rows } = await boot({
    getChannelExtra: async () => ({
      available: false,
      message: "This radio has no extra settings for its channels.",
      fields: [],
    }),
  });
  await openBulkEditor(document, [0, 1]);

  assert.deepEqual(
    fieldNames(document),
    ["column-Name", "column-Frequency", "column-Mode", "column-Comment"],
  );
  assert.match(
    document.querySelector("#channel-bulk-edit-message").textContent,
    /no extra settings/,
  );
  typeInto(document, "column-Mode", "NFM");
  await applyModal(document);
  assert.equal(rows()[1].Mode, "NFM");
});

test("Escape closes the editor without changing anything", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);
  typeInto(document, "column-Mode", "NFM");

  document.dispatchEvent(keydownEvent("Escape"));
  assert.equal(modalIsOpen(document), false);
  assert.equal(rows()[1].Mode, "FM");
});

test("a channel list replaced while the editor is open is not written to", async () => {
  const { document } = await boot();
  await openBulkEditor(document, [0, 1]);
  typeInto(document, "column-Mode", "NFM");

  // A second image load replaces state.currentRows wholesale, leaving the form
  // holding rows that are no longer in the grid.
  const imgInput = document.querySelector("#img-file");
  imgInput.files = [{ name: "other.img", arrayBuffer: async () => Uint8Array.from([5]).buffer }];
  imgInput.dispatchEvent({ type: "change" });
  await flushMicrotasks();
  await applyModal(document);

  assert.equal(modalIsOpen(document), false);
  assert.match(
    document.querySelector("#debug-output").value,
    /channel list changed while the bulk editor was open/,
  );
  assert.deepEqual(
    channelRows(document).map((tr) => tr.children[3]?.children[0]?.value),
    ["FM", "FM", "NFM"],
    "the freshly loaded channels keep their own modes",
  );
});

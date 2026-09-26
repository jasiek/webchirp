import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../support/repo-paths.mjs";
import {
  channelRows,
  closeVivifiedModals,
  clickLocationButton,
  createDeferred,
  flushMicrotasks,
  installFakeDom,
  keydownEvent,
  selectRadioBySearch,
  tableNames,
} from "../support/fake-dom.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

// The bulk channel editor (web/js/ui/channel-bulk-edit.js): the toolbar control
// that follows the grid selection, and the modal behind it.
//
// Driven through createUiController rather than the module alone, because the
// feature is a conversation between three modules -- the grid owns the
// selection, the shared state owns the schema, and the modal is what writes to
// both. The rows arrive through the binary import path because that is the only
// load that produces driver extras, which are half of what the modal offers.
const HEADERS = ["Location", "Name", "Frequency", "Mode", "Power", "Comment"];

// A column set covering every control shape the modal has to build: a
// constrained text column, a frequency, an enum the driver constrains, an enum
// whose CHIRP default is blank (Power), and one the driver marks read-only.
const COLUMNS = {
  Location: { kind: "int", editable: false, min: 0, max: 127 },
  Name: { kind: "text", editable: true, maxLength: 7, validChars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " },
  Frequency: { kind: "freq", editable: true, bands: [[136000000, 174000000], [400000000, 520000000]] },
  Mode: { kind: "enum", editable: true, options: ["FM", "NFM"], default: "FM" },
  Power: { kind: "enum", editable: true, options: ["High", "Low"], default: "" },
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

// A second driver to switch to while the modal is open, publishing a narrower
// schema: no Mode column at all, and Name read-only. Both are columns the modal
// offers under RADIO, which is what makes a stale apply worth refusing.
const OTHER_RADIO = {
  vendor: "Retevis",
  model: "RT22",
  module: "rt22",
  className: "RT22Radio",
  key: "rt22:RT22Radio",
  isLiveRadio: false,
};

const OTHER_HEADERS = ["Location", "Name", "Frequency", "Power", "Comment"];

const OTHER_COLUMNS = {
  Location: COLUMNS.Location,
  Name: { kind: "text", editable: false },
  Frequency: COLUMNS.Frequency,
  Power: COLUMNS.Power,
  Comment: COLUMNS.Comment,
};

const EXTRA_FIELDS = [
  {
    name: "bcl",
    label: "Busy Channel Lockout",
    doc: "Prevents transmitting on a channel that is already in use",
    type: "boolean",
    mutable: true,
    current: true,
  },
  {
    name: "scode",
    label: "S-CODE",
    type: "enum",
    options: ["1", "2", "3"],
    mutable: true,
    current: "1",
  },
  {
    name: "voxlevel",
    label: "VOX level",
    type: "integer",
    min: 0,
    max: 5,
    mutable: false,
    current: 3,
  },
];

const IMAGE_ROWS = [
  {
    Location: "1",
    Name: "ALPHA",
    Frequency: "145.500000",
    Mode: "FM",
    Power: "High",
    Comment: "",
    __extra: { bcl: false, scode: "3" },
  },
  {
    Location: "2",
    Name: "BRAVO",
    Frequency: "145.600000",
    Mode: "NFM",
    Power: "High",
    Comment: "",
  },
  {
    Location: "3",
    Name: "CHARLIE",
    Frequency: "145.700000",
    Mode: "FM",
    Power: "Low",
    Comment: "",
  },
];

async function boot({ rows = IMAGE_ROWS, getChannelExtra, radios = [RADIO], uploadIssues = [] } = {}) {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const extraCalls = [];
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async (payload) => (payload?.module === OTHER_RADIO.module
      ? { headers: OTHER_HEADERS, columns: OTHER_COLUMNS }
      : { headers: HEADERS, columns: COLUMNS }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
    loadImage: async () => ({
      module: RADIO.module,
      className: RADIO.className,
      vendor: RADIO.vendor,
      model: RADIO.model,
      headers: HEADERS,
      rows: rows.map((row) => ({ ...row })),
      settings: [],
    }),
    // The upload preflight, which is what marks cells invalid. Only interesting
    // when a test asks for issues; the early return in uploadToRadio
    // (web/js/ui/serial-actions.js) means a blocked upload never reaches the
    // serial port, so driving it needs no connection.
    validateRowsForUpload: async () => ({ valid: uploadIssues.length === 0, issues: uploadIssues, warnings: [] }),
    validateRadioSettings: async () => ({ valid: true, issues: [], settings: [] }),
    getChannelExtra: async (payload) => {
      extraCalls.push(payload);
      return getChannelExtra
        ? getChannelExtra(payload)
        : { available: true, message: "", fields: EXTRA_FIELDS };
    },
  }));
  await ui.init(true);
  closeVivifiedModals(document);

  // Every row the grid holds, captured at load time. The controller only
  // exposes selectedRowsForOperations(), which answers with the selection once
  // there is one -- and these tests are all about having one. An import clears
  // the selection, so reading it there is reading every row; the bulk edit
  // mutates those row objects in place, so the capture stays current.
  // globalThis.currentRows is no use here: it binds to whichever controller was
  // built first in the process, and every test in this file builds its own.
  let loadedRows = [];

  // The binary import path, which is what a dropped or picked .img runs
  // through. Reusable: loading a second image is how the editor's rows get
  // replaced wholesale, which a modal left open has to survive.
  async function loadImage() {
    const imgInput = document.querySelector("#img-file");
    imgInput.files = [{
      name: "codeplug.img",
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    }];
    imgInput.dispatchEvent({ type: "change" });
    await flushMicrotasks();
    loadedRows = ui.selectedRowsForOperations();
  }
  await loadImage();

  // Runs the upload far enough to highlight what the preflight rejected. It
  // stops there: an upload with issues returns before it touches the radio.
  async function runBlockedUpload() {
    document.querySelector("#radio-upload").dispatchEvent({ type: "click" });
    await flushMicrotasks();
  }
  return { document, extraCalls, rows: () => loadedRows, loadImage, runBlockedUpload };
}

// Which channel cells are currently marked by the preflight, as
// "<row index>:<column>".
function markedCells(document) {
  return channelRows(document).flatMap((tr) => tr.children
    .map((td, index) => (td.classList.contains("is-invalid") ? `${tr.dataset.rowIdx}:${HEADERS[index]}` : null))
    .filter(Boolean));
}

function bulkButton(document) {
  return document.querySelector("#channel-bulk-edit");
}

function modalIsOpen(document) {
  return !document.querySelector("#channel-bulk-edit-modal").classList.contains("hidden");
}

// Selects rows by clicking their Location buttons, the way a user does:
// the first plain, the rest with the Ctrl modifier that extends a selection.
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

function columnField(document, column) {
  const grid = document.querySelector("#channel-bulk-edit-grid");
  return {
    control: grid.querySelector(`[name="${column}"]`),
    apply: grid.querySelector(`[name="${column}__apply"]`),
  };
}

function extraField(document, name) {
  const grid = document.querySelector("#channel-bulk-edit-extra-grid");
  return {
    control: grid.querySelector(`[name="${name}"]`),
    apply: grid.querySelector(`[name="${name}__apply"]`),
  };
}

// Ticks a field by setting the control, exactly as the browser's own change
// event would: the modal arms a field the moment its control is touched.
function setField({ control }, value) {
  control.value = String(value);
  control.dispatchEvent({ type: "change", target: control });
}

async function applyModal(document) {
  await document.querySelector("#channel-bulk-edit-form").dispatch("submit");
  await flushMicrotasks();
}

function columnLabels(document) {
  return document
    .querySelector("#channel-bulk-edit-grid")
    .querySelectorAll("[name]")
    .filter((control) => !control.name.endsWith("__apply"))
    .map((control) => control.name);
}

test("the bulk-edit control follows the grid selection", async () => {
  const { document } = await boot();
  assert.equal(bulkButton(document).disabled, true, "nothing is selected yet");

  clickLocationButton(document, 0);
  assert.equal(bulkButton(document).disabled, false);
  assert.match(bulkButton(document).title, /1 selected/);

  clickLocationButton(document, 1, { ctrlKey: true });
  assert.match(bulkButton(document).title, /2 selected/);

  // Ctrl-clicking the same rows again clears the selection, which has to put
  // the control back where it started.
  clickLocationButton(document, 0, { ctrlKey: true });
  clickLocationButton(document, 1, { ctrlKey: true });
  assert.equal(bulkButton(document).disabled, true);
});

test("the modal lists the editable columns, and only those", async () => {
  const { document } = await boot();
  await openBulkEditor(document, [0, 1]);

  assert.equal(modalIsOpen(document), true);
  assert.match(document.querySelector("#channel-bulk-edit-title").textContent, /2 selected channels/);
  assert.deepEqual(
    columnLabels(document),
    ["Name", "Frequency", "Mode", "Power"],
    "Location is the memory slot and Comment is read-only on this driver",
  );
});

test("a column the selection disagrees about is marked, one it agrees on is not", async () => {
  const { document } = await boot();
  // Rows 0 and 1 share Power "High" but differ on Mode.
  await openBulkEditor(document, [0, 1]);

  const labels = document.querySelector("#channel-bulk-edit-grid").querySelectorAll(".bulk-edit-mixed");
  assert.deepEqual(
    labels.map((el) => el.parentNode.textContent.replace("multiple values", "")),
    ["Name", "Frequency", "Mode"],
    "Power is the only column these two rows agree on",
  );
  assert.equal(columnField(document, "Power").control.value, "High");
});

test("applying writes the ticked columns to every selected channel", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 2]);

  setField(columnField(document, "Mode"), "NFM");
  setField(columnField(document, "Power"), "Low");
  await applyModal(document);

  assert.equal(modalIsOpen(document), false, "a successful apply closes the modal");
  const all = rows();
  assert.deepEqual(
    all.map((row) => [row.Location, row.Mode, row.Power]),
    [["1", "NFM", "Low"], ["2", "NFM", "High"], ["3", "NFM", "Low"]],
    "only the selected channels take the new values",
  );
  // Nothing else about the selected rows moved: an untouched column is not
  // rewritten with whatever its control happened to be showing.
  assert.deepEqual(all.map((row) => row.Name), ["ALPHA", "BRAVO", "CHARLIE"]);
  assert.deepEqual(
    all.map((row) => row.Frequency),
    ["145.500000", "145.600000", "145.700000"],
  );
});

test("a field whose box is never ticked is left alone", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  // Set the control without the event a real browser fires, so the field stays
  // unarmed: only the checkbox decides what is written.
  columnField(document, "Name").control.value = "ZULU";
  columnField(document, "Mode").apply.checked = true;
  await applyModal(document);

  assert.deepEqual(rows().map((row) => row.Name), ["ALPHA", "BRAVO", "CHARLIE"]);
});

test("applying with nothing ticked changes nothing and says so", async () => {
  const { document, rows } = await boot();
  const before = rows().map((row) => ({ ...row }));
  await openBulkEditor(document, [0, 1]);
  await applyModal(document);

  assert.equal(modalIsOpen(document), true, "an empty apply is a mistake, not a close");
  assert.match(document.querySelector("#channel-bulk-edit-message").textContent, /Tick at least one/);
  assert.deepEqual(rows(), before);
});

test("a value the radio will not take blocks the whole apply", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  // 200 MHz is outside both of this driver's bands.
  setField(columnField(document, "Frequency"), "200.000000");
  setField(columnField(document, "Mode"), "NFM");
  await applyModal(document);

  assert.equal(modalIsOpen(document), true);
  assert.match(document.querySelector("#channel-bulk-edit-grid").textContent, /does not accept this Frequency/);
  assert.match(document.querySelector("#channel-bulk-edit-message").textContent, /Fix 1 highlighted value/);
  // The valid field in the same apply must not have landed either: a bulk edit
  // that wrote half its fields would leave nothing to say which half.
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"]);
});

test("the driver's extras are offered, and the immutable one is not", async () => {
  const { document, extraCalls } = await boot();
  await openBulkEditor(document, [1, 2]);

  // The schema has no meaning for a set of channels, so it is read from the
  // first selected one and the section says so.
  assert.deepEqual(extraCalls, [{ module: "h777", className: "H777Radio", location: "2" }]);
  assert.match(
    document.querySelector("#channel-bulk-edit-extra-message").textContent,
    /Read from channel 2/,
  );
  assert.ok(extraField(document, "bcl").control, "a boolean extra should be offered");
  assert.ok(extraField(document, "scode").control, "an enum extra should be offered");
  assert.equal(
    extraField(document, "voxlevel").control,
    null,
    "an immutable extra can never be applied, so it must not be offered",
  );
});

test("applying an extra writes it to every selected channel's sidecar", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);

  setField(extraField(document, "scode"), "2");
  await applyModal(document);

  const all = rows();
  assert.deepEqual(
    all[0].__extra,
    // Merged into what the row already carried rather than replacing it: bcl
    // was never ticked, so channel 1 keeps its own value for it.
    { bcl: false, scode: "2" },
  );
  assert.deepEqual(all[1].__extra, { scode: "2" });
  assert.equal(all[2].__extra, undefined, "an unselected channel gains no sidecar");
});

test("each channel gets its own sidecar object", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [1, 2]);

  setField(extraField(document, "scode"), "2");
  await applyModal(document);

  const all = rows();
  assert.notEqual(
    all[1].__extra,
    all[2].__extra,
    "a shared mapping would make a later single-channel edit change both",
  );
});

test("an out-of-range extra is reported and blocks the apply", async () => {
  const { document, rows } = await boot({
    getChannelExtra: async () => ({
      available: true,
      message: "",
      fields: [{ name: "voxlevel", label: "VOX level", type: "integer", min: 0, max: 5, mutable: true, current: 3 }],
    }),
  });
  await openBulkEditor(document, [0, 1]);

  setField(extraField(document, "voxlevel"), "9");
  setField(columnField(document, "Mode"), "NFM");
  await applyModal(document);

  assert.equal(modalIsOpen(document), true);
  assert.match(document.querySelector("#channel-bulk-edit-extra-grid").textContent, /at most 5/);
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"], "nothing was written");
});

test("a radio with no extras says so instead of showing an empty section", async () => {
  const { document } = await boot({
    getChannelExtra: async () => ({
      available: false,
      message: "This radio has no extra settings for its channels.",
      fields: [],
    }),
  });
  await openBulkEditor(document, [0]);

  assert.equal(modalIsOpen(document), true);
  assert.match(
    document.querySelector("#channel-bulk-edit-extra-message").textContent,
    /no extra settings/,
  );
  // The columns are local to the grid, so they are still editable.
  assert.ok(columnField(document, "Mode").control);
  assert.equal(document.querySelector("#channel-bulk-edit-apply").disabled, false);
});

test("the columns are usable while the extras are still being read", async () => {
  const pending = createDeferred();
  const { document, rows } = await boot({
    getChannelExtra: async () => {
      await pending.promise;
      return { available: true, message: "", fields: EXTRA_FIELDS };
    },
  });
  selectRows(document, [0, 1]);
  bulkButton(document).click();
  await flushMicrotasks();

  assert.equal(modalIsOpen(document), true);
  setField(columnField(document, "Mode"), "NFM");
  await applyModal(document);
  assert.deepEqual(rows().map((row) => row.Mode), ["NFM", "NFM", "FM"]);

  // The response lands after the modal closed and has nowhere to render.
  pending.resolve();
  await flushMicrotasks();
  assert.equal(modalIsOpen(document), false);
  assert.equal(document.querySelector("#channel-bulk-edit-extra-grid").children.length, 0);
});

test("an apply is refused once the channel list has been replaced under it", async () => {
  const { document, rows, loadImage } = await boot();
  await openBulkEditor(document, [0, 1]);
  setField(columnField(document, "Mode"), "NFM");
  const detached = rows().slice(0, 2);

  // A download or a second image load replaces state.currentRows wholesale and
  // does not close this modal; the rows it is holding are no longer in the grid.
  await loadImage();
  await applyModal(document);

  assert.equal(modalIsOpen(document), false);
  assert.deepEqual(
    detached.map((row) => row.Mode),
    ["FM", "NFM"],
    "the detached rows must not be edited as if they were still in the editor",
  );
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"]);
});

// The other half of what the fields were built from. Picking a radio leaves the
// rows alone -- reloadForSelectedRadio in web/js/ui/radio-catalog.js mutates
// them in place and swaps only the schema -- so the rows-still-present check
// above cannot see this one, and without its own check the apply would write
// Mode through a driver that has no Mode column (silently skipped, still
// counted) and Name through one that marks it read-only.
test("an apply is refused once another radio has been selected under it", async () => {
  const { document, rows } = await boot({ radios: [RADIO, OTHER_RADIO] });
  await openBulkEditor(document, [0, 1]);
  setField(columnField(document, "Mode"), "NFM");
  setField(columnField(document, "Name"), "ZULU");

  selectRadioBySearch(document, "Retevis RT22");
  await flushMicrotasks();
  await applyModal(document);

  assert.equal(modalIsOpen(document), false);
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"]);
  assert.deepEqual(rows().map((row) => row.Name), ["ALPHA", "BRAVO", "CHARLIE"]);
});

// A value the first selected channel carries and this driver no longer offers
// is shown, because that is what that channel holds -- but this dialog copies
// whatever is shown onto every other selected channel, and those never had it.
test("an extra value the driver no longer offers is refused rather than copied", async () => {
  const { document, rows } = await boot({
    rows: [{ ...IMAGE_ROWS[0], __extra: { scode: "9" } }, ...IMAGE_ROWS.slice(1)],
  });
  await openBulkEditor(document, [0, 1]);

  assert.equal(extraField(document, "scode").control.value, "9", "the stored value is shown, not snapped");
  extraField(document, "scode").apply.checked = true;
  await applyModal(document);

  assert.equal(modalIsOpen(document), true);
  assert.match(
    document.querySelector("#channel-bulk-edit-extra-grid").textContent,
    /does not offer this value/,
  );
  assert.equal(rows()[1].__extra, undefined, "a channel that never had it must not gain it");
  assert.deepEqual(rows()[0].__extra, { scode: "9" }, "and the channel that did keeps it unchanged");
});

// Both checkboxes of a boolean extra sit under the same visible label, so
// without a name of its own the apply box is announced exactly like the value
// box beside it and nothing says which one is which.
test("the apply box is named apart from the value it arms", async () => {
  const { document } = await boot();
  await openBulkEditor(document, [0]);

  const bcl = extraField(document, "bcl");
  assert.equal(bcl.control.type, "checkbox", "this test only means anything for a boolean extra");
  assert.equal(bcl.apply.getAttribute("aria-label"), "Apply Busy Channel Lockout");
  assert.equal(bcl.control.getAttribute("aria-label"), "Busy Channel Lockout");
  assert.equal(columnField(document, "Mode").apply.getAttribute("aria-label"), "Apply Mode");
});

// Every field here is optional until its box is ticked, which the browser has
// no way to know: an out-of-range number abandoned in an unticked field would
// make the form invalid, suppress the submit event, and make applying some
// other field do nothing at all -- with no message, because the module's own
// validation never runs.
test("the dialog opts out of the browser's own form validation", () => {
  const html = fs.readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
  const form = html.match(/<form id="channel-bulk-edit-form"[^>]*>/);
  assert.ok(form, "the bulk editor's form must still be a form");
  assert.match(form[0], /\bnovalidate\b/);
});

test("Escape closes the editor without touching the selection", async () => {
  const { document, rows } = await boot();
  await openBulkEditor(document, [0, 1]);
  setField(columnField(document, "Mode"), "NFM");
  bulkButton(document).focused = false;

  document.dispatchEvent(keydownEvent("Escape"));

  assert.equal(modalIsOpen(document), false);
  assert.deepEqual(rows().map((row) => row.Mode), ["FM", "NFM", "FM"]);
  assert.equal(
    bulkButton(document).focused,
    true,
    "Escape should hand the keyboard back to the toolbar button",
  );
});

// The grid's clipboard and reorder shortcuts stand down while a modal owns the
// keyboard; a new modal that forgets to say so lets Alt+ArrowUp reorder the
// channels behind it.
test("the grid's shortcuts stand down while the bulk editor is open", async () => {
  const { document } = await boot();
  await openBulkEditor(document, [0]);

  document.dispatchEvent({ ...keydownEvent("ArrowDown"), altKey: true });

  // Read off the grid rather than the row objects: a reorder replaces the row
  // array wholesale, which a capture taken before it would not show.
  assert.deepEqual(
    tableNames(document),
    ["ALPHA", "BRAVO", "CHARLIE"],
    "the channels behind the modal should not have moved",
  );
});

// An enum column whose CHIRP default is blank (Power on every driver) is the
// one case where the selection's own value cannot be shown: a <select> has no
// way back to it, and writing "" is exactly what the column will not accept.
// The control falls back to the driver's first option so a ticked field always
// carries something applicable.
test("a blank enum column offers the driver's own options rather than nothing", async () => {
  const { document, rows } = await boot({
    rows: IMAGE_ROWS.map((row) => ({ ...row, Power: "" })),
  });
  await openBulkEditor(document, [0, 1]);

  assert.equal(columnField(document, "Power").control.value, "High");
  setField(columnField(document, "Power"), "Low");
  await applyModal(document);
  assert.deepEqual(rows().map((row) => row.Power), ["Low", "Low", ""]);
});

// Layout is the browser's own and cannot be checked headlessly, so what is
// asserted here is the stylesheet rule that produces it — the same approach the
// Extra column's pin test takes in tests/channels/ui-channel-extra.mjs. This one
// earns its keep because the field list is as long as the driver makes it: on a
// radio with a dozen extras an uncapped card pushes Apply off the bottom of a
// phone screen, and the feature is unreachable exactly where the list is longest.
test("the bulk editor caps its card and scrolls the fields inside it", () => {
  const styles = fs.readFileSync(path.join(repoRoot, "web", "styles.css"), "utf8");
  const card = styles.match(/#channel-bulk-edit-modal \.modal-card \{([^}]*)\}/);
  assert.ok(card, "the bulk editor's card must carry its own rule");
  assert.match(card[1], /max-height:/);
  assert.match(card[1], /flex-direction:\s*column/);

  const body = styles.match(/\.bulk-edit-body \{([^}]*)\}/);
  assert.ok(body, "the scrolling region must carry its own rule");
  assert.match(body[1], /overflow-y:\s*auto/);
  // A flex child's default minimum is its content height, which would defeat
  // the cap above by refusing to shrink.
  assert.match(body[1], /min-height:\s*0/);
});

// A failed upload marks issues across the whole grid. A bulk edit rewrites a
// few columns of a few rows, so it can only speak for those: clearing every
// highlight would leave the cells it never touched invalid but no longer
// visibly so, until another upload attempt reran the preflight.
test("a bulk edit clears the highlights on the cells it rewrote, and only those", async () => {
  const { document, runBlockedUpload } = await boot({
    uploadIssues: [
      { rowIndex: 0, column: "Mode", message: "bad mode" },
      { rowIndex: 0, column: "Name", message: "bad name" },
      { rowIndex: 2, column: "Name", message: "bad name" },
    ],
  });
  await runBlockedUpload();
  assert.deepEqual(markedCells(document), ["0:Name", "0:Mode", "2:Name"]);

  await openBulkEditor(document, [0, 1]);
  setField(columnField(document, "Mode"), "NFM");
  await applyModal(document);

  assert.deepEqual(
    markedCells(document),
    ["0:Name", "2:Name"],
    "the Name cells this edit never touched still hold the values the radio refused",
  );
});

// Ticking only extras writes no column, and a bulk edit that changed no cell
// has nothing to say about any highlight.
test("a bulk edit of extras alone leaves every highlight in place", async () => {
  const { document, runBlockedUpload } = await boot({
    uploadIssues: [{ rowIndex: 1, column: "Mode", message: "bad mode" }],
  });
  await runBlockedUpload();

  await openBulkEditor(document, [0, 1]);
  setField(extraField(document, "scode"), "2");
  await applyModal(document);

  assert.deepEqual(markedCells(document), ["1:Mode"]);
});

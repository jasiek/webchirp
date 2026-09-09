import assert from "node:assert/strict";
import test from "node:test";

// Regression tests for Location semantics in the channel grid
// (https://github.com/jasiek/webchirp/issues/73). A Location is the memory
// slot a channel occupies, not its position in the list: codeplugs read from
// a radio are routinely sparse, and 147 of CHIRP's driver call sites number
// memories from 1 rather than 0. Editing the grid must therefore leave the
// slots of untouched channels alone.
//
// The fake DOM and grid-driving helpers are shared with
// scripts/test-ui-channel-cut.mjs via scripts/test-support/fake-dom.mjs.
import {
  channelRows,
  clickLocationButton,
  flushMicrotasks,
  importSampleCsv,
  installFakeDom,
  selectRadioBySearch,
  tableNames,
} from "./test-support/fake-dom.mjs";

// The UV-5R test image's real shape, trimmed: two low channels, then gaps.
// chirp/tests/images/Baofeng_UV-5R.img fills 37 of 128 slots this way.
const SPARSE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
  { Location: "25", Name: "HTAC1", Frequency: "443.000000" },
  { Location: "26", Name: "HTAC2", Frequency: "147.380000" },
  { Location: "124", Name: "VCALL", Frequency: "155.750000" },
];

const HEADERS = ["Location", "Name", "Frequency"];

// A shift-click on a Location button extends the selection from the anchor.
function shiftClickLocationButton(document, rowIdx) {
  clickLocationButton(document, rowIdx, { shiftKey: true });
}

function selectedNames(document) {
  return channelRows(document)
    .filter((tr) => tr.children[0]?.children[0]?.getAttribute("aria-pressed") === "true")
    .map((tr) => tr.children[1]?.children[0]?.value ?? "");
}

function tableLocations(document) {
  return channelRows(document).map((tr) => tr.children[0]?.children[0]?.textContent ?? "");
}

// Boot the UI with a stubbed runtime whose driver reports `bounds` as the
// Location column's range, then load `rows` through the CSV import path.
async function bootWithRows(rows, bounds = { min: 0, max: 127 }) {
  const { document, navigator } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  const columns = { Location: { kind: "int", editable: false, ...bounds } };
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: rows.map((row) => ({ ...row })), errors: [] }),
  });
  await ui.init(true);
  // Without a selected radio the driver's column metadata is never fetched.
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();
  await importSampleCsv(document);
  return { document, navigator, ui };
}

function click(document, selector) {
  document.querySelector(selector).dispatchEvent({ type: "click" });
}

test("a sparse codeplug loads with the radio's own memory numbering", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  // The gaps are the radio's, not a bug: nothing renumbers on load.
  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124"]);
});

test("a codeplug listing channels out of order loads in memory order", async () => {
  // A radio or image always yields ascending memories, but a hand-written CSV
  // need not, and the grid still has to read as the radio's memory map.
  const { document } = await bootWithRows([
    { Location: "124", Name: "VCALL", Frequency: "155.750000" },
    { Location: "1", Name: "Bravo", Frequency: "146.940000" },
    { Location: "25", Name: "HTAC1", Frequency: "443.000000" },
  ]);
  assert.deepEqual(tableLocations(document), ["1", "25", "124"]);
  assert.deepEqual(tableNames(document), ["Bravo", "HTAC1", "VCALL"]);
});

test("loading never rewrites the Locations a file gave, however wrong", async () => {
  // Regression: sorting on load must not drag slot *assignment* along with
  // it. A file listing 5, 5 and 9000 has one duplicate and one out-of-bounds
  // memory; silently moving them to 0 and 1 would hide exactly the mistake
  // the upload preflight exists to report, and would edit the user's data on
  // the way in.
  const { document } = await bootWithRows([
    { Location: "5", Name: "A", Frequency: "146.000000" },
    { Location: "5", Name: "Bdup", Frequency: "146.100000" },
    { Location: "9000", Name: "Coob", Frequency: "146.200000" },
  ]);
  assert.deepEqual(tableLocations(document), ["5", "5", "9000"]);
  assert.deepEqual(tableNames(document), ["A", "Bdup", "Coob"]);
});

test("insert takes the lowest free memory and leaves every other channel in place", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 2);
  click(document, "#channel-insert");
  await flushMicrotasks();

  // The blank row claims memory 2 — the first one free — and appears between
  // Bravo and HTAC1, where memory 2 belongs. Before the fix this renumbered
  // the list to 0-5, moving HTAC1 off 25 and dropping VCALL from 124.
  assert.deepEqual(tableLocations(document), ["0", "1", "2", "25", "26", "124"]);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "", "HTAC1", "HTAC2", "VCALL"]);
});

test("an inserted channel sorts into its memory rather than onto the end", async () => {
  // The reported case: memories run 0-10 then resume at 30, so the new
  // channel takes 11 and has to appear between them, not below memory 30.
  const rows = [
    ...Array.from({ length: 11 }, (_, n) => ({
      Location: String(n),
      Name: `LOW${n}`,
      Frequency: "145.000000",
    })),
    { Location: "30", Name: "HIGH30", Frequency: "435.000000" },
    { Location: "31", Name: "HIGH31", Frequency: "435.100000" },
  ];
  const { document } = await bootWithRows(rows);
  // Nothing selected: the old code appended the row to the end of the list.
  click(document, "#channel-insert");
  await flushMicrotasks();

  const locations = tableLocations(document);
  assert.equal(locations[11], "11");
  assert.deepEqual(locations.slice(9), ["9", "10", "11", "30", "31"]);
  assert.deepEqual(
    locations.map(Number),
    [...locations].map(Number).sort((a, b) => a - b),
    "grid must always be in memory order",
  );
});

test("insert on a 1-based radio never allocates memory 0", async () => {
  // 147 driver call sites use a lower bound of 1. Allocating 0 for them made
  // the upload fail mid-clone with "Location 0 is outside radio memory bounds".
  const { document } = await bootWithRows(
    [
      { Location: "1", Name: "Alpha", Frequency: "146.520000" },
      { Location: "3", Name: "Bravo", Frequency: "146.940000" },
    ],
    { min: 1, max: 128 },
  );
  clickLocationButton(document, 0);
  click(document, "#channel-insert");
  await flushMicrotasks();

  // Memory 2 is the lowest free slot at or above the 1 floor, and the row
  // sits between memories 1 and 3 where that slot belongs.
  assert.deepEqual(tableLocations(document), ["1", "2", "3"]);
  assert.deepEqual(tableNames(document), ["Alpha", "", "Bravo"]);
});

test("removing a channel frees its memory and moves no other channel", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 1);
  click(document, "#channel-remove");
  await flushMicrotasks();

  assert.deepEqual(tableLocations(document), ["0", "25", "26", "124"]);
  assert.deepEqual(tableNames(document), ["Alpha", "HTAC1", "HTAC2", "VCALL"]);
});

test("move swaps two channels' memories instead of renumbering the codeplug", async () => {
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 2);
  click(document, "#channel-move-up");
  await flushMicrotasks();

  // HTAC1 and Bravo trade slots; the occupied set is untouched, so the
  // codeplug stays as sparse as the radio had it.
  assert.deepEqual(tableNames(document), ["Alpha", "HTAC1", "Bravo", "HTAC2", "VCALL"]);
  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124"]);
});

test("paste-overwrite gives pasted channels the memory they overwrite", async () => {
  const { document, navigator } = await bootWithRows(SPARSE_ROWS);
  // Locations in the clipboard belong to whatever codeplug it was copied
  // from; the destination slot has to win.
  navigator.clipboard = {
    readText: async () => "Location\tName\tFrequency\n7\tNew1\t145.000000\n8\tNew2\t145.100000\n",
  };
  let confirmed = "";
  window.confirm = (message) => {
    confirmed = message;
    return true;
  };
  clickLocationButton(document, 2);
  click(document, "#channel-paste");
  await flushMicrotasks();

  // The prompt names the memories being overwritten, so it has to report the
  // real slots rather than the row positions.
  assert.match(confirmed, /channels 25, 26/);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "New1", "New2", "VCALL"]);
  assert.deepEqual(tableLocations(document), ["0", "1", "25", "26", "124"]);
});

test("paste past the end of the list allocates free memories", async () => {
  const { document, navigator } = await bootWithRows(SPARSE_ROWS);
  navigator.clipboard = {
    readText: async () => "Name\tFrequency\nNew1\t145.000000\nNew2\t145.100000\n",
  };
  click(document, "#channel-paste");
  await flushMicrotasks();

  // Slots 2 and 3 are free, and the pasted rows appear where those memories
  // sit rather than trailing the list.
  assert.deepEqual(tableLocations(document), ["0", "1", "2", "3", "25", "26", "124"]);
  assert.deepEqual(
    tableNames(document),
    ["Alpha", "Bravo", "New1", "New2", "HTAC1", "HTAC2", "VCALL"],
  );
});

test("moving down leaves the anchor on the trailing edge for shift-click", async () => {
  // A single moved row cannot tell the two anchors apart, so move two: after
  // moving down they occupy indexes 1 and 2, and a shift-click extends from
  // 2 (the edge they travelled towards), not from 1.
  const { document } = await bootWithRows(SPARSE_ROWS);
  clickLocationButton(document, 0);
  shiftClickLocationButton(document, 1);
  assert.deepEqual(selectedNames(document), ["Alpha", "Bravo"]);

  click(document, "#channel-move-down");
  await flushMicrotasks();
  assert.deepEqual(
    tableNames(document),
    ["HTAC1", "Alpha", "Bravo", "HTAC2", "VCALL"],
  );

  shiftClickLocationButton(document, 4);
  assert.deepEqual(selectedNames(document), ["Bravo", "HTAC2", "VCALL"]);
});

test("a pasted block lands on consecutive memories and clobbers nothing distant", async () => {
  // Regression: paste used to walk consecutive *rows*, so on a sparse
  // codeplug a 3-row block pasted at memory 26 landed on 26, 124 and 2 —
  // scattered across the radio, silently overwriting VCALL at 124, a channel
  // the confirmation had named but the user never aimed at.
  const { document, navigator } = await bootWithRows(SPARSE_ROWS);
  let confirmed = "";
  window.confirm = (message) => {
    confirmed = message;
    return true;
  };
  navigator.clipboard = {
    readText: async () =>
      "Name\tFrequency\nP1\t145.000000\nP2\t145.100000\nP3\t145.200000\n",
  };
  clickLocationButton(document, 3); // HTAC2, memory 26
  click(document, "#channel-paste");
  await flushMicrotasks();

  // 26 is occupied and is the only channel overwritten; 27 and 28 are free.
  assert.match(confirmed, /channel 26/);
  assert.deepEqual(
    tableLocations(document),
    ["0", "1", "25", "26", "27", "28", "124"],
  );
  assert.deepEqual(
    tableNames(document),
    ["Alpha", "Bravo", "HTAC1", "P1", "P2", "P3", "VCALL"],
  );
});

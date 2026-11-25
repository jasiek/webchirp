import assert from "node:assert/strict";
import test from "node:test";

// The channel toolbar's Show empty memories toggle (web/js/ui/channel-table.ts).
// A codeplug's rows are its occupied memories only, so the toggle adds a line
// for each unused memory between the radio's bounds without adding anything
// to the rows: upload, export and the row checks must see exactly what they
// saw before. Typing into an empty memory's line, or clicking its number, is
// what makes it a channel.
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
const BOUNDS = { min: 0, max: 9 };

// Memories 0-9 with four in use, and the gaps a radio's codeplug has.
const SPARSE_ROWS = [
  { Location: "0", Name: "Alpha", Frequency: "146.520000" },
  { Location: "1", Name: "Bravo", Frequency: "146.940000" },
  { Location: "4", Name: "Delta", Frequency: "147.000000" },
  { Location: "8", Name: "Hotel", Frequency: "443.000000" },
];

const SHOW_EMPTY_KEY = "webchirp-show-empty-memories";

// Boot the UI with a stubbed runtime whose driver numbers its memories
// BOUNDS, then load `rows` through the CSV import path. With selectRadio
// false nothing is selected, and the grid is on CHIRP's unbounded CSV schema.
async function boot({ rows = SPARSE_ROWS, selectRadio = true, location = {}, before } = {}) {
  const { document, window } = installIndexPage();
  before?.(window);
  // What each Export CSV sent the runtime: the rows the editor holds, which
  // are also what an upload writes.
  const exports = [];
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  const columns = { Location: { kind: "int", editable: false, ...BOUNDS, ...location } };
  ui.setRuntimeApi(withRadioSessions({
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
    normalizeRows: async ({ rows: exported }) => {
      exports.push(exported.map((row) => ({ ...row })));
      return "";
    },
  }));
  await ui.init(true);
  if (selectRadio) {
    selectRadioBySearch(document, "Acme One");
    await flushMicrotasks();
  }
  await importSampleCsv(document);
  const heldLocations = async () => {
    await dispatch(document.querySelector("#export-csv"), "click");
    await flushMicrotasks();
    return exports.at(-1).map((row) => row.Location);
  };
  return { document, window, heldLocations };
}

function toggle(document) {
  return document.querySelector("#channel-show-empty");
}

async function clickToggle(document) {
  await dispatch(toggle(document), "click");
  await flushMicrotasks();
}

// Every line the grid drew, channel or empty memory: a channel by its
// Location, an empty memory as "(n)".
function gridLines(document) {
  const tbody = document.querySelector("#mem-table tbody");
  return Array.from(tbody.children)
    .filter((tr) => !tr.classList.contains("mem-row-spacer"))
    .map((tr) => (tr.dataset.slot !== undefined
      ? `(${tr.dataset.slot})`
      : tr.children[0].children[0].textContent));
}

function emptyMemoryLine(document, slot) {
  const tbody = document.querySelector("#mem-table tbody");
  return Array.from(tbody.children).find((tr) => tr.dataset.slot === String(slot));
}

function lastStatus(document) {
  const lines = document.querySelector("#debug-output").value.split("\n");
  return lines.filter((line) => line.includes("STATUS ")).at(-1)?.replace(/^.*STATUS /, "") ?? "";
}

test("the toggle is disabled until a radio is selected", async () => {
  const { document } = await boot({ selectRadio: false });
  const button = toggle(document);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.title, "Select a radio to show its empty memories");
  await clickToggle(document);
  assert.deepEqual(gridLines(document), ["0", "1", "4", "8"]);
});

test("empty memories are hidden by default and listed in memory order when shown", async () => {
  const { document, window, heldLocations } = await boot();
  const button = toggle(document);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.match(button.title, /^Show empty memories: /);
  assert.deepEqual(gridLines(document), ["0", "1", "4", "8"]);

  await clickToggle(document);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(button.title, /^Hide empty memories: /);
  assert.deepEqual(gridLines(document), ["0", "1", "(2)", "(3)", "4", "(5)", "(6)", "(7)", "8", "(9)"]);
  assert.equal(lastStatus(document), "Showing empty memories.");
  assert.equal(window.localStorage.getItem(SHOW_EMPTY_KEY), "true");
  // Only the drawing changed: the editor still holds the four channels.
  assert.deepEqual(await heldLocations(), ["0", "1", "4", "8"]);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Delta", "Hotel"]);

  await clickToggle(document);
  assert.deepEqual(gridLines(document), ["0", "1", "4", "8"]);
  assert.equal(window.localStorage.getItem(SHOW_EMPTY_KEY), "false");
});

test("the choice is remembered for the next visit", async () => {
  const { document } = await boot({
    before: (window) => window.localStorage.setItem(SHOW_EMPTY_KEY, "true"),
  });
  assert.equal(toggle(document).getAttribute("aria-pressed"), "true");
  assert.equal(gridLines(document).length, 10);
});

test("blank channels the user inserted are always shown", async () => {
  const { document } = await boot({ rows: [...SPARSE_ROWS, { Location: "6", Name: "", Frequency: "" }] });
  assert.deepEqual(gridLines(document), ["0", "1", "4", "6", "8"]);
  await clickToggle(document);
  assert.deepEqual(gridLines(document), ["0", "1", "(2)", "(3)", "4", "(5)", "6", "(7)", "8", "(9)"]);
});

test("typing into an empty memory makes it a channel there", async () => {
  const { document, heldLocations } = await boot();
  await clickToggle(document);
  // Delta is selected before the edit and stays selected after it, although
  // the new channel lands ahead of it in the editor's rows.
  clickLocationButton(document, 2);

  const editor = emptyMemoryLine(document, 3).children[1].children[0];
  editor.focus();
  editor.value = "Charlie";
  editor.blur();
  await flushMicrotasks();

  assert.equal(lastStatus(document), "Inserted new channel at memory 3.");
  assert.deepEqual(await heldLocations(), ["0", "1", "3", "4", "8"]);
  assert.deepEqual(gridLines(document), ["0", "1", "(2)", "3", "4", "(5)", "(6)", "(7)", "8", "(9)"]);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Charlie", "Delta", "Hotel"]);
  const selected = channelRows(document)
    .filter((tr) => tr.classList.contains("is-selected"))
    .map((tr) => tr.children[1].children[0].value);
  assert.deepEqual(selected, ["Delta"]);
});

test("passing through an empty memory without typing writes nothing", async () => {
  const { document, heldLocations } = await boot();
  await clickToggle(document);
  const editor = emptyMemoryLine(document, 5).children[2].children[0];
  editor.focus();
  editor.blur();
  await flushMicrotasks();
  assert.deepEqual(await heldLocations(), ["0", "1", "4", "8"]);
  assert.ok(emptyMemoryLine(document, 5), "memory 5 is still empty");
});

test("clicking an empty memory's number adds a channel there and selects it, as Insert does", async () => {
  const { document, window, heldLocations } = await boot();
  await clickToggle(document);
  const number = emptyMemoryLine(document, 6).children[0].children[0];
  assert.match(number.title, /click to add a channel here/);
  number.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await flushMicrotasks();

  assert.equal(lastStatus(document), "Inserted new channel at memory 6.");
  assert.equal(emptyMemoryLine(document, 6), undefined, "memory 6 is a channel now");
  const selected = channelRows(document).filter((tr) => tr.classList.contains("is-selected"));
  assert.deepEqual(selected.map((tr) => tr.children[0].children[0].textContent), ["6"]);
  // A selected channel like any other: the bulk editor offers itself.
  assert.equal(document.querySelector("#channel-bulk-edit").disabled, false);
  assert.deepEqual(await heldLocations(), ["0", "1", "4", "6", "8"]);

  // Ctrl-click adds a second empty memory to the selection.
  emptyMemoryLine(document, 9).children[0].children[0]
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
  await flushMicrotasks();
  const both = channelRows(document).filter((tr) => tr.classList.contains("is-selected"));
  assert.deepEqual(both.map((tr) => tr.children[0].children[0].textContent), ["6", "9"]);

  // And Remove takes them out again, leaving the memories empty.
  await dispatch(document.querySelector("#channel-remove"), "click");
  assert.deepEqual(await heldLocations(), ["0", "1", "4", "8"]);
  assert.deepEqual(gridLines(document), ["0", "1", "(2)", "(3)", "4", "(5)", "(6)", "(7)", "8", "(9)"]);
});

test("an unreadable memory's number adds nothing", async () => {
  const { document, window, heldLocations } = await boot({ location: { unreadable: [6] } });
  await clickToggle(document);
  const number = emptyMemoryLine(document, 6).children[0].children[0];
  // Disabled, so a real click never fires; a dispatched one is still refused.
  number.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await flushMicrotasks();
  assert.ok(emptyMemoryLine(document, 6));
  assert.deepEqual(await heldLocations(), ["0", "1", "4", "8"]);
});

test("moving a channel still swaps it with the next channel, past empty memories", async () => {
  const { document } = await boot();
  await clickToggle(document);
  clickLocationButton(document, 2);
  await dispatch(document.querySelector("#channel-move-down"), "click");
  assert.deepEqual(gridLines(document), ["0", "1", "(2)", "(3)", "4", "(5)", "(6)", "(7)", "8", "(9)"]);
  assert.deepEqual(tableNames(document), ["Alpha", "Bravo", "Hotel", "Delta"]);
});

test("a memory the driver could not read is shown locked, not as free", async () => {
  const { document } = await boot({ location: { unreadable: [6] } });
  await clickToggle(document);
  const unreadable = emptyMemoryLine(document, 6);
  assert.ok(unreadable.classList.contains("is-unreadable-memory"));
  for (const td of Array.from(unreadable.children)) {
    assert.equal(td.children[0].disabled, true, `${td.dataset.column} is locked`);
  }
  assert.match(unreadable.children[1].title, /could not read this memory/);

  const free = emptyMemoryLine(document, 5);
  assert.equal(free.classList.contains("is-unreadable-memory"), false);
  assert.equal(free.children[1].children[0].disabled, false);

  // Hiding empty memories gives the recycled elements back to channels
  // unlocked.
  await clickToggle(document);
  for (const tr of channelRows(document)) {
    assert.equal(tr.children[1].children[0].disabled, false);
  }
});

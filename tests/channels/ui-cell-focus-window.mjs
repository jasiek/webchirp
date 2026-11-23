import assert from "node:assert/strict";
import test from "node:test";

// Regression test for issue #349: the grid recycles its row elements by
// position, so scrolling the focused channel out of the rendered window hands
// the focused editor to a different channel. Focus used to stay in it, and the
// next keystroke (an arrow key on a select, typing in an input) edited that
// unrelated channel. Focus has to leave the grid instead, and what was typed
// still goes to the channel it was typed into.
//
// The page is index.html in jsdom (tests/support/index-page.mjs). jsdom does
// no layout, so the viewport is given a height with setLayout() to make the
// grid render a window of rows rather than all of them.
import { installIndexPage } from "../support/index-page.mjs";
import {
  channelRows,
  domEvent,
  flushMicrotasks,
  importSampleCsv,
  selectRadioBySearch,
  setLayout,
} from "../support/ui-interactions.mjs";
import { fakeRowCheck, withRadioSessions } from "../support/fake-runtime-api.mjs";

const CHANNEL_COUNT = 100;
const SAMPLE_ROWS = Array.from({ length: CHANNEL_COUNT }, (_, idx) => ({
  Location: String(idx),
  Name: `CH${idx}`,
  Mode: "FM",
}));

const SCHEMA = {
  headers: ["Location", "Name", "Mode"],
  columns: {
    Location: { kind: "int", editable: false, min: 0, max: 127 },
    Name: { kind: "text", editable: true, maxLength: 8 },
    Mode: { kind: "enum", editable: true, options: ["FM", "NFM", "AM"] },
  },
};

// The grid's estimate of a row's height before it has measured one (jsdom
// measures nothing, so the estimate is what it windows against).
const ROW_HEIGHT = 30;

async function windowedGrid({ held = false, csvRows = SAMPLE_ROWS, importNow = true } = {}) {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  const rowCheck = fakeRowCheck({ held });
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: SCHEMA.headers }),
    getRadioMetadata: async () => SCHEMA,
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: SCHEMA.headers, rows: csvRows.slice(), errors: [] }),
    normalizeAndValidateRows: rowCheck.normalizeAndValidateRows,
  }));
  // Ten rows tall: the grid keeps those plus its overscan in the DOM.
  const viewport = document.querySelector("#mem-table-scroll");
  setLayout(viewport, { clientHeight: 10 * ROW_HEIGHT, scrollTop: 0 });
  await ui.init(true);
  await selectRadioBySearch(document, "Acme One");
  if (importNow) {
    await importSampleCsv(document);
  }
  return { document, viewport, calls: rowCheck.calls };
}

function scrollTo(document, viewport, rowIdx) {
  viewport.scrollTop = rowIdx * ROW_HEIGHT;
  viewport.dispatchEvent(domEvent({ type: "scroll" }));
}

function renderedRow(document, rowIdx) {
  return channelRows(document).find((tr) => tr.dataset.rowIdx === String(rowIdx));
}

test("the grid renders a window of rows, not all of them", async () => {
  const { document } = await windowedGrid();
  const rows = channelRows(document);
  assert.ok(rows.length < CHANNEL_COUNT / 2, `${rows.length} rows rendered`);
  assert.equal(rows[0].dataset.rowIdx, "0");
});

test("a focused select scrolled out of the window gives up focus", async () => {
  const { document, viewport, calls } = await windowedGrid();
  const select = renderedRow(document, 2).children[2].children[0];
  assert.equal(select.tagName, "SELECT");
  select.focus();
  assert.equal(document.activeElement, select);

  scrollTo(document, viewport, 50);
  await flushMicrotasks();

  assert.equal(renderedRow(document, 2), undefined, "row 2 left the window");
  // The element that had focus now shows another channel; it must not keep
  // the keyboard.
  assert.notEqual(select.closest("tr").dataset.rowIdx, "2");
  assert.ok(!document.querySelector("#mem-table tbody").contains(document.activeElement),
    "focus left the grid");
  assert.deepEqual(calls, [], "nothing was committed");
});

test("a draft typed in a cell scrolled out of the window goes to its own channel only", async () => {
  const { document, viewport, calls } = await windowedGrid();
  const input = renderedRow(document, 2).children[1].children[0];
  input.focus();
  input.value = "Draft";

  scrollTo(document, viewport, 50);
  await flushMicrotasks();

  assert.ok(!document.querySelector("#mem-table tbody").contains(document.activeElement),
    "focus left the grid");
  // One commit, for the channel the text was typed into, and nothing for the
  // channel the recycled editor shows now.
  const committed = calls.flatMap(({ rows }) => rows.map(({ row, edits }) => [row.Location, edits]));
  assert.deepEqual(committed, [["2", [{ column: "Name", value: "Draft" }]]]);

  scrollTo(document, viewport, 0);
  await flushMicrotasks();
  assert.equal(renderedRow(document, 2).children[1].children[0].value, "Draft");
  assert.equal(renderedRow(document, 3).children[1].children[0].value, "CH3");
});

test("taking focus off a recycled editor does not commit what it now shows", async () => {
  // Answer nothing, so an edit stays pending and its cell keeps the typed
  // value: committing that cell again would ask the runtime a second time.
  const { document, viewport, calls } = await windowedGrid({ held: true });
  // With the window scrolled to row 50, the third pooled row element shows a
  // channel further down; give that channel a pending Name edit.
  scrollTo(document, viewport, 50);
  const recycled = channelRows(document)[2];
  const pendingRowIdx = recycled.dataset.rowIdx;
  const pendingInput = recycled.children[1].children[0];
  pendingInput.focus();
  pendingInput.value = "Pending";
  pendingInput.blur();
  await flushMicrotasks();
  assert.equal(calls.length, 1);

  // Focus the same pooled element while it shows row 2, then scroll it back
  // onto the pending channel.
  scrollTo(document, viewport, 0);
  const input = renderedRow(document, 2).children[1].children[0];
  assert.equal(input, pendingInput);
  input.focus();
  scrollTo(document, viewport, 50);
  await flushMicrotasks();

  assert.equal(input.closest("tr").dataset.rowIdx, pendingRowIdx);
  assert.equal(input.value, "Pending");
  assert.ok(!document.querySelector("#mem-table tbody").contains(document.activeElement),
    "focus left the grid");
  assert.equal(calls.length, 1, "no second commit for the channel the editor now shows");
});

test("an editor whose channel an import replaced gives up focus", async () => {
  // Blank inserted rows are not real channels, so a CSV dropped while one of
  // their cells is focused replaces the list without asking. The list shrinks
  // under the focused element, which stays in the pool showing an imported
  // channel: it must not keep the keyboard, and the draft goes nowhere.
  const csvRows = [];
  const { document, viewport, calls } = await windowedGrid({ csvRows, importNow: false });
  for (let idx = 0; idx < 60; idx += 1) {
    document.querySelector("#channel-insert").dispatchEvent(domEvent({ type: "click" }));
    await flushMicrotasks();
  }
  scrollTo(document, viewport, 32);
  await flushMicrotasks();
  const input = renderedRow(document, 40).children[1].children[0];
  input.focus();
  input.value = "Draft";
  const callsBefore = calls.length;

  csvRows.push(...SAMPLE_ROWS.slice(0, 30));
  await importSampleCsv(document);

  assert.ok(input.isConnected, "the focused element is still in the pool");
  assert.notEqual(input.value, "Draft");
  assert.ok(!document.querySelector("#mem-table tbody").contains(document.activeElement),
    "focus left the grid");
  assert.equal(calls.length, callsBefore, "nothing was committed");
});

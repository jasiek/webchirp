import assert from "node:assert/strict";
import test from "node:test";

// The channel grid takes its natural width from its cells, and an <input> is
// the one editor whose width has nothing to do with the value inside it: the
// browser sizes it from the size attribute -- twenty average characters by
// default, plus a one-character surcharge -- and cannot see the text at all.
// Seventeen such columns is what made the desktop grid overflow with space no
// value was using. fitInputColumnWidths() (web/js/ui/channel-table.js) measures
// the values instead and gives each input column the result as a floor. These
// tests pin that: nothing else here would notice a regression to a fixed width.
import {
  channelRows,
  flushMicrotasks,
  importSampleCsv,
  installFakeDom,
  selectRadioBySearch,
} from "./test-support/fake-dom.mjs";

const HEADERS = ["Location", "Name", "Frequency", "Duplex", "Comment"];

// The stub font: every character this wide, and 2px of padding each side of an
// input. Widths below are therefore characters * 7 + 4, which is what makes the
// expected numbers readable rather than magic.
const CHAR_PX = 7;
const INPUT_PADDING_PX = 4;

function expectedWidth(text) {
  return `${text.length * CHAR_PX + INPUT_PADDING_PX}px`;
}

// installFakeDom() has no layout and no canvas, which is how the grid tells a
// headless caller apart from a browser. Give it just enough of both to measure
// with: a font whose metrics are trivial, and cells whose (zero-sized) boxes
// leave the editor's own padding as the only chrome around the text.
function installMeasurableDom() {
  const fake = installFakeDom({
    window: {
      getComputedStyle: () => ({
        fontStyle: "normal",
        fontWeight: "400",
        fontSize: "14px",
        fontFamily: "Stub",
        paddingLeft: "2px",
        paddingRight: "2px",
      }),
    },
  });
  const createElement = fake.document.createElement.bind(fake.document);
  fake.document.createElement = (tagName) => {
    const element = createElement(tagName);
    if (String(tagName).toLowerCase() === "canvas") {
      element.getContext = () => ({
        font: "",
        measureText: (text) => ({ width: String(text).length * CHAR_PX }),
      });
    }
    return element;
  };
  return fake;
}

// A grid holding the given rows, with the driver metadata given.
async function renderGrid(rows, columns = {}) {
  const { document } = installMeasurableDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultHeaders: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows, errors: [] }),
  });

  await ui.init(true);
  // Without a selected radio the driver's column metadata is never fetched.
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();
  // The grid starts empty; the stubbed parser returns `rows` whatever the file.
  await importSampleCsv(document);
  return document;
}

// The floor each header cell carries, keyed by column. Only input columns get
// one: a select is already as wide as the widest option it may have to show,
// and the Location button prints its slot number as ordinary text the browser
// can measure by itself.
function columnFloors(document) {
  const header = document.querySelector("#mem-table thead").children[0];
  return Object.fromEntries(
    header.children.map((th, idx) => [HEADERS[idx], th.style.minWidth]),
  );
}

test("input columns are measured against the values they hold", async () => {
  const document = await renderGrid(
    [
      { Location: "0", Name: "SR5E", Frequency: "439.375000", Duplex: "-", Comment: "Warszawa" },
      { Location: "1", Name: "SR5KPN", Frequency: "438.200000", Duplex: "-", Comment: "Piaseczno" },
    ],
    { Duplex: { kind: "enum", editable: true, options: ["", "-", "+", "split"] } },
  );

  const floors = columnFloors(document);
  // The widest value in the column, not the widest the driver would allow.
  assert.equal(floors.Name, expectedWidth("SR5KPN"));
  assert.equal(floors.Frequency, expectedWidth("439.375000"));
  assert.equal(floors.Comment, expectedWidth("Piaseczno"));
  // A select sizes itself, so nothing is imposed on it.
  assert.equal(floors.Duplex, undefined);
  assert.equal(floors.Location, undefined);

  // The inputs ask the browser for nothing, which is what leaves the floors
  // above in charge of the column.
  const row = channelRows(document)[0];
  assert.deepEqual(
    row.children.filter((td) => td.children[0]?.tagName === "INPUT").map((td) => td.children[0].size),
    [1, 1, 1],
  );
});

test("a long value is capped, and an empty column asks for nothing", async () => {
  const document = await renderGrid([
    { Location: "0", Name: "", Frequency: "146.520000", Comment: "x".repeat(40) },
  ]);

  const floors = columnFloors(document);
  // Sixteen characters is the ceiling; the rest scrolls inside the input.
  assert.equal(floors.Comment, expectedWidth("x".repeat(16)));
  // A column with nothing in it falls back to its header, which the browser
  // applies on top of this floor.
  assert.equal(floors.Name, expectedWidth(""));
});

test("editing a cell refits its column, in both directions", async () => {
  const document = await renderGrid([
    { Location: "0", Name: "SR5E", Frequency: "146.520000", Comment: "" },
  ]);
  const header = document.querySelector("#mem-table thead").children[0];
  const commentIdx = HEADERS.indexOf("Comment");
  const editor = channelRows(document)[0].children[commentIdx].children[0];

  // A typed value is one the browser never laid out, so the refit has to
  // happen when the edit commits rather than at the next render.
  editor.value = "Konstancin";
  document.querySelector("#mem-table tbody").dispatchEvent({
    type: "focusout",
    target: editor,
  });
  assert.equal(header.children[commentIdx].style.minWidth, expectedWidth("Konstancin"));

  editor.value = "";
  document.querySelector("#mem-table tbody").dispatchEvent({
    type: "focusout",
    target: editor,
  });
  assert.equal(header.children[commentIdx].style.minWidth, expectedWidth(""));
});

test("the Location header is abbreviated without renaming the column", async () => {
  const document = await renderGrid([{ Location: "0", Name: "SR5E" }]);
  const header = document.querySelector("#mem-table thead").children[0];
  const location = header.children[0];

  // The widest thing in the slot-number column used to be the word above it.
  assert.equal(location.textContent, "#");
  // An abbreviation still has to name its column to anyone who cannot see the
  // grid, and to a user hovering the header.
  assert.equal(location.attributes.get("aria-label"), "Location");
  assert.equal(location.title, "Location");
  // Every other header is spelled out as the driver names it.
  assert.deepEqual(
    header.children.slice(1).map((th) => th.textContent),
    HEADERS.slice(1),
  );

  // The label is display only: rows, and the cells bound to them, are still
  // keyed by CHIRP's own column name.
  assert.equal(channelRows(document)[0].children[0].dataset.column, "Location");
});

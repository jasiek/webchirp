import assert from "node:assert/strict";
import test from "node:test";

// The channel grid takes its natural width from its cells, and an <input> is
// the one editor whose width has nothing to do with the value inside it: the
// browser sizes it from the size attribute -- twenty average characters by
// default, plus a one-character surcharge -- and never looks at the text.
// Seventeen such columns is what made the desktop grid overflow with space no
// value was using. The grid now hands that job to field-sizing in
// web/styles.css, which needs two things from here that nothing else asserts:
// inputs that ask the browser for no width of their own, and the stylesheet
// rule that gives them one. The resulting layout is the browser's own and
// cannot be checked headlessly -- the fake DOM has no layout at all -- so it is
// verified in a real browser instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  channelRows,
  flushMicrotasks,
  importSampleCsv,
  installFakeDom,
  selectRadioBySearch,
} from "./test-support/fake-dom.mjs";

const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADERS = ["Location", "Name", "Frequency", "Duplex", "Comment"];

async function renderGrid(rows, columns = {}) {
  const { document } = installFakeDom();
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

test("text editors ask the browser for no width of their own", async () => {
  const document = await renderGrid(
    [
      { Location: "0", Name: "SR5E", Frequency: "439.375000", Duplex: "-", Comment: "Warszawa" },
      { Location: "1", Name: "SR5KPN", Frequency: "438.200000", Duplex: "-", Comment: "Piaseczno" },
    ],
    { Duplex: { kind: "enum", editable: true, options: ["", "-", "+", "split"] } },
  );

  const row = channelRows(document)[0];
  const editors = row.children.map((td) => td.children[0]);
  // A size of 1 is what leaves the stylesheet in charge of the column. It also
  // decides the fallback: where field-sizing is missing, the size attribute is
  // still what governs, so those columns come out at their header width rather
  // than at the browser's twenty-character default.
  assert.deepEqual(
    editors.filter((editor) => editor.tagName === "INPUT").map((editor) => editor.size),
    [1, 1, 1],
  );
  // Nothing is imposed on the editors that already size themselves: a select is
  // as wide as the widest option it may have to show, and the Location button
  // prints its slot number as ordinary text the browser can measure.
  assert.equal(editors[HEADERS.indexOf("Duplex")].tagName, "SELECT");
  assert.equal(editors[HEADERS.indexOf("Duplex")].size, undefined);
  assert.equal(editors[HEADERS.indexOf("Location")].tagName, "BUTTON");
});

test("the stylesheet sizes grid inputs from their contents", () => {
  const styles = fs.readFileSync(path.join(repoRootDir, "web", "styles.css"), "utf8");
  const rule = styles.match(
    /@supports \(field-sizing: content\) \{\s*#mem-table td input \{([^}]*)\}/,
  );
  assert.ok(rule, "grid inputs must be sized by field-sizing, behind an @supports guard");

  const declarations = rule[1];
  assert.match(declarations, /field-sizing:\s*content/);
  // Each of these is load-bearing, and each fails silently if it is dropped: a
  // percentage width suppresses field-sizing outright and the columns fall back
  // to their header widths; without the percentage minimum the input stops
  // filling its cell, so a click in the empty part of a cell reaches no editor;
  // without the cap one long comment takes a third of the window.
  assert.match(declarations, /width:\s*auto/);
  assert.match(declarations, /min-width:\s*100%/);
  assert.match(declarations, /max-width:\s*\d+ch/);
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

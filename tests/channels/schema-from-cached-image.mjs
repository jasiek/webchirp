// Where the channel grid's column schema comes from once a codeplug is loaded.
//
// Some CHIRP drivers read their own capabilities out of the codeplug, so a
// driver instantiated with no image describes a different radio than the same
// driver holding one. Retevis RT98 is the documented case: blank it reports the
// PMR band plan (one power level, no offset, no duplex), and loaded it reports
// the Low/Mid/High levels and the repeater duplexes the image configures.
//
// Every other consumer of a driver's features -- the upload preflight, the row
// builders, the power-level resolver -- already prefers the cached image. The
// grid did not, so a downloaded RT98 channel carried a "High" its own dropdown
// did not list, and re-selecting the radio blanked it as unsupported
// (dropUnsupportedPowerValues in web/js/ui/channel-table.js). Issue #86.
//
// The two tests here are the two halves of that: what the runtime reports for a
// driver with an image cached, and whether the download path asks it again.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureModule,
  loadImageFor,
  readCatalog,
  sharedHarness,
} from "../support/chirp.mjs";
import {
  channelRows,
  flushMicrotasks,
  installFakeDom,
  selectRadioBySearch,
} from "../support/fake-dom.mjs";

const RT98 = {
  vendor: "Retevis",
  model: "RT98",
  module: "retevis_rt98",
  className: "Rt98Radio",
  key: "retevis_rt98:Rt98Radio",
  isLiveRadio: false,
};

function columnMetadata(harness) {
  return harness.runPythonJson("json.dumps(get_radio_column_metadata(_m, _c))", {
    _m: RT98.module,
    _c: RT98.className,
  });
}

// The rendered editor for one row's column, found by the cell's own data-column
// rather than a header index, so the Extra column and any header reordering
// leave the lookup alone.
function cellEditor(document, rowIdx, column) {
  const row = channelRows(document)[rowIdx];
  const cell = row.children.find((td) => td.dataset.column === column);
  return cell?.children[0];
}

test("column metadata follows the cached image, not a blank driver instance", async () => {
  const harness = await sharedHarness();
  const catalog = await readCatalog();
  await ensureModule(harness, RT98.module);

  // Before any image: the driver's blank state, which is the PMR radio. This
  // has to run first -- loading the image below caches it for the rest of the
  // file's runtime.
  const blank = await columnMetadata(harness);
  assert.deepEqual(blank.columns.Power.options, ["Low"]);
  assert.equal(blank.columns.Offset.editable, false);

  const { loaded } = await loadImageFor(harness, catalog, "Retevis_RT98.img");

  // After it: the radio the image actually configures.
  const withImage = await columnMetadata(harness);
  assert.deepEqual(withImage.columns.Power.options, ["Low", "Mid", "High"]);
  assert.equal(withImage.columns.Offset.editable, true);
  // The wattages are the loaded radio's too, not the PMR 0.5W.
  assert.equal(withImage.columns.Power.optionWatts.Low, "5.0W");

  // The point of the whole thing: every level the loaded channels carry is one
  // the grid offers, so no row holds a value its own dropdown calls unsupported.
  const offered = new Set(withImage.columns.Power.options);
  const carried = [...new Set(loaded.rows.map((row) => row.Power).filter(Boolean))];
  assert.ok(carried.includes("High"), "the test image should exercise a non-blank level");
  for (const level of carried) {
    assert.ok(offered.has(level), `Power "${level}" should be offered by the grid`);
  }
});

test("a download re-reads the schema, so the levels it just read survive", async () => {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  const headers = ["Location", "Name", "Frequency", "Power"];
  // The same driver seen twice: what it reports with nothing loaded, and what
  // it reports once the download has cached an image for it.
  const blankColumns = {
    Power: { kind: "enum", editable: true, options: ["Low"], default: "" },
  };
  const loadedColumns = {
    Power: { kind: "enum", editable: true, options: ["Low", "Mid", "High"], default: "" },
  };
  let downloaded = false;

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: [RT98] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers, columns: {} }),
    getRadioMetadata: async () => ({
      headers,
      columns: downloaded ? loadedColumns : blankColumns,
    }),
    getRadioSettings: async () => ({
      supported: false,
      available: false,
      requiresImage: false,
      message: "",
      groups: [],
    }),
    parseCsv: async () => ({ headers, rows: [], errors: [] }),
    downloadSelectedRadio: async () => {
      downloaded = true;
      return {
        headers,
        rows: [
          { Location: "1", Name: "PMR01", Frequency: "446.006250", Power: "Low" },
          { Location: "2", Name: "REP01", Frequency: "145.600000", Power: "High" },
        ],
        settings: [],
      };
    },
  });

  await ui.init(true);
  selectRadioBySearch(document, "rt98");
  await flushMicrotasks();
  assert.equal(channelRows(document).length, 0, "the grid starts empty");

  document.querySelector("#radio-download").click();
  // Twice: the clone settles on the first, the schema refresh it now waits for
  // on the second.
  await flushMicrotasks();
  await flushMicrotasks();

  const powerSelect = cellEditor(document, 1, "Power");
  assert.deepEqual(
    powerSelect.children.map((option) => option.value),
    ["Low", "Mid", "High"],
    "the dropdown should list the levels the downloaded image publishes",
  );
  // The row keeps what the radio reported. Before the refresh the grid still
  // held the blank schema, and applying it cleared every level not in it.
  assert.equal(powerSelect.value, "High");
});

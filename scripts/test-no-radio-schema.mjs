// The schema the grid runs on before a radio is selected.
//
// CHIRP has no "no radio" state: an editor with nothing loaded is
// generic_csv.CSVRadio, a real driver whose RadioFeatures are deliberately
// permissive. This app follows it — loadEmptySchema (web/js/ui/codeplug-io.js)
// installs get_default_schema() (web/python/webchirp_bridge/column_metadata.py)
// as state.radioMetadata — so the startup grid offers the same pickers,
// validates through the same code path and imports through the same row
// builders that a selected radio does.
//
// The tests here cover the three halves of that: what the runtime reports for
// the CSV driver, what the grid does with it, and what the row builders do
// when a column carries no metadata at all — which is still reachable while
// the startup schema is in flight, and is what made a przemienniki.net query
// fetch 377 repeaters and insert 0, reporting them as needing a mode or a tone
// "the selected radio" could not use while no radio was selected.

import assert from "node:assert/strict";
import test from "node:test";

import { CSV_FORMAT_HEADERS } from "../web/js/clipboard.js";
import { buildPmr446Rows, buildPrzemiennikiRows } from "../web/js/datasources.js";
import { buildRsgbRows } from "../web/js/rsgb.js";
import { ensureModule, sharedHarness } from "./test-support/chirp.mjs";
import {
  FakeElement,
  channelRows,
  flushMicrotasks,
  installFakeDom,
  selectRadioBySearch,
} from "./test-support/fake-dom.mjs";

// The grid with the driver metadata a caller passes in. `columns` undefined is
// the state before the startup schema has been fetched.
async function tableWithMetadata(columns, rows = []) {
  installFakeDom();
  const { createChannelTable } = await import("../web/js/ui/channel-table.js");
  const dom = {
    tableHead: new FakeElement("thead"),
    tableBody: new FakeElement("tbody"),
    tableScrollEl: new FakeElement("div"),
    channelEmptyStateEl: new FakeElement("div"),
  };
  const state = {
    currentHeaders: CSV_FORMAT_HEADERS.slice(),
    currentRows: rows,
    radioMetadata: columns ? { headers: CSV_FORMAT_HEADERS.slice(), columns } : {},
  };
  return createChannelTable({
    dom,
    state,
    log: { setStatus() {}, logDebug() {} },
    actions: {},
  });
}

// A przemienniki.net record: repeater perspective, so `qrgRx` is the repeater's
// input (what the radio transmits) and `ctcssRx` its access tone.
const SR4X = {
  qra: "SR4X",
  mode: "fm",
  qrgRx: 145.0,
  qrgTx: 145.6,
  ctcssRx: "88.5",
  ctcssTx: "",
  qth: "Olsztyn",
};

test("the startup schema is CHIRP's generic CSV driver reporting its own features", async () => {
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");

  // CSVRadio advertises DV, so the D-STAR columns stay in the header list.
  assert.deepEqual(schema.headers, CSV_FORMAT_HEADERS);

  // Permissive, but real: 1 Hz to 10 GHz is what valid_bands says, so no
  // frequency a directory publishes can be refused for being out of band.
  assert.deepEqual(schema.columns.Frequency.bands, [[1, 10000000000]]);
  for (const mode of ["FM", "NFM", "DV", "DMR", "DN", "P25"]) {
    assert.ok(schema.columns.Mode.options.includes(mode), `Mode should offer ${mode}`);
  }
  for (const tmode of ["", "Tone", "TSQL", "Cross"]) {
    assert.ok(schema.columns.Tone.options.includes(tmode), `Tone should offer ${tmode}`);
  }
  // The full CHIRP table, so a directory tone is refused only by a real radio.
  assert.equal(schema.columns.rToneFreq.options.length, 50);
  assert.ok(schema.columns.rToneFreq.options.includes("141.3"));
});

test("an infinite-number driver's Location column carries no upper bound", async () => {
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");

  // CSVRadio is the only driver in CHIRP that sets has_infinite_number, and
  // CHIRP's own validate_memory skips the range check for it. Capping the CSV
  // schema at its nominal 999 would blank the Location of every row past the
  // thousandth on a large import (RepeaterBook's US 2m list is 1,272 records).
  assert.equal(schema.columns.Location.min, 0);
  assert.equal("max" in schema.columns.Location, false);

  // A real driver still gets its memory_bounds.
  await ensureModule(harness, "uv5r");
  const uv5r = await harness.runPythonJson(
    "json.dumps(get_radio_column_metadata(_m, _c))",
    { _m: "uv5r", _c: "BaofengUV5RGeneric" },
  );
  assert.equal(uv5r.columns.Location.max, 127);
});

test("each enum column publishes CHIRP's own default, not its first option", async () => {
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");

  // chirp_common.Memory() is what a new channel is in CHIRP. The first option
  // is a poor stand-in for it in exactly the places that matter: the full mode
  // list starts at WFM and every CTCSS table at 67.0.
  assert.equal(schema.columns.Mode.options[0], "WFM");
  assert.equal(schema.columns.Mode.default, "FM");
  assert.equal(schema.columns.rToneFreq.options[0], "67.0");
  assert.equal(schema.columns.rToneFreq.default, "88.5");
  assert.equal(schema.columns.cToneFreq.default, "88.5");
  assert.equal(schema.columns.CrossMode.default, "Tone->Tone");
  assert.equal(schema.columns.DtcsPolarity.default, "NN");
  assert.equal(schema.columns.TStep.default, "5.00");
  assert.equal(schema.columns.Tone.default, "");

  // A default Memory carries no power level, so Power's default is blank —
  // deliberately not one of the options. See the Power tests below.
  assert.equal(schema.columns.Power.default, "");
});

test("a column with no published default still falls back to its first option", async () => {
  // _with_default omits the key when the driver's list does not carry CHIRP's
  // value — a narrow-only radio has no plain "FM" — so the grid behaves as it
  // always did rather than seeding a mode the driver cannot hold.
  const table = await tableWithMetadata({
    Mode: { kind: "enum", editable: true, options: ["NFM", "DV"] },
  });

  assert.equal(table.createBlankChannelRow().Mode, "NFM");
});

test("a blank channel starts on CHIRP's defaults under the startup schema", async () => {
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");
  const table = await tableWithMetadata(schema.columns);

  const row = table.createBlankChannelRow();
  assert.equal(row.Mode, "FM");
  assert.equal(row.rToneFreq, "88.5");
  assert.equal(row.cToneFreq, "88.5");
  assert.equal(row.CrossMode, "Tone->Tone");
  assert.equal(row.Tone, "");
  assert.equal(row.Location, "", "the location is assigned on insert, not defaulted");
});

// Power is the column where CHIRP's answer is "none" and the grid's old
// options[0] guess was not merely arbitrary but unusable: the levels are
// per-driver labels, so a level chosen under one schema blocks the upload
// preflight under another. Both halves of that are pinned here — what a row
// starts with, and what happens to a row that predates the radio.

test("no schema seeds a power level onto a channel that never chose one", async () => {
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");

  // The generic driver's placeholder levels are the ones that made this bite:
  // 0.1W is its first option and no ordinary handheld advertises it.
  assert.deepEqual(schema.columns.Power.options, ["0.1W", "50W", "1500W"]);
  assert.equal(schema.columns.Power.default, "");
  assert.equal(await tableWithMetadata(schema.columns)
    .then((table) => table.createBlankChannelRow().Power), "");

  // The same rule on a real radio: a blank channel holds no level until one is
  // chosen, exactly as chirp_common.Memory() does.
  await ensureModule(harness, "uv5r");
  const uv5r = await harness.runPythonJson(
    "json.dumps(get_radio_column_metadata(_m, _c))",
    { _m: "uv5r", _c: "BaofengUV5RGeneric" },
  );
  assert.deepEqual(uv5r.columns.Power.options, ["High", "Low"]);
  assert.equal(uv5r.columns.Power.default, "");
  const table = await tableWithMetadata(uv5r.columns);
  assert.equal(table.createBlankChannelRow().Power, "");
});

test("a repeater imported before a radio was picked passes that radio's preflight", async () => {
  // The whole point of the workflow this branch enables: import, then choose
  // the radio, then upload. RSGB is the source that writes a Power of its own,
  // and under the generic schema the only level it recognises is 50W — a
  // label a UV-5R does not publish, so the row would be rejected outright.
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");
  const table = await tableWithMetadata(schema.columns);

  const { rows } = buildRsgbRows(
    [{
      record: {
        repeater: "GB3XP", tx: 145687500, rx: 145087500,
        ctcss: 77, mode: "A", band: "2M", locator: "IO91VJ", status: "OPERATIONAL",
      },
      distanceKm: 12,
    }],
    table.rowBuilderHooks(),
    { modes: ["A"] },
  );
  assert.equal(rows[0].Power, "50W", "honest under the schema that built it");
  rows[0].Location = "0";

  await ensureModule(harness, "uv5r");
  const uv5r = await harness.runPythonJson(
    "json.dumps(get_radio_column_metadata(_m, _c))",
    { _m: "uv5r", _c: "BaofengUV5RGeneric" },
  );
  const rejected = await harness.runPythonJson(
    "json.dumps(validate_rows_for_upload(json.loads(_rows), _m, _c))",
    { _rows: JSON.stringify(rows), _m: "uv5r", _c: "BaofengUV5RGeneric" },
  );
  assert.equal(rejected.valid, false, "the level is a word this radio does not speak");
  assert.match(rejected.issues[0].message, /Power '50W' is not supported/);

  // Selecting the radio is what resolves it: the label goes, the channel stays.
  const withRows = await tableWithMetadata(uv5r.columns, rows);
  assert.equal(withRows.dropUnsupportedPowerValues(), 1);
  assert.equal(rows[0].Power, "");
  assert.equal(rows[0].Frequency, "145.687500", "nothing else is touched");

  const accepted = await harness.runPythonJson(
    "json.dumps(validate_rows_for_upload(json.loads(_rows), _m, _c))",
    { _rows: JSON.stringify(rows), _m: "uv5r", _c: "BaofengUV5RGeneric" },
  );
  assert.deepEqual(accepted.issues, []);
  assert.equal(accepted.valid, true);
});

test("a power level the radio does publish survives the schema swap", async () => {
  const rows = [{ Power: "High", Frequency: "145.500000" }];
  const table = await tableWithMetadata(
    { Power: { kind: "enum", editable: true, options: ["High", "Low"] } },
    rows,
  );

  assert.equal(table.dropUnsupportedPowerValues(), 0);
  assert.equal(rows[0].Power, "High");
});

test("a driver that publishes no power levels measures nothing", async () => {
  // 99 driver classes advertise none. An empty list is not evidence that a
  // row's level is wrong, so nothing is cleared.
  const rows = [{ Power: "5.0W" }];
  const table = await tableWithMetadata(
    { Power: { kind: "enum", editable: true, options: [] } },
    rows,
  );

  assert.equal(table.dropUnsupportedPowerValues(), 0);
  assert.equal(rows[0].Power, "5.0W");
});

test("the startup schema imports every repeater a directory offers", async () => {
  const harness = await sharedHarness();
  const schema = await harness.runPythonJson("json.dumps(get_default_schema())");
  const table = await tableWithMetadata(schema.columns);

  const { rows, skipped } = buildPrzemiennikiRows([SR4X], table.rowBuilderHooks());

  assert.deepEqual(skipped, []);
  assert.equal(rows[0].Frequency, "145.600000");
  assert.equal(rows[0].Duplex, "-");
  assert.equal(rows[0].Tone, "Tone");
  assert.equal(rows[0].rToneFreq, "88.5");
  assert.equal(rows[0].Mode, "FM");
});

test("loadEmptySchema installs the whole schema, not just its headers", async () => {
  const { document } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  const schema = {
    headers: ["Location", "Name", "Frequency", "Mode"],
    columns: {
      Location: { kind: "int", editable: false, min: 0 },
      Mode: { kind: "enum", editable: true, options: ["WFM", "FM"], default: "FM" },
    },
  };

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: [] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => schema,
    getRadioMetadata: async () => ({ headers: [], columns: {} }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
  });
  await ui.init(true);

  // Inserting a channel with no radio selected is the observable proof that
  // the columns landed: the Mode cell is the driver's picker on its documented
  // default rather than a free-text box.
  document.querySelector("#channel-insert").dispatchEvent({ type: "click" });
  const modeCell = channelRows(document)[0].children[3].children[0];
  assert.equal(modeCell.tagName, "SELECT");
  assert.equal(modeCell.value, "FM");
});

test("selecting a radio is what clears a power level it cannot hold", async () => {
  // The seam the unit tests above cannot see: dropUnsupportedPowerValues is
  // correct on its own, but nothing proved applyRadioMetadata calls it, so
  // deleting that call would leave the fix out of the running app with every
  // test still green.
  const { document } = installFakeDom();
  const { createUiController } = await import("../web/js/ui.js");
  const ui = createUiController();
  const headers = ["Location", "Name", "Frequency", "Power"];

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    // The generic schema a channel is built under: its levels are the CSV
    // driver's placeholders, and 50W is the one buildRsgbRows matches there.
    getDefaultSchema: async () => ({
      headers,
      columns: {
        Location: { kind: "int", editable: false, min: 0 },
        Power: { kind: "enum", editable: true, options: ["0.1W", "50W", "1500W"], default: "50W" },
      },
    }),
    // The radio the user then picks, which names its levels differently.
    getRadioMetadata: async () => ({
      headers,
      columns: {
        Location: { kind: "int", editable: false, min: 0, max: 127 },
        Power: { kind: "enum", editable: true, options: ["High", "Low"] },
      },
    }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
  });
  await ui.init(true);

  document.querySelector("#channel-insert").dispatchEvent({ type: "click" });
  assert.equal(channelRows(document)[0].children[3].children[0].value, "50W");

  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();

  // A row that kept its stale label renders it: bindCellEditor appends an
  // option for a value outside the driver's list and selects it, so "50W"
  // surviving here is exactly what an unwired clear would look like. (A
  // cleared cell reads as the fake DOM's empty-select convention — its first
  // option — rather than the browser's "", which is what the real grid shows.)
  const powerCell = channelRows(document)[0].children[3].children[0];
  assert.notEqual(powerCell.value, "50W", "the label this radio cannot hold is gone");
  assert.deepEqual(
    powerCell.children.map((option) => option.value),
    ["High", "Low"],
    "and it left no option behind for itself",
  );
  assert.match(
    document.querySelector("#debug-output").value,
    /RADIO POWER cleared on 1 channel\(s\)/,
    "an edit the user can see has to be said out loud",
  );
});

// Everything below is the state before the startup schema resolves, and after
// a CSV load whose headers come from the file: headers in place, no columns
// behind them. setRowValue writes anything through there, so findEnumOption
// has to agree — reading the absent option list as "the radio refuses this"
// is what made every builder skip every record it was handed.

test("a przemienniki query with no column metadata inserts its repeaters", async () => {
  const table = await tableWithMetadata();

  const { rows, skipped } = buildPrzemiennikiRows([SR4X], table.rowBuilderHooks());

  assert.deepEqual(skipped, [], "nothing constrains the row, so nothing may be dropped");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Name, "SR4X");
  assert.equal(rows[0].Frequency, "145.600000");
  assert.equal(rows[0].Duplex, "-");
  assert.equal(rows[0].Offset, "0.600000");
  assert.equal(rows[0].Tone, "Tone");
  assert.equal(rows[0].rToneFreq, "88.5");
  assert.equal(rows[0].Mode, "FM");
});

test("an RSGB query with no column metadata inserts its repeaters", async () => {
  const table = await tableWithMetadata();

  const { rows, skipped } = buildRsgbRows(
    [{
      record: {
        repeater: "GB3XP", tx: 145687500, rx: 145087500,
        ctcss: 77, mode: "A", band: "2M", locator: "IO91VJ", status: "OPERATIONAL",
      },
      distanceKm: 12,
    }],
    table.rowBuilderHooks(),
    { modes: ["A"] },
  );

  assert.deepEqual(skipped, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Frequency, "145.687500");
  assert.equal(rows[0].Tone, "Tone");
  assert.equal(rows[0].rToneFreq, "77.0");
  // The record carries no txbw, which findRsgbMode reads as narrow, so its
  // analogue ranking starts at NFM — the first choice, as everywhere else here.
  assert.equal(rows[0].Mode, "NFM");
});

test("a band-plan preset with no column metadata still gets its mode", async () => {
  const table = await tableWithMetadata();

  const rows = buildPmr446Rows(table.rowBuilderHooks());

  assert.equal(rows.length, 16);
  assert.equal(rows[0].Mode, "NFM", "the first choice the preset ranks");
});

test("a selected radio still constrains what an import may write", async () => {
  // The relaxation must not turn the driver check off: this radio's tables are
  // the ones that decide, and they lack both the repeater's mode and its tone.
  const table = await tableWithMetadata({
    Frequency: { kind: "freq", editable: true, bands: [[144000000, 148000000]] },
    Tone: { kind: "enum", editable: true, options: ["", "Tone", "TSQL", "Cross"] },
    rToneFreq: { kind: "enum", editable: true, options: ["67.0", "94.8"] },
    Mode: { kind: "enum", editable: true, options: ["DV"] },
  });

  const { rows, skipped } = buildPrzemiennikiRows([SR4X], table.rowBuilderHooks());

  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [{ repeater: "SR4X", reason: "tone", tone: "88.5" }]);
});

test("a driver that publishes an empty option list still means 'cannot'", async () => {
  // The distinction the relaxation rests on: an absent metadata entry is a
  // radio that has said nothing, while an entry carrying an empty options
  // array is the driver itself advertising no choices. Only the first is
  // unconstrained — 99 driver classes publish no power levels that way.
  const table = await tableWithMetadata({
    Mode: { kind: "enum", editable: true, options: [] },
  });

  assert.equal(table.findEnumOption("Mode", ["FM", "NFM"], true), "");
  assert.equal(table.findEnumOption("Tone", ["Tone"], true), "Tone", "no entry at all");
});

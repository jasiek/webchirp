import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCellValue, parseFreqToHz } from "../../web/js/ui/channel-values.ts";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";

// What a value typed into a grid cell becomes is decided in one place: the
// Python runtime's normalize_cell (web/python/webchirp_bridge/row_normalization.py),
// reached through the normalize_and_validate_rows RPC. It replaced a copy of
// the same rules in the browser (normalizeCellValue, web/js/ui/channel-values.ts),
// and this table is how the move is proved: every case the JS tests covered
// (tests/channels/channel-values.mjs), plus the parsing edges the two
// languages could disagree on, run through both implementations against the
// column metadata the runtime reports for a real driver, and each must give
// the stored value and the accepted flag listed here.
//
// The drivers stand in for the hand-written metadata the JS tests used:
//   uv5r   - 50-tone CTCSS table, 0-127 memories, 7-character upper-case
//            names, read-only TStep, bands 130-176/220-260/400-520 MHz;
//   alinco - DR135, which publishes no power levels, so Power is an enum with
//            no options and constrains nothing;
//   ""     - no radio: CHIRP's generic CSV driver, permissive everywhere.
const DRIVERS = {
  uv5r: { module: "uv5r", className: "BaofengUV5R" },
  alinco: { module: "alinco", className: "DR135Radio" },
};

// [driver, column, value, previous, allowReadOnly, expected value, expected accepted]
const CASES = [
  // An enum value the driver does not offer is reported as rejected, and the
  // cell keeps its previous value (issue #104).
  ["uv5r", "rToneFreq", "150.0", "67.0", false, "67.0", false],
  // ... and with no previous value, the first option.
  ["uv5r", "rToneFreq", "150.0", undefined, false, "67.0", false],
  // An offered enum value, padded or not, is accepted.
  ["uv5r", "rToneFreq", "110.9", "67.0", false, "110.9", true],
  ["uv5r", "rToneFreq", "88.50", "67.0", false, "88.5", true],
  ["uv5r", "rToneFreq", " 88.5", "67.0", false, "88.5", true],
  ["uv5r", "DtcsCode", "23", "023", false, "023", true],
  ["uv5r", "TStep", "5", "5.00", true, "5.00", true],
  // A column with no option list validates nothing and accepts everything.
  ["alinco", "Power", "5W", "", false, "5W", true],
  ["", "rToneFreq", "141.3", "", false, "141.3", true],
  // Out-of-band and unparsable frequencies are rejected, in-band ones accepted.
  ["uv5r", "Frequency", "1312.000000", "145.000000", false, "145.000000", false],
  ["uv5r", "Frequency", "not a frequency", "145.000000", false, "145.000000", false],
  ["uv5r", "Frequency", "145.500000", "145.000000", false, "145.500000", true],
  ["uv5r", "Frequency", "-145.5", "145.000000", false, "145.000000", false],
  ["uv5r", "Frequency", "1.45e2", "145.000000", false, "145.000000", false],
  // An accepted frequency is stored exactly as typed.
  ["uv5r", "Frequency", " 145.5 ", "145.000000", false, " 145.5 ", true],
  // Offset is exempt from the band check, as a shift is not a frequency.
  ["uv5r", "Offset", "600.000000", "0.000000", false, "600.000000", true],
  ["", "Frequency", "1312.000000", "145.000000", false, "1312.000000", true],
  // An int outside the driver's range is clamped and reported as not accepted.
  ["uv5r", "Location", "300", "1", true, "127", false],
  ["uv5r", "Location", "-4", "1", true, "0", false],
  ["uv5r", "Location", "abc", "7", true, "7", false],
  ["uv5r", "Location", "42", "1", true, "42", true],
  ["uv5r", "Location", "4.7", "1", true, "4", true],
  ["uv5r", "Location", " 12abc", "1", true, "12", true],
  // A read-only column rejects unless the caller is a row builder.
  ["uv5r", "Location", "42", "1", false, "1", false],
  ["uv5r", "TStep", "6.25", "5.00", false, "5.00", false],
  ["uv5r", "TStep", "6.25", "5.00", true, "6.25", true],
  // Text coercion keeps the caller's value, so it counts as accepted.
  ["uv5r", "Name", "GB3KI~~~", "", false, "GB3KI", true],
  ["uv5r", "Name", "REPEATER1", "", false, "REPEATE", true],
  ["uv5r", "Name", "gb3ki", "", false, "3", true],
  ["", "Name", "Any name at all", "", false, "Any name at all", true],
  // A blank frequency is accepted as the erase value (issue #93).
  ["uv5r", "Frequency", "", "145.000000", false, "", true],
  ["uv5r", "Frequency", "   ", "145.000000", false, "", true],
  ["uv5r", "Offset", "", "600.000000", false, "", true],
  // A column the schema does not describe stores the text as is.
  ["uv5r", "NoSuchColumn", "anything", "", false, "anything", true],
];

// One session per driver, and the schema the grid would be built from for it.
async function schemas(harness) {
  const out = { "": { sessionId: "", columns: (await harness.rpc("get_default_schema")).columns } };
  for (const [key, { module, className }] of Object.entries(DRIVERS)) {
    await ensureModule(harness, module);
    const { sessionId } = await harness.rpc("open_session", { module_name: module, class_name: className });
    const { columns } = await harness.rpc("get_radio_column_metadata", { session_id: sessionId });
    out[key] = { sessionId, columns };
  }
  return out;
}

test("the runtime normalizes every cell case exactly as the browser's rules did", async () => {
  const harness = await sharedHarness();
  const bySession = await schemas(harness);
  for (const [driver, { sessionId, columns }] of Object.entries(bySession)) {
    const cases = CASES.filter(([caseDriver]) => caseDriver === driver);
    // One call per driver, one request per case: the batching the grid uses.
    const result = await harness.rpc("normalize_and_validate_rows", {
      session_id: sessionId,
      rows: cases.map(([, column, value, previous, allowReadOnly]) => ({
        row: previous === undefined ? {} : { [column]: previous },
        edits: [{ column, value, allowReadOnly }],
      })),
    });
    assert.equal(result.rows.length, cases.length);
    cases.forEach(([, column, value, previous, allowReadOnly, wantValue, wantAccepted], index) => {
      const label = `${driver || "no radio"} ${column} ${JSON.stringify(value)}`;
      const [cell] = result.rows[index].cells;
      assert.deepEqual(
        { value: cell.value, accepted: cell.accepted },
        { value: wantValue, accepted: wantAccepted },
        `Python: ${label}`,
      );
      assert.deepEqual(
        normalizeCellValue(column, value, columns[column] || {}, previous, { allowReadOnly }),
        { value: wantValue, accepted: wantAccepted },
        `JavaScript: ${label}`,
      );
    });
  }
});

test("a changed value carries a note saying what happened; an unchanged one none", async () => {
  const harness = await sharedHarness();
  const { sessionId } = (await schemas(harness)).uv5r;
  const result = await harness.rpc("normalize_and_validate_rows", {
    session_id: sessionId,
    rows: [
      { row: { Name: "" }, edits: [{ column: "Name", value: "REPEATER~" }] },
      { row: { Frequency: "145.000000" }, edits: [{ column: "Frequency", value: "1312" }] },
      { row: { Frequency: "145.000000" }, edits: [{ column: "Frequency", value: "145.5" }] },
    ],
  });
  const notes = result.rows.map((row) => row.cells[0].note);
  assert.match(notes[0], /removed characters/i);
  assert.match(notes[0], /truncated to 7 characters/);
  assert.match(notes[1], /outside the radio's bands/i);
  assert.equal(notes[2], "");
});

test("edits to one row apply in order, each falling back to what the one before stored", async () => {
  const harness = await sharedHarness();
  const { sessionId } = (await schemas(harness)).uv5r;
  const result = await harness.rpc("normalize_and_validate_rows", {
    session_id: sessionId,
    rows: [{
      row: { rToneFreq: "67.0" },
      edits: [
        { column: "rToneFreq", value: "88.50" },
        { column: "rToneFreq", value: "150.0" },
      ],
    }],
  });
  assert.deepEqual(
    result.rows[0].cells.map(({ value, accepted }) => ({ value, accepted })),
    [{ value: "88.5", accepted: true }, { value: "88.5", accepted: false }],
  );
});

test("frequency text parses to hertz the same way on both sides", async () => {
  const harness = await sharedHarness();
  const inputs = ["", "145.5", "145.0000005", "446.00625", " 7.1 ", "abc", "1e3"];
  const python = await harness.runPythonJson(
    "json.dumps([parse_freq_to_hz(text) for text in json.loads(_inputs)])",
    { _inputs: JSON.stringify(inputs) },
  );
  assert.deepEqual(python, inputs.map((text) => parseFreqToHz(text)));
});

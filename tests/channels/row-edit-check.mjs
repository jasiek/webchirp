import assert from "node:assert/strict";
import test from "node:test";

import { ensureModule, sharedHarness } from "../support/chirp.mjs";

// normalize_and_validate_rows (web/python/webchirp_bridge/row_validation.py)
// is what the grid sends a committed cell to. Its column rules are pinned by
// tests/channels/row-normalization.mjs; these pin the other half, the driver's
// own judgement of the row, which used to be heard only at upload.
//
// The UV-5R is the example because its driver disagrees with its own
// features: RadioFeatures advertises a 220-260 MHz band, so the grid's band
// check lets 235 MHz through, and validate_memory then refuses it for this
// model. That is exactly the kind of objection only the driver can raise.

const BASE_ROW = {
  Location: "1", Name: "", Frequency: "146.520000", Duplex: "", Offset: "0.000000",
  Tone: "", rToneFreq: "88.5", cToneFreq: "88.5", DtcsCode: "023", DtcsPolarity: "NN",
  RxDtcsCode: "023", CrossMode: "Tone->Tone", Mode: "FM", TStep: "5.00", Skip: "",
  Power: "High", Comment: "",
};

async function uv5rSession(harness) {
  await ensureModule(harness, "uv5r");
  const { sessionId } = await harness.rpc("open_session", { module_name: "uv5r", class_name: "BaofengUV5R" });
  return sessionId;
}

function check(harness, sessionId, rows) {
  return harness.rpc("normalize_and_validate_rows", { session_id: sessionId, rows });
}

test("a value the column rules accept but the driver refuses is reported on commit", async () => {
  const harness = await sharedHarness();
  const sessionId = await uv5rSession(harness);
  const result = await check(harness, sessionId, [
    { row: BASE_ROW, edits: [{ column: "Frequency", value: "235.000000" }] },
  ]);
  const [row] = result.rows;
  assert.deepEqual(row.cells.map(({ value, accepted }) => ({ value, accepted })), [
    { value: "235.000000", accepted: true },
  ]);
  assert.equal(row.issues.length, 1);
  assert.equal(row.issues[0].column, "Frequency");
  assert.match(row.issues[0].message, /235\.000000 is out of supported range/);
});

test("a row without a memory number gets the column rules but no driver check", async () => {
  // Row builders normalize rows before they have been given a memory, so
  // nothing can say what the driver would compare them against yet. CHIRP's
  // own parse still says the row has no memory, as the upload would.
  const harness = await sharedHarness();
  const sessionId = await uv5rSession(harness);
  const result = await check(harness, sessionId, [
    { row: { ...BASE_ROW, Location: "" }, edits: [{ column: "Frequency", value: "235.000000" }] },
  ]);
  assert.deepEqual(result.rows[0].issues.map(({ column }) => column), ["Location"]);
});

test("without a radio only the default schema applies", async () => {
  const harness = await sharedHarness();
  const result = await check(harness, "", [
    { row: BASE_ROW, edits: [{ column: "Frequency", value: "235.000000" }] },
  ]);
  assert.deepEqual(result.rows[0].cells.map(({ accepted }) => accepted), [true]);
  assert.deepEqual(result.rows[0].issues, []);
});

test("the upload preflight and the edit check report the same per-row findings", async () => {
  // validate_rows_for_upload runs each row through the same _row_findings the
  // edit check uses; only a Location used twice, which needs every row, is
  // the upload's alone.
  const harness = await sharedHarness();
  const sessionId = await uv5rSession(harness);
  const rows = [
    { ...BASE_ROW, Location: "1", Frequency: "235.000000" },
    { ...BASE_ROW, Location: "2", Duplex: "+", Offset: "100.000000" },
    { ...BASE_ROW, Location: "300" },
    { ...BASE_ROW, Location: "4", Mode: "NOPE" },
    { ...BASE_ROW, Location: "5" },
    { ...BASE_ROW, Location: "5", Name: "TWIN" },
  ];
  const upload = await harness.rpc("validate_rows_for_upload", { rows, session_id: sessionId });
  const edit = await check(harness, sessionId, rows.map((row) => ({ row, edits: [] })));
  const fromEdit = edit.rows.flatMap((row, rowIndex) =>
    row.issues.map(({ column, message }) => ({ rowIndex, column, message })));
  const duplicate = upload.issues.filter(({ message }) => /already used/.test(message));
  assert.equal(duplicate.length, 1, "the duplicate Location is the upload's finding");
  assert.deepEqual(upload.issues.filter((issue) => !duplicate.includes(issue)), fromEdit);
  assert.ok(fromEdit.length >= 4, "every bad row produced a finding");
});

test("the per-edit check is built once per image and rebuilt when the image changes", async () => {
  const harness = await sharedHarness();
  const sessionId = await uv5rSession(harness);
  const rebuilt = await harness.runPythonJson(`
_s = resolve_session(_sid)
_first = _edit_check_context(_s)
_again = _edit_check_context(_s)
_s.record_radio(_s.radio_instance(), ImageOrigin.FILE)
_after = _edit_check_context(_s)
json.dumps({"same": _first[0] is _again[0], "rebuilt": _after[0] is not _first[0]})
  `, { _sid: sessionId });
  assert.deepEqual(rebuilt, { same: true, rebuilt: true });
});

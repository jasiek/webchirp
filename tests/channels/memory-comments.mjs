import assert from "node:assert/strict";
import test from "node:test";

import { readImage, sharedHarness } from "../support/chirp.mjs";

// UV-5R comments live in CloneModeRadio's metadata trailer rather than its
// channel bytes. Exercise the same read, edit, clear, and erase operations a
// desktop-created image takes through the browser bridge.
const MEMORY_COMMENT_PROBE = `
import base64, json

ensure_radio_module("uv5r")
_clean = load_image_base64(_image_b64)
_module = _clean["module"]
_class_name = _clean["className"]
_target = int(_clean["rows"][0]["Location"])
_key = "%04i_comment" % _target
_radio_cls = _import_radio_class(_module, _class_name)

# Seed an image exactly as desktop CHIRP does when a driver has no native
# comment field: the channel stays in the memory map and its comment goes in
# the image metadata trailer.
_radio = _radio_from_image_bytes(_radio_cls, base64.b64decode(_image_b64))
_memory = _radio.get_memory(_target)
_memory.comment = "desktop comment"
_radio.set_memory_extra(_memory)
_seeded_image = _image_bytes_from_radio(_radio)
_seeded_b64 = base64.b64encode(_seeded_image).decode("ascii")

_loaded = load_image_base64(_seeded_b64)
_loaded_row = next(_row for _row in _loaded["rows"] if int(_row["Location"]) == _target)
_loaded_comment = _loaded_row["Comment"]
_column_metadata = get_radio_column_metadata(_loaded["sessionId"])

# Each export runs on the session its source image was loaded into, the way
# Export Binary runs on the session of the image the editor holds.
_loaded_row["Comment"] = "edited in webchirp"
_edited = export_image_base64(_loaded["sessionId"], _loaded["rows"], _loaded["settings"])
_edited_loaded = load_image_base64(_edited["imageBase64"])
_edited_row = next(_row for _row in _edited_loaded["rows"] if int(_row["Location"]) == _target)
_edited_comment = _edited_row["Comment"]
_, _edited_metadata = chirp_common.CloneModeRadio._strip_metadata(
    base64.b64decode(_edited["imageBase64"])
)

_edited_row["Comment"] = ""
_cleared = export_image_base64(
    _edited_loaded["sessionId"], _edited_loaded["rows"], _edited_loaded["settings"]
)
_cleared_loaded = load_image_base64(_cleared["imageBase64"])
_cleared_row = next(_row for _row in _cleared_loaded["rows"] if int(_row["Location"]) == _target)
_, _cleared_metadata = chirp_common.CloneModeRadio._strip_metadata(
    base64.b64decode(_cleared["imageBase64"])
)

# Reload the seeded state, then omit the row to exercise WebCHIRP's delete
# semantics and CHIRP's separate erase_memory_extra hook.
_erase_source = load_image_base64(_seeded_b64)
_remaining_rows = [
    _row for _row in _erase_source["rows"]
    if int(_row["Location"]) != _target
]
_erased = export_image_base64(
    _erase_source["sessionId"], _remaining_rows, _erase_source["settings"]
)
_erased_loaded = load_image_base64(_erased["imageBase64"])
_, _erased_metadata = chirp_common.CloneModeRadio._strip_metadata(
    base64.b64decode(_erased["imageBase64"])
)

json.dumps({
    "target": _target,
    "loadedComment": _loaded_comment,
    "commentEditable": _column_metadata["columns"]["Comment"]["editable"],
    "editedComment": _edited_comment,
    "editedMetadataComment": (_edited_metadata.get("mem_extra") or {}).get(_key),
    "clearedComment": _cleared_row["Comment"],
    "clearedMetadataHasKey": _key in (_cleared_metadata.get("mem_extra") or {}),
    "erasedRowPresent": any(
        int(_row["Location"]) == _target for _row in _erased_loaded["rows"]
    ),
    "erasedMetadataHasKey": _key in (_erased_metadata.get("mem_extra") or {}),
})
`;

test("clone-image metadata comments survive load, edit, clear, and erase", async () => {
  const harness = await sharedHarness();
  const raw = await readImage("Baofeng_UV-5R.img");
  const result = await harness.runPythonJson(MEMORY_COMMENT_PROBE, {
    _image_b64: raw.toString("base64"),
  });

  assert.equal(result.loadedComment, "desktop comment");
  assert.equal(result.commentEditable, true);
  assert.equal(result.editedComment, "edited in webchirp");
  assert.equal(result.editedMetadataComment, "edited in webchirp");
  assert.equal(result.clearedComment, "");
  assert.equal(result.clearedMetadataHasKey, false);
  assert.equal(result.erasedRowPresent, false);
  assert.equal(result.erasedMetadataHasKey, false);
});

// A channel a legacy image holds out of today's bands, with a desktop comment
// in the metadata trailer. The upload writes the memory together with that
// comment, so the preflight and the per-edit check must compare the row with
// it too (issue #344): left untouched the row is skipped, and clearing its
// Comment is a write the driver will refuse.
const OUT_OF_BAND_COMMENT_SEED = `
import base64, json

ensure_radio_module("uv5r")
_clean = load_image_base64(_image_b64)
_target = int(_clean["rows"][0]["Location"])
_radio = _radio_from_image_bytes(
    _import_radio_class(_clean["module"], _clean["className"]),
    base64.b64decode(_image_b64),
)
_memory = _radio.get_memory(_target)
_memory.freq = 600000000
_radio.set_memory(_memory)
_memory.comment = "desktop comment"
_radio.set_memory_extra(_memory)
json.dumps({
    "target": _target,
    "imageBase64": base64.b64encode(_image_bytes_from_radio(_radio)).decode("ascii"),
})
`;

test("a metadata comment counts when checking a row the driver would refuse", async () => {
  const harness = await sharedHarness();
  const raw = await readImage("Baofeng_UV-5R.img");
  const seed = await harness.runPythonJson(OUT_OF_BAND_COMMENT_SEED, {
    _image_b64: raw.toString("base64"),
  });
  const { sessionId, rows } = await harness.rpc("load_image_base64", { image_b64: seed.imageBase64 });
  const index = rows.findIndex((row) => Number(row.Location) === seed.target);
  const row = rows[index];
  assert.equal(row.Frequency, "600.000000");
  assert.equal(row.Comment, "desktop comment");

  const untouched = await harness.rpc("validate_rows_for_upload", { session_id: sessionId, rows });
  assert.deepEqual(untouched.issues, []);
  const untouchedEdit = await harness.rpc("normalize_and_validate_rows", {
    session_id: sessionId,
    rows: [{ row, edits: [] }],
  });
  assert.deepEqual(untouchedEdit.rows[0].issues, []);

  const cleared = rows.map((candidate, at) => (at === index ? { ...candidate, Comment: "" } : candidate));
  const clearedCheck = await harness.rpc("validate_rows_for_upload", { session_id: sessionId, rows: cleared });
  assert.equal(clearedCheck.valid, false);
  assert.ok(clearedCheck.issues.every((issue) => issue.rowIndex === index));
  const clearedEdit = await harness.rpc("normalize_and_validate_rows", {
    session_id: sessionId,
    rows: [{ row, edits: [{ column: "Comment", value: "" }] }],
  });
  assert.notDeepEqual(clearedEdit.rows[0].issues, []);
});

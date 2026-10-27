import assert from "node:assert/strict";
import test from "node:test";

import { readImage, sharedHarness } from "../support/chirp.mjs";

// Sentry WEBCHIRP-FRONTEND-2N: uploading to a Baofeng GM-15Pro with some of
// its fixed GMRS channels missing from the grid failed with "Field empty is
// not mutable on this memory". The driver lists "empty" as immutable on those
// slots, and the erase of an omitted channel set that field before the
// immutable policy was ever asked. CHIRP ships no GM-15Pro image, but the
// GM-15Pro class inherits the GM-30's memory layout and get_memory unchanged,
// so the GM-30 test image is that radio's codeplug.
const FIXTURE_IMAGE = "Radioddity_GM-30.img";
const MODULE = "radioddity_gm30";
const CLASS_NAME = "BaofengGM15Pro";

// Upload an empty channel list -- every channel omitted -- onto a copy of the
// image, then clear one undeletable channel's Frequency explicitly. Both go
// through the preflight the UI runs first and the write path behind it.
const PROBE = `
import base64, json

ensure_radio_module(_module)
_cls = _import_radio_class(_module, _class_name)
_session = open_radio_session(_module, _class_name)
_session.record_image(base64.b64decode(_image_b64), _cls, ImageOrigin.FILE)

_source = _session.radio_instance()
_rows, _, _ = _radio_rows_from_instance(_source)
_undeletable = []
_deletable = []
for _row in _rows:
    _number = int(_row["Location"])
    if "empty" in _source.get_memory(_number).immutable:
        _undeletable.append(_number)
    else:
        _deletable.append(_number)

_captured = []
_real_serial_log = jsbridge.serial_log
jsbridge.serial_log = lambda message: _captured.append(str(message))
try:
    _omitted_preflight = validate_rows_for_upload([], _session.session_id)
    _written = _session.radio_instance()
    try:
        _apply_rows_to_radio_instance(_written, [], _session)
        _omitted_error = ""
    except Exception as _exc:
        _omitted_error = f"{type(_exc).__name__}: {_exc}"
finally:
    jsbridge.serial_log = _real_serial_log
_kept = sorted(int(_r["Location"]) for _r in _radio_rows_from_instance(_written)[0])

_cleared = dict(next(_r for _r in _rows if int(_r["Location"]) == _undeletable[0]))
_cleared["Frequency"] = ""
_cleared_preflight = validate_rows_for_upload([_cleared], _session.session_id)
try:
    _apply_rows_to_radio_instance(_session.radio_instance(), [_cleared], _session)
    _cleared_error = ""
except Exception as _exc:
    _cleared_error = f"{type(_exc).__name__}: {_exc}"
close_session(_session.session_id)

json.dumps({
    "undeletable": _undeletable,
    "deletable": _deletable,
    "omittedPreflight": _omitted_preflight,
    "omittedError": _omitted_error,
    "kept": _kept,
    "log": "\\n".join(_captured),
    "clearedPreflight": _cleared_preflight,
    "clearedError": _cleared_error,
})
`;

test("an upload that omits a channel the driver will not erase keeps it", async (t) => {
  const harness = await sharedHarness();
  const raw = await readImage(FIXTURE_IMAGE);
  const result = await harness.runPythonJson(PROBE, {
    _image_b64: raw.toString("base64"),
    _module: MODULE,
    _class_name: CLASS_NAME,
  });

  // The fixture has to hold both kinds of channel, or the rest proves nothing.
  assert.ok(result.undeletable.length > 0, "fixture should hold a channel with immutable empty");
  assert.ok(result.deletable.length > 0, "fixture should hold an ordinary channel");

  await t.test("omitting it is neither a preflight finding nor an upload error", () => {
    assert.deepEqual(result.omittedPreflight.issues, []);
    assert.equal(result.omittedError, "");
  });

  await t.test("the undeletable channels stay and the ordinary ones are erased", () => {
    assert.deepEqual(result.kept, result.undeletable);
  });

  await t.test("the debug panel says which channels were kept and why", () => {
    assert.match(
      result.log,
      new RegExp(`Channels ${result.undeletable[0]}\\b.*were kept, because the driver does not allow erasing them`),
    );
    assert.match(result.log, /Field empty is not mutable on this memory/);
  });

  // Clearing the Frequency is an explicit erase, which desktop CHIRP refuses
  // for these channels too: preflight marks the cell and the write path, for a
  // caller that ran no preflight, refuses with the channel's number.
  await t.test("clearing its Frequency is refused in the cell and on write", () => {
    assert.equal(result.clearedPreflight.valid, false);
    assert.deepEqual(
      result.clearedPreflight.issues.map((issue) => [issue.rowIndex, issue.column]),
      [[0, "Frequency"]],
    );
    assert.match(result.clearedPreflight.issues[0].message, /Field empty is not mutable/);
    assert.match(
      result.clearedError,
      new RegExp(`^RuntimeUnsupportedError: Channel ${result.undeletable[0]}: Field empty is not mutable`),
    );
  });
});

// The grid refuses to delete those channels up front, as desktop CHIRP does,
// rather than let the upload keep them without a word. It learns which ones
// from the Location column's metadata, filled from the image's rows when it is
// read; a cleared Frequency on one is refused by the per-edit check.
const METADATA_PROBE = `
import base64, json

ensure_radio_module(_module)
_cls = _import_radio_class(_module, _class_name)
_blank = open_radio_session(_module, _class_name)
_blank_location = get_radio_column_metadata(_blank.session_id)["columns"]["Location"]
close_session(_blank.session_id)

_session = open_radio_session(_module, _class_name)
_session.record_image(base64.b64decode(_image_b64), _cls, ImageOrigin.FILE)
_payload = _read_radio_payload(_session, _session.radio_instance(), ImageOrigin.FILE)
_location = get_radio_column_metadata(_session.session_id)["columns"]["Location"]
_rows = {int(_r["Location"]): _r for _r in _payload["rows"]}
_ordinary = min(_n for _n in _rows if _n not in _location.get("undeletable", []))

def _clear_frequency(_number):
    return normalize_and_validate_rows(_session.session_id, [
        {"row": _rows[_number], "edits": [{"column": "Frequency", "value": ""}]},
    ])["rows"][0]

_result = {
    "blankLocation": _blank_location,
    "location": _location,
    "described": _session.describe()["undeletableChannels"],
    "fixedFrequency": _rows[1]["Frequency"],
    "clearedFixed": _clear_frequency(1),
    "ordinary": _ordinary,
    "clearedOrdinary": _clear_frequency(_ordinary),
}
close_session(_session.session_id)
json.dumps(_result)
`;

test("the GM-15Pro's fixed channels 1-54 reach the grid as undeletable", async (t) => {
  const harness = await sharedHarness();
  const raw = await readImage(FIXTURE_IMAGE);
  const result = await harness.runPythonJson(METADATA_PROBE, {
    _image_b64: raw.toString("base64"),
    _module: MODULE,
    _class_name: CLASS_NAME,
  });
  const fixedChannels = Array.from({ length: 54 }, (_, index) => index + 1);

  await t.test("the Location column lists them once the image is read", () => {
    assert.deepEqual(result.location.undeletable, fixedChannels);
    assert.deepEqual(result.described, fixedChannels);
    assert.ok(result.ordinary > 54, "the fixture should hold an ordinary channel too");
  });

  // A fact about the codeplug read, not the driver: with no image there are
  // no channels yet, so nothing to refuse.
  await t.test("a session with no image lists none", () => {
    assert.equal("undeletable" in result.blankLocation, false);
  });

  await t.test("clearing a fixed channel's Frequency keeps it, with a note", () => {
    assert.deepEqual(result.clearedFixed.cells, [{
      column: "Frequency",
      value: result.fixedFrequency,
      accepted: false,
      note: "Channel 1 cannot be deleted on this radio; kept the previous value",
    }]);
    assert.deepEqual(result.clearedFixed.issues, []);
  });

  await t.test("clearing an ordinary channel's Frequency still erases it", () => {
    assert.deepEqual(result.clearedOrdinary.cells, [
      { column: "Frequency", value: "", accepted: true, note: "" },
    ]);
  });
});

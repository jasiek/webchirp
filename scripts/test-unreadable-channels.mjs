import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { undecodedChannelsNote } from "../web/js/ui/format.js";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// A memory the driver cannot decode used to disappear from the grid with
// nothing in the debug panel, and the upload path read that absence as "the
// user deleted this channel" and erased the slot on the radio. Both halves are
// pinned here: the download reports the failure, and the upload leaves an
// undecodable slot alone.
const FIXTURE_IMAGE = "Baofeng_UV-5R.img";

// Drives the real runtime against a real driver and image, with get_memory
// forced to fail on one channel the way a corrupt memory would. erase_memory is
// wrapped rather than stubbed so the assertion covers what the driver was
// actually asked to do.
const PROBE = `
import base64, json, os, tempfile

# Drivers load lazily, so the image cannot be detected until this is imported.
ensure_radio_module("uv5r")

_raw = base64.b64decode(_image_b64)
with tempfile.NamedTemporaryFile(mode="wb", suffix=".img", delete=False) as _f:
    _path = _f.name
    _f.write(_raw)
try:
    _radio = directory.get_radio_by_image(_path)
finally:
    try:
        os.unlink(_path)
    except Exception:
        pass

_clean_rows, _clean_unreadable = _radio_rows_from_instance(_radio)
_target = int(_clean_rows[0]["Location"])

_real_get_memory = _radio.get_memory
def _failing_get_memory(number, *args, **kwargs):
    if int(number) == _target:
        raise ValueError("simulated decode failure")
    return _real_get_memory(number, *args, **kwargs)
_radio.get_memory = _failing_get_memory

_erased = []
_real_erase_memory = _radio.erase_memory
def _recording_erase_memory(number, *args, **kwargs):
    _erased.append(int(number))
    return _real_erase_memory(number, *args, **kwargs)
_radio.erase_memory = _recording_erase_memory

_captured = []
_real_serial_log = serial_log
serial_log = lambda message: _captured.append(str(message))
try:
    _rows, _unreadable = _radio_rows_from_instance(_radio)
    _apply_rows_to_radio_instance(_radio, _rows)
finally:
    serial_log = _real_serial_log

json.dumps({
    "target": _target,
    "cleanRowCount": len(_clean_rows),
    "cleanUnreadable": _clean_unreadable,
    "rowCount": len(_rows),
    "rowLocations": [int(r["Location"]) for r in _rows],
    "unreadable": _unreadable,
    "erased": _erased,
    "log": "\\n".join(_captured),
})
`;

test("an undecodable memory is reported on download and never erased on upload", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const raw = await fs.readFile(path.join(imagesDir, FIXTURE_IMAGE));
  const result = await harness.runPythonJson(PROBE, {
    _image_b64: raw.toString("base64"),
  });

  // The fixture has to decode cleanly, or the rest proves nothing.
  assert.deepEqual(result.cleanUnreadable, [], "fixture image should decode without failures");
  assert.ok(result.cleanRowCount > 0, "fixture image should yield channels");

  // Download: the row is still dropped, but it is now accounted for.
  assert.equal(result.rowCount, result.cleanRowCount - 1, "the failing channel should be dropped");
  assert.ok(
    !result.rowLocations.includes(result.target),
    "the failing channel should not appear as a row",
  );
  assert.deepEqual(result.unreadable, [result.target], "the failing channel should be marked");

  // The debug panel gets the traceback, not just a count.
  assert.match(result.log, /could not be decoded by the driver/);
  assert.match(result.log, new RegExp(`Channels ${result.target}\\b`));
  assert.match(result.log, /simulated decode failure/);
  assert.match(result.log, /Traceback \(most recent call last\)/);

  // Upload: the slot missing from the rows must not be erased.
  assert.ok(
    !result.erased.includes(result.target),
    `channel ${result.target} was erased despite being unreadable`,
  );
  assert.match(result.log, /were not erased because their current values could not be checked/);
});

test("the status note stays silent unless channels were dropped", () => {
  assert.equal(undecodedChannelsNote([]), "");
  assert.equal(undecodedChannelsNote(undefined), "");
  assert.match(undecodedChannelsNote([7]), /1 channel could not be decoded/);
  assert.match(undecodedChannelsNote([7, 8]), /2 channels could not be decoded/);
});

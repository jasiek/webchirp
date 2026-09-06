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
// user deleted this channel" and erased the slot on the radio.
const FIXTURE_IMAGE = "Baofeng_UV-5R.img";

// The decode failure is injected on the driver *class* and lifted again before
// the export, so every radio built afterwards reads the slot without error.
// That is the case a read-before-erase guard cannot catch: export reconstructs
// a fresh radio from the cached image, the re-read succeeds, and the slot is
// erased for being absent from the rows. Protection has to come from what the
// extraction recorded, not from the failure happening to repeat.
const TRANSIENT_FAILURE_PROBE = `
import base64, json

ensure_radio_module("uv5r")

_clean = load_image_base64(_image_b64)
_module = _clean["module"]
_class_name = _clean["className"]
_target = int(_clean["rows"][0]["Location"])
_clean_freq = str(_clean["rows"][0].get("Frequency", ""))

_cls = _import_radio_class(_module, _class_name)
_real_get_memory = _cls.get_memory
def _failing_get_memory(self, number, *args, **kwargs):
    if int(number) == _target:
        raise ValueError("simulated decode failure")
    return _real_get_memory(self, number, *args, **kwargs)

_captured = []
_real_serial_log = serial_log
serial_log = lambda message: _captured.append(str(message))
try:
    _cls.get_memory = _failing_get_memory
    try:
        _loaded = load_image_base64(_image_b64)
    finally:
        _cls.get_memory = _real_get_memory
    _exported = export_image_base64(_module, _class_name, _loaded["rows"], [])
finally:
    serial_log = _real_serial_log

# Re-read the exported image with a clean driver: the protected slot has to
# still be there, carrying the value it had before the failure.
_after = load_image_base64(_exported["imageBase64"])
_after_row = next(
    (_r for _r in _after["rows"] if int(_r["Location"]) == _target),
    None,
)

json.dumps({
    "target": _target,
    "cleanRowCount": len(_clean["rows"]),
    "cleanUnreadable": _clean["unreadableChannels"],
    "cleanFrequency": _clean_freq,
    "loadedRowCount": len(_loaded["rows"]),
    "loadedUnreadable": _loaded["unreadableChannels"],
    "survivedFrequency": None if _after_row is None else str(_after_row.get("Frequency", "")),
    "afterRowCount": len(_after["rows"]),
    "log": "\\n".join(_captured),
})
`;

// Every slot fails with a message naming its own number, so the driver's
// exception text -- the grouping key -- is unique per channel. Grouping alone
// would then emit one full traceback per memory.
const UNIQUE_MESSAGES_PROBE = `
import base64, json

ensure_radio_module("uv5r")

_clean = load_image_base64(_image_b64)
_module = _clean["module"]
_class_name = _clean["className"]

_cls = _import_radio_class(_module, _class_name)
_real_get_memory = _cls.get_memory
def _always_failing_get_memory(self, number, *args, **kwargs):
    raise ValueError("corrupt memory at slot " + str(int(number)))

_captured = []
_real_serial_log = serial_log
serial_log = lambda message: _captured.append(str(message))
try:
    _cls.get_memory = _always_failing_get_memory
    try:
        _loaded = load_image_base64(_image_b64)
    finally:
        _cls.get_memory = _real_get_memory
finally:
    serial_log = _real_serial_log

json.dumps({
    "maxGroups": MAX_LOGGED_FAILURE_GROUPS,
    "rowCount": len(_loaded["rows"]),
    "unreadableCount": len(_loaded["unreadableChannels"]),
    "logLines": _captured,
})
`;

test("a channel that failed to decode survives export even when the failure does not repeat", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const raw = await fs.readFile(path.join(imagesDir, FIXTURE_IMAGE));
  const result = await harness.runPythonJson(TRANSIENT_FAILURE_PROBE, {
    _image_b64: raw.toString("base64"),
  });

  // The fixture has to decode cleanly, or the rest proves nothing.
  assert.deepEqual(result.cleanUnreadable, [], "fixture image should decode without failures");
  assert.ok(result.cleanRowCount > 0, "fixture image should yield channels");
  assert.ok(result.cleanFrequency, "target channel should have a frequency to compare");

  // Extraction: the row is still dropped, but it is now accounted for.
  assert.equal(
    result.loadedRowCount,
    result.cleanRowCount - 1,
    "the failing channel should be dropped from the rows",
  );
  assert.deepEqual(
    result.loadedUnreadable,
    [result.target],
    "the failing channel should be reported as unreadable",
  );

  // The debug panel gets the traceback, not just a count.
  assert.match(result.log, /could not be decoded by the driver/);
  assert.match(result.log, new RegExp(`Channels ${result.target}\\b`));
  assert.match(result.log, /simulated decode failure/);
  assert.match(result.log, /Traceback \(most recent call last\)/);

  // Export: the slot is missing from the rows and reads back fine on the fresh
  // instance, so only the recorded set can keep it from being erased.
  assert.match(result.log, /were left untouched because the driver could not decode them/);
  assert.equal(
    result.survivedFrequency,
    result.cleanFrequency,
    `channel ${result.target} did not survive the export intact`,
  );
  assert.equal(result.afterRowCount, result.cleanRowCount, "no channel should have been lost");
});

test("unique per-channel failure messages cannot flood the debug panel", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const raw = await fs.readFile(path.join(imagesDir, FIXTURE_IMAGE));
  const result = await harness.runPythonJson(UNIQUE_MESSAGES_PROBE, {
    _image_b64: raw.toString("base64"),
  });

  assert.equal(result.rowCount, 0, "every channel should have failed to decode");
  assert.ok(
    result.unreadableCount > result.maxGroups,
    "the fixture must fail on more channels than the group cap, or the cap is untested",
  );

  // Each distinct message would otherwise carry its own full traceback.
  const traces = result.logLines.filter((line) => line.includes("Traceback (most recent call last)"));
  assert.ok(
    traces.length <= result.maxGroups,
    `expected at most ${result.maxGroups} tracebacks, got ${traces.length}`,
  );

  // The channels that were not named individually still have to be accounted for.
  const remainder = result.logLines.filter((line) => line.includes("further distinct failures"));
  assert.equal(remainder.length, 1, "the truncated groups should be summarised exactly once");
});

test("the status note stays silent unless channels were dropped", () => {
  assert.equal(undecodedChannelsNote([]), "");
  assert.equal(undecodedChannelsNote(undefined), "");
  assert.match(undecodedChannelsNote([7]), /1 channel could not be decoded/);
  assert.match(undecodedChannelsNote([7, 8]), /2 channels could not be decoded/);
});

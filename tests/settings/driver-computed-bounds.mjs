import assert from "node:assert/strict";
import test from "node:test";

import { sharedHarness } from "../support/chirp.mjs";
import { withCapturedDebugLog } from "../support/debug-log-capture.mjs";

// A driver may replace a setting value's get_min/get_max with a bound computed
// from a sibling value, and such a getter can raise. Serializing that bound
// used to raise out of the whole settings tree, and with it out of every load,
// download and export of the radio. The known case is repaired by its
// workaround before serialization (tests/channels/smartbeacon-low-speed-bound.mjs);
// this file holds the serializer to the generic fallback for the next one,
// with getters that raise on purpose rather than any driver's.

test("a bound getter that raises falls back to the bound the value declared", async () => {
  const harness = await sharedHarness();
  const { result, log } = await withCapturedDebugLog(harness, async () =>
    harness.runPythonJson(`
from chirp import settings as _cs

def _raises():
    raise TypeError("sibling never initialized")

# A value initializes when its RadioSetting is built, as in any driver.
_integer = _cs.RadioSettingValueInteger(2, 30, 5)
_integer.get_max = _raises
_float = _cs.RadioSettingValueFloat(0.5, 9.5, 1.0)
_float.get_min = _raises
_settings = [
    _cs.RadioSetting("probe.integer", "Integer", _integer),
    _cs.RadioSetting("probe.float", "Float", _float),
]

json.dumps({
    "integer": _serialize_setting_node(_settings[0], [])["values"][0],
    "float": _serialize_setting_node(_settings[1], [])["values"][0],
})
`),
  );

  assert.equal(result.integer.max, 30, "the integer keeps its declared maximum");
  assert.equal(result.integer.min, 2, "a getter that works is still read");
  assert.equal(result.integer.current, 5);
  assert.equal(result.float.min, 0.5, "the float keeps its declared minimum");
  assert.equal(result.float.max, 9.5);

  const integerLine = log.find((line) => line.includes("probe.integer"));
  assert.ok(integerLine, "the failure is reported in the debug panel");
  assert.match(integerLine, /get_max\(\)/);
  assert.match(integerLine, /sibling never initialized/, "with the driver's traceback");
  assert.ok(log.some((line) => line.includes("probe.float") && line.includes("get_min()")));
});

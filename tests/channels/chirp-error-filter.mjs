// Which CHIRP failures are bug reports and which are descriptions of the user's
// own file, radio or cable.
//
// IGNORE_ERRORS in web/js/sentry.js drops the second kind, named class by
// class. That list is the whole of the boundary and it is invisible from both
// sides: CHIRP does not know it exists, and in Sentry a rule that quietly stops
// matching looks exactly like a failure that stopped happening. So the tests
// here pin both directions -- what is dropped and what must still get through
// -- and check the names against chirp/chirp/errors.py, because a rename
// upstream is what would break the rule without breaking anything else.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { initOptions } from "../../web/js/sentry.js";
import { repoRoot } from "../support/repo-paths.mjs";

// One Python traceback ending on the given exception, in the shape Pyodide
// hands to the JS side: its own frames on top, the exception on the last line.
function traceback(qualifiedName, message) {
  return [
    "PythonError: Traceback (most recent call last):",
    '  File "/lib/python312.zip/_pyodide/_base.py", line 597, in eval_code_async',
    "    await CodeRunner(",
    '  File "/webchirp_runtime/webchirp_bridge/channel_rows.py", line 104, in parse_csv',
    "    radio.load_from(csv_text)",
    `${qualifiedName}: ${message}`,
  ].join("\n");
}

function isIgnored(message) {
  return initOptions().ignoreErrors.some((pattern) => pattern.test(message));
}

// The user's file, the user's radio, the user's cable. None of these is a
// defect in this app, and every one of them arrives often enough to bury the
// ones that are.
const DROPPED = [
  ["chirp.errors.InvalidDataError", "No channels found"],
  ["chirp.errors.InvalidValueError", "Tuning step 6.25 not supported"],
  ["chirp.errors.UnsupportedToneError", "Tone 165.5 not supported"],
  ["chirp.errors.ImageDetectFailed", "Unable to detect radio model"],
  ["chirp.errors.ImageMetadataInvalidModel", "Unsupported model in metadata"],
  ["chirp.errors.RadioNoResponse", "No response from radio"],
  ["chirp.errors.RadioNoContactLikelyK1", "Check connector and cabling!"],
  ["chirp.errors.RadioFixedBanks", "This radio has fixed banks"],
];

// Three that stay reportable, and why each one is a defect rather than a
// circumstance: the first two can only be reached by this app asking CHIRP for
// something impossible, and RadioError is the drivers' catch-all -- the place a
// short read from the Web Serial stand-in would surface, which is the one
// failure mode upstream CHIRP has never had to handle.
const REPORTED = [
  ["chirp.errors.InvalidMemoryLocation", "Location 129 does not exist"],
  ["chirp.errors.FrozenMemoryError", "Frozen memory is immutable"],
  ["chirp.errors.RadioError", "Radio did not respond"],
];

test("a CSV the user's spreadsheet exported wrong is not a bug report", () => {
  assert.ok(isIgnored(traceback("chirp.errors.InvalidDataError", "No channels found")));
});

test("every circumstance-shaped CHIRP failure is dropped", () => {
  for (const [name, message] of DROPPED) {
    assert.ok(isIgnored(traceback(name, message)), `${name} should be dropped`);
  }
});

test("the CHIRP failures that mean this app asked for something impossible are kept", () => {
  for (const [name, message] of REPORTED) {
    assert.equal(isIgnored(traceback(name, message)), false, `${name} should be reported`);
  }
});

test("this app's own errors are clear of the rule despite subclassing RadioError", () => {
  // web/python/webchirp_bridge/runtime_errors.py derives from errors.RadioError,
  // but Pyodide names a flattened exception after the module that defines it --
  // which is what a module-qualified filter has to rely on.
  const detection = traceback(
    "webchirp_bridge.runtime_errors.ImageDetectionError",
    "No driver claims this image",
  );
  assert.equal(isIgnored(detection), false);
  // The one exception, dropped by its own rule rather than this one.
  assert.ok(isIgnored(traceback(
    "webchirp_bridge.runtime_errors.RuntimePreconditionError",
    "Download from radio first, then upload.",
  )));
});

test("every class the rule names still exists in CHIRP", () => {
  const source = fs.readFileSync(path.join(repoRoot, "chirp", "chirp", "errors.py"), "utf8");
  const defined = new Set([...source.matchAll(/^class\s+(\w+)/gm)].map((match) => match[1]));
  assert.ok(defined.size > 0, "chirp/chirp/errors.py should define classes");
  for (const [name] of [...DROPPED, ...REPORTED]) {
    assert.ok(defined.has(name.split(".").pop()), `${name} is no longer defined by CHIRP`);
  }
});

test("a filtered class is still redacted and still reaches the debug panel path", () => {
  // The rule drops the event, not the diagnostics: scrubbing and the debug
  // panel are unaffected, so a user reporting a bad CSV by hand still has the
  // whole traceback to paste.
  const options = initOptions();
  const event = options.beforeSend({
    exception: { values: [{ type: "Error", value: traceback("chirp.errors.InvalidDataError", "Frequency 145.500000 rejected") }] },
  });
  assert.match(event.exception.values[0].value, /InvalidDataError/);
  assert.doesNotMatch(event.exception.values[0].value, /145\.500000/);
});

// Which CHIRP failures are bug reports and which are descriptions of the user's
// own file, radio or cable.
//
// isIgnoredError in web/js/sentry.js drops the second kind, named class by
// class (IGNORED_CHIRP_ERRORS). That list is the whole of the boundary and it
// is invisible from both sides: CHIRP does not know it exists, and in Sentry a
// rule that quietly stops matching looks exactly like a failure that stopped
// happening. So the tests here pin both directions -- what is dropped and what
// must still get through -- and check the names against chirp/chirp/errors.py,
// because a rename upstream is what would break the rule without breaking
// anything else.
//
// Each failure is the RuntimeCallError the dispatcher throws, and the rule is
// checked where Sentry applies it: beforeSend, handed the error as the hint's
// originalException.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { IGNORED_CHIRP_ERRORS, initOptions } from "../../web/js/sentry.js";
import { repoRoot } from "../support/repo-paths.mjs";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";

// The event Sentry would build for a runtime failure: its type is the error's
// name, its value the one-line message.
function eventFor(error) {
  return { exception: { values: [{ type: error.name, value: error.message }] } };
}

// Whether beforeSend drops this failure's event.
function isIgnored(error) {
  return initOptions().beforeSend(eventFor(error), { originalException: error }) === null;
}

// A chirp.errors failure, as "chirp.errors.InvalidDataError" names it.
function chirpError(qualifiedName, message) {
  const type = qualifiedName.split(".").pop();
  return runtimeCallError(type, message, { module: "chirp.errors" }, "parse_csv");
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
  assert.ok(isIgnored(chirpError("chirp.errors.InvalidDataError", "No channels found")));
});

test("every circumstance-shaped CHIRP failure is dropped", () => {
  for (const [name, message] of DROPPED) {
    assert.ok(isIgnored(chirpError(name, message)), `${name} should be dropped`);
  }
});

test("the CHIRP failures that mean this app asked for something impossible are kept", () => {
  for (const [name, message] of REPORTED) {
    assert.equal(isIgnored(chirpError(name, message)), false, `${name} should be reported`);
  }
});

test("this app's own errors are clear of the rule despite subclassing RadioError", () => {
  // web/python/webchirp_bridge/runtime_errors.py derives from errors.RadioError,
  // and the envelope lists RadioError among the bases -- so the rule has to be
  // exact on class and defining module, which is what keeps these reported.
  const detection = runtimeCallError("ImageDetectionError", "No driver claims this image");
  assert.ok(detection.pythonBases.includes("RadioError"));
  assert.equal(isIgnored(detection), false);
  assert.equal(isIgnored(runtimeCallError("RuntimeUnsupportedError", "Not a clone-mode radio")), false);
  // A class the list names, but defined somewhere other than chirp.errors, is
  // not the class the list means.
  assert.equal(
    isIgnored(runtimeCallError("InvalidDataError", "No channels found", { module: "webchirp_bridge.x" })),
    false,
  );
  // The one exception, dropped by its own rule rather than this one.
  assert.ok(isIgnored(runtimeCallError(
    "RuntimePreconditionError",
    "Download from radio first, then upload.",
  )));
});

test("a native JS error is never dropped by the runtime rule", () => {
  // Only a RuntimeCallError carries a Python type; a JS error whose text
  // happens to name a CHIRP class is an ordinary failure.
  const error = new Error("chirp.errors.InvalidDataError: No channels found");
  assert.equal(isIgnored(error), false);
});

test("every class the rule names still exists in CHIRP", () => {
  const source = fs.readFileSync(path.join(repoRoot, "chirp", "chirp", "errors.py"), "utf8");
  const defined = new Set([...source.matchAll(/^class\s+(\w+)/gm)].map((match) => match[1]));
  assert.ok(defined.size > 0, "chirp/chirp/errors.py should define classes");
  for (const [name] of [...DROPPED, ...REPORTED]) {
    assert.ok(defined.has(name.split(".").pop()), `${name} is no longer defined by CHIRP`);
  }
  // And the list the rule reads is exactly the dropped set above, so a class
  // added to it without a test here fails.
  assert.deepEqual(
    [...IGNORED_CHIRP_ERRORS].sort(),
    DROPPED.map(([name]) => name.split(".").pop()).sort(),
  );
});

test("a reported runtime failure is redacted, traceback and all", () => {
  // The traceback no longer rides in the exception value; it travels as the
  // event's python context, and is scrubbed like every other free-form string.
  const error = chirpError("chirp.errors.InvalidMemoryLocation", "Frequency 145.500000 rejected");
  const event = initOptions().beforeSend(eventFor(error), { originalException: error });
  assert.equal(event.exception.values[0].type, "InvalidMemoryLocation");
  assert.doesNotMatch(event.exception.values[0].value, /145\.500000/);
  const python = event.contexts.python;
  assert.equal(python.type, "InvalidMemoryLocation");
  assert.equal(python.module, "chirp.errors");
  assert.match(python.traceback, /chirp\.errors\.InvalidMemoryLocation: Frequency \[num\] rejected/);
  assert.doesNotMatch(python.traceback, /145\.500000/);
  // The frame paths survive the quoted-value rule: they are the useful part.
  assert.match(python.traceback, /"\/webchirp_runtime\/webchirp_bridge\/clone\.py"/);
});

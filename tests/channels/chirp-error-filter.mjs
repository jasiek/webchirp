// Which CHIRP failures are bug reports and which are descriptions of the user's
// own file, radio or cable.
//
// isIgnoredError in web/js/sentry.ts drops the second kind, named class by
// class (IGNORED_CHIRP_ERRORS), plus the drivers' own complaints about the
// radio during a clone (isDriverCloneFailure). Those are the boundary and it
// is invisible from both sides: CHIRP does not know it exists, and in Sentry a
// rule that quietly stops matching looks exactly like a failure that stopped
// happening. So the tests here pin both directions -- what is dropped and what
// must still get through -- and check the names against the CHIRP module that
// defines each (chirp/chirp/errors.py, chirp/chirp/settings.py), because a
// rename upstream is what would break the rule without breaking anything else.
//
// Each failure is the RuntimeCallError the dispatcher throws, and the rule is
// checked where Sentry applies it: beforeSend, handed the error as the hint's
// originalException.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { IGNORED_CHIRP_ERRORS, initOptions } from "../../web/js/sentry.ts";
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

// The class and defining module a qualified name such as
// "chirp.settings.InvalidValueError" spells.
function splitQualifiedName(qualifiedName) {
  const dot = qualifiedName.lastIndexOf(".");
  return { module: qualifiedName.slice(0, dot), type: qualifiedName.slice(dot + 1) };
}

// A CHIRP failure, as "chirp.errors.InvalidDataError" names it.
function chirpError(qualifiedName, message) {
  const { module, type } = splitQualifiedName(qualifiedName);
  return runtimeCallError(type, message, { module }, "parse_csv");
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
  // chirp/chirp/settings.py's own InvalidValueError, which 18 drivers import
  // in place of the chirp.errors one: the KG-UV9GX refusing a frequency outside
  // its bands (WEBCHIRP-FRONTEND-2D, -2E).
  ["chirp.settings.InvalidValueError", "Frequency 520.000000 is not with in 400.000000-480.000000"],
];

// The ones that stay reportable, and why each one is a defect rather than a
// circumstance: the first two can only be reached by this app asking CHIRP for
// something impossible, RadioError is the drivers' catch-all -- dropped only
// where a driver's clone protocol raised it (the clone tests below), and these
// are not clones -- and chirp.settings' other two classes are a driver
// building a settings tree CHIRP rejects.
const REPORTED = [
  ["chirp.errors.InvalidMemoryLocation", "Location 129 does not exist"],
  ["chirp.errors.FrozenMemoryError", "Frozen memory is immutable"],
  ["chirp.errors.RadioError", "Radio did not respond"],
  ["chirp.settings.InternalError", "Setting abc is not a scalar"],
  ["chirp.settings.InvalidNameError", "Name must not contain '%' character"],
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
  // A class the list names, but defined somewhere other than a module the list
  // names it under, is not the class the list means.
  assert.equal(
    isIgnored(runtimeCallError("InvalidDataError", "No channels found", { module: "webchirp_bridge.x" })),
    false,
  );
  assert.equal(
    isIgnored(runtimeCallError("InvalidValueError", "Value 9 not in range 0-7", { module: "webchirp_bridge.x" })),
    false,
  );
  // chirp.settings is named for InvalidValueError alone, not for every class a
  // chirp.errors entry lists.
  assert.equal(
    isIgnored(runtimeCallError("InvalidDataError", "No channels found", { module: "chirp.settings" })),
    false,
  );
  // The module name is the Python side's text, never a key into Object's own
  // properties.
  assert.equal(isIgnored(runtimeCallError("toString", "x", { module: "constructor" })), false);
  // The one exception, dropped by its own rule rather than this one.
  assert.ok(isIgnored(runtimeCallError(
    "RuntimePreconditionError",
    "Download from radio first, then upload.",
  )));
});

test("a wrapper is judged by the CHIRP class it was raised from", () => {
  // load_image_base64 re-raises ImageDetectFailed as ImageDetectionError, which
  // the all-drivers retry needs by that name. "Unknown file format" is the
  // user's file, whatever the wrapper is called (WEBCHIRP-FRONTEND-1G).
  const notAnImage = runtimeCallError(
    "ImageDetectionError",
    "Unable to detect radio from image: Unknown file format",
    { causes: [{ type: "ImageDetectFailed", module: "chirp.errors", message: "Unknown file format", explicit: true }] },
    "load_image_base64",
  );
  assert.ok(isIgnored(notAnImage));

  // The settings module's InvalidValueError counts as a cause just as the
  // errors one does: a value the driver refused, re-raised by whatever wrapped
  // the driver call.
  const refusedFromSettings = runtimeCallError(
    "RuntimeUnsupportedError",
    "Channel row 3: Frequency 520.000000 is not with in 400.000000-480.000000",
    { causes: [{ type: "InvalidValueError", module: "chirp.settings", message: "Frequency 520.000000 is not with in 400.000000-480.000000", explicit: true }] },
  );
  assert.ok(isIgnored(refusedFromSettings));

  // A driver that broke while matching the image is a defect, wrapped or not.
  const driverBroke = runtimeCallError(
    "ImageDetectionError",
    "Unable to detect radio from image: 'NoneType' object is not subscriptable",
    { causes: [{ type: "TypeError", module: "builtins", message: "'NoneType' object is not subscriptable", explicit: true }] },
    "load_image_base64",
  );
  assert.equal(isIgnored(driverBroke), false);

  // The cause is held to the same exact class-and-module rule as the failure.
  const lookalike = runtimeCallError("RadioError", "Failed to read block", {
    causes: [{ type: "RadioNoResponse", module: "webchirp_bridge.x", message: "No response", explicit: true }],
  });
  assert.equal(isIgnored(lookalike), false);
  const settingsLookalike = runtimeCallError("RuntimeUnsupportedError", "Settings could not be built", {
    causes: [{ type: "InternalError", module: "chirp.settings", message: "Setting abc is not a scalar", explicit: true }],
  });
  assert.equal(isIgnored(settingsLookalike), false);

  // Only the nearest cause counts: what it was itself raised from was the
  // wrapper's author's to judge.
  const deeper = runtimeCallError("RadioError", "Failed to read block", {
    causes: [
      { type: "ValueError", module: "builtins", message: "bad length", explicit: true },
      { type: "RadioNoResponse", module: "chirp.errors", message: "No response", explicit: true },
    ],
  });
  assert.equal(isIgnored(deeper), false);

  // Raised while handling an ignored failure is not raised from it: ga510 reads
  // the port inside its RadioNoResponse handler, and a serial failure there is
  // a defect of its own, which Python chains only as __context__.
  const whileHandling = runtimeCallError("JsException", "NetworkError: The device has been lost.", {
    causes: [{ type: "RadioNoResponse", module: "chirp.errors", message: "No response", explicit: false }],
  }, "download_selected_radio");
  assert.equal(isIgnored(whileHandling), false);
  const whileHandlingSettings = runtimeCallError("TypeError", "'NoneType' object is not subscriptable", {
    causes: [{ type: "InvalidValueError", module: "chirp.settings", message: "Value 9 not in range 0-7", explicit: false }],
  });
  assert.equal(isIgnored(whileHandlingSettings), false);
});

// A failure a driver raised in the middle of a clone, as the envelope names
// it: the class by its qualified name, the driver module and function that
// raised it, what it was chained from, and the RPC method that ran the clone.
function driverCloneError(qualifiedName, message, {
  origin = "chirp.drivers.uvk5",
  fn = "do_download",
  causes = [],
  method = "download_selected_radio",
} = {}) {
  const { module, type } = splitQualifiedName(qualifiedName);
  return runtimeCallError(type, message, { module, causes, origin: { module: origin, function: fn } }, method);
}

// One link of a Python exception chain, named the way _python_causes
// (web/python/webchirp_bridge/rpc.py) sends it. Drivers re-raise inside an
// except block far more often than with "from", so implicit is the default.
function cause(qualifiedName, message, explicit = false) {
  const { module, type } = splitQualifiedName(qualifiedName);
  return { type, module, message, explicit };
}

test("a driver's clone protocol giving up on the radio is not a bug report", () => {
  // The events of 2026-10-16/17, one per shape: a firmware the driver does not
  // know (WEBCHIRP-FRONTEND-1V), an unacknowledged block raised as a bare
  // Exception (-2P), a block that came back one byte short, re-raised as a
  // RadioError (-2B), a refused handshake wrapped twice (-2H), and a write the
  // radio did not acknowledge (-2R).
  const dropped = [
    driverCloneError("chirp.errors.RadioError", "Firmware version is not supported by this driver"),
    driverCloneError("builtins.Exception", "No ACK reading block 00d8.", {
      origin: "chirp.drivers.h777", fn: "_h777_read_block",
    }),
    driverCloneError("chirp.errors.RadioError", "Failed to communicate with radio: Failed to read full block (67!=68)", {
      origin: "chirp.drivers.wouxun", fn: "_download",
      causes: [cause("builtins.Exception", "Failed to read full block (67!=68)")],
    }),
    driverCloneError("chirp.errors.RadioError", "Error during download Enter programming failed Resp : b'-'", {
      origin: "chirp.drivers.radioddity_gm30",
      causes: [cause("chirp.errors.RadioError", "Enter programming failed Resp : b'-'")],
    }),
    driverCloneError("chirp.errors.RadioError", "Failed to send block to radio at 03a0", {
      origin: "chirp.drivers.h777", fn: "_h777_write_block", method: "upload_selected_radio",
      causes: [cause("builtins.Exception", "No ACK")],
    }),
    // A silent radio a driver re-raised in its own words is still a silent
    // radio, which the class list already drops.
    driverCloneError("chirp.errors.RadioError", "Failed to read block", {
      causes: [cause("chirp.errors.RadioNoResponse", "No response from radio")],
    }),
  ];
  for (const error of dropped) {
    assert.ok(isIgnored(error), `${error.name}: ${error.message} should be dropped`);
  }
});

test("a driver's complaint outside a clone, or not a driver's, is still reported", () => {
  const firmware = "Firmware version is not supported by this driver";
  // The same class from the same driver, but not while it ran a clone: opening
  // an image is the user's file meeting the driver's parser.
  assert.equal(isIgnored(driverCloneError("chirp.errors.RadioError", firmware, { method: "load_image_base64" })), false);
  // A RadioError during a clone that no driver raised: the serial stand-in
  // and CHIRP's shared code are this app's and CHIRP's to answer for.
  for (const origin of ["webchirp_bridge.serial_pipe", "chirp.chirp_common", "chirp.driversx", ""]) {
    assert.equal(
      isIgnored(driverCloneError("chirp.errors.RadioError", "Short read", { origin })),
      false,
      `a RadioError raised from "${origin}" should be reported`,
    );
  }
});

test("a driver's complaint that wraps a defect is still reported", () => {
  // Drivers catch broadly and re-raise in their own words. Whatever they
  // caught that is not a complaint of their own is a defect underneath: the
  // pipe missing an attribute a driver reads (WEBCHIRP-FRONTEND-1F), an empty
  // read a driver indexes into, the serial bridge rejecting a read.
  const wrapped = [
    cause("builtins.AttributeError", "'WebSerialPipe' object has no attribute 'port'"),
    cause("builtins.TypeError", "ord() expected a character, but string of length 0 found"),
    cause("pyodide.ffi.JsException", "NetworkError: The device has been lost."),
  ];
  for (const below of wrapped) {
    const error = driverCloneError("chirp.errors.RadioError", "Failed to communicate with radio", { causes: [below] });
    assert.equal(isIgnored(error), false, `a RadioError wrapping ${below.type} should be reported`);
  }
  // Anywhere in the chain, not only the nearest link.
  const deep = driverCloneError("chirp.errors.RadioError", "Failed to communicate with radio", {
    causes: [cause("builtins.Exception", "Failed to read block"), wrapped[1]],
  });
  assert.equal(isIgnored(deep), false);
});

test("only the drivers' catch-all classes count, and exactly", () => {
  const kept = [
    // A driver tripping over its own data during a clone is a driver bug.
    driverCloneError("builtins.ValueError", "invalid literal for int() with base 10: ''"),
    driverCloneError("builtins.TypeError", "'NoneType' object is not subscriptable"),
    // A class named Exception that Python did not define is not the bare one.
    driverCloneError("chirp.drivers.uvk5.Exception", "Something odd"),
    // A subclass of RadioError is another rule's: this app's own refusals
    // derive from it, and so do the CHIRP classes the list names one by one.
    driverCloneError("webchirp_bridge.runtime_errors.RuntimeUnsupportedError", "Not a clone-mode radio"),
    driverCloneError("chirp.errors.InvalidMemoryLocation", "Location 129 does not exist"),
  ];
  for (const error of kept) {
    assert.equal(isIgnored(error), false, `${error.pythonModule}.${error.name} should be reported`);
  }
});

test("a native JS error is never dropped by the runtime rule", () => {
  // Only a RuntimeCallError carries a Python type; a JS error whose text
  // happens to name a CHIRP class is an ordinary failure.
  const error = new Error("chirp.errors.InvalidDataError: No channels found");
  assert.equal(isIgnored(error), false);
});

// The top-level classes a CHIRP module defines, read from its source under
// chirp/ ("chirp.settings" is chirp/chirp/settings.py).
function classesDefinedBy(module) {
  const file = path.join(repoRoot, "chirp", ...module.split(".")) + ".py";
  const source = fs.readFileSync(file, "utf8");
  const defined = new Set([...source.matchAll(/^class\s+(\w+)/gm)].map((match) => match[1]));
  assert.ok(defined.size > 0, `${file} should define classes`);
  return defined;
}

test("every class the rule names still exists in CHIRP", () => {
  for (const [name] of [...DROPPED, ...REPORTED]) {
    const { module, type } = splitQualifiedName(name);
    assert.ok(classesDefinedBy(module).has(type), `${name} is no longer defined by CHIRP`);
  }
  // And the list the rule reads is exactly the dropped set above, module by
  // module, so a class added to it without a test here fails.
  const dropped = {};
  for (const [name] of DROPPED) {
    const { module, type } = splitQualifiedName(name);
    (dropped[module] ??= []).push(type);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(IGNORED_CHIRP_ERRORS).map(([module, types]) => [module, [...types].sort()])),
    Object.fromEntries(Object.entries(dropped).map(([module, types]) => [module, types.sort()])),
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

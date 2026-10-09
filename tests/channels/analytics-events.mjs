import assert from "node:assert/strict";
import test from "node:test";

import { CUSTOM_DIMENSIONS } from "../../web/js/analytics.js";
import {
  channelCountBucket,
  classifyErrorKind,
  codeplugParams,
  errorTypeName,
  firstIssueColumn,
  radioEventParams,
} from "../../web/js/ui/analytics.ts";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";

// The parameters the UI attaches to its events. What these produce is what GA
// stores forever, so the tests here are as much about what must never be sent —
// a file name, a frequency, a raw error message — as about what must.
// web/js/analytics.js owns the gtag side of it and is covered in
// tests/channels/analytics.mjs.

// A runtime failure reaches the UI as the RuntimeCallError the dispatcher
// throws: the Python class as its type, str(exc) as its message and the
// traceback alongside.
function pythonError(type, message, options) {
  return runtimeCallError(type, message, options);
}

test("classifyErrorKind maps radio failures onto the fixed vocabulary", () => {
  assert.equal(
    classifyErrorKind(pythonError("RadioError", "Radio did not respond")),
    "no_response",
  );
  assert.equal(
    classifyErrorKind(pythonError("RadioError", "Incorrect model ID, got 0x1234")),
    "ident_mismatch",
  );
  assert.equal(
    classifyErrorKind(new Error("The device has been lost.")),
    "serial_disconnect",
  );
  assert.equal(
    classifyErrorKind(new Error("Serial read timed out after 3s")),
    "timeout",
  );
  assert.equal(classifyErrorKind(new Error("Checksum mismatch in block 4")), "checksum");
});

test("Python traceback wrappers do not masquerade as the exception type", () => {
  for (const name of ["StopIteration", "StopAsyncIteration", "KeyboardInterrupt", "SystemExit", "GeneratorExit"]) {
    for (const suffix of ["", ": stopped"]) {
      const error = new Error("PythonError: Traceback (most recent call last):\n" + name + suffix);
      assert.equal(errorTypeName(error), name);
      error.name = "PythonError";
      error.stack = "new_error@pyodide.asm.js:10:10028\n307@wasm-function[307]";
      assert.equal(errorTypeName(error), name);
    }
  }
  const unknown = new Error("PythonError: Traceback (most recent call last):\nCustomFailure: stopped");
  assert.equal(errorTypeName(unknown), "");
  unknown.name = "PythonError";
  unknown.stack = "new_error@pyodide.asm.js:10:10028";
  assert.equal(errorTypeName(unknown), "");
});

test("classifyErrorKind recognizes the geolocation failure sentences", () => {
  // The sentences web/js/ui/repeater-query.js writes for GeolocationPositionError
  // codes must land in the bucket the GA event promises, or a deny would read
  // as the catch-all "other" next to the ones that mapped.
  assert.equal(
    classifyErrorKind(new Error("Location permission was denied by the browser.")),
    "permission_denied",
  );
  assert.equal(
    classifyErrorKind(new Error("Getting the location timed out.")),
    "timeout",
  );
});

test("classifyErrorKind falls back to other rather than leaking the message", () => {
  assert.equal(classifyErrorKind(new Error("something nobody anticipated")), "other");
  assert.equal(classifyErrorKind(null), "other");
});

test("classifyErrorKind reads a runtime failure's sentence, not its traceback frames", () => {
  // A frame in a file or function whose name matches a pattern -- timeout.py,
  // a checksum helper -- says nothing about why the call failed. The old
  // text match over the whole traceback read these as the cause.
  const traceback = [
    "Traceback (most recent call last):",
    '  File "/webchirp_runtime/chirp/drivers/timeout.py", line 3, in _checksum',
    "chirp.errors.RadioError: Something unexpected",
    "",
  ].join("\n");
  assert.equal(classifyErrorKind(pythonError("RadioError", "Something unexpected", { traceback })), "other");
});

test("classifyErrorKind reads the Python exceptions a runtime failure was chained from", () => {
  // A driver that re-raises a checksum failure as a generic RadioError has
  // still said checksum; the envelope carries the inner message as a cause.
  const rewrapped = pythonError("RadioError", "Failed to read block at 0x0040", {
    causes: [{ type: "RadioError", message: "Block failed checksum!" }],
  });
  assert.equal(classifyErrorKind(rewrapped), "checksum");
});

test("classifyErrorKind reads the JS error name under a runtime failure", () => {
  // The serial transport reports through DOMException names; through Python
  // they arrive as the jsCause of a JsException.
  const lost = pythonError("JsException", "NetworkError: The device has been lost.", {
    js: { name: "NetworkError", message: "The device has been lost." },
  });
  assert.equal(classifyErrorKind(lost), "serial_disconnect");
  const refused = pythonError("JsException", "NotAllowedError: Access denied.", {
    js: { name: "NotAllowedError", message: "Access denied." },
  });
  assert.equal(classifyErrorKind(refused), "permission_denied");
  // And the same names on an error that never crossed the runtime.
  const security = new Error("Permissions policy blocks serial");
  security.name = "SecurityError";
  assert.equal(classifyErrorKind(security), "permission_denied");
  const dismissed = new Error("No device selected.");
  dismissed.name = "NotFoundError";
  assert.equal(classifyErrorKind(dismissed), "port_not_selected");
});

test("errorTypeName reads the exception type from either error shape", () => {
  assert.equal(errorTypeName(pythonError("RadioError", "Radio did not respond")), "RadioError");
  assert.equal(errorTypeName(pythonError("ImageDetectionError", "No driver claims it")), "ImageDetectionError");
  assert.equal(errorTypeName(new TypeError("x is not a function")), "TypeError");
  assert.equal(errorTypeName(new Error("plain")), "Error");
  // A string is not an error with a type.
  assert.equal(errorTypeName("Traceback (most recent call last):"), "");
  assert.equal(errorTypeName("no colon here at all"), "");
});

test("errorTypeName still reads a bootstrap failure that never crossed the dispatcher", () => {
  // A PythonError raised while seeding the runtime, before rpc_dispatch
  // exists, is flattened into a fresh Error by web/js/runtime-rpc.ts; the
  // class is only in its text.
  const error = new Error([
    "PythonError: Traceback (most recent call last):",
    '  File "/webchirp_runtime/runtime_bridge.py", line 25, in <module>',
    "ModuleNotFoundError: No module named 'webchirp_bridge'",
  ].join("\n"));
  error.stack = `Error: ${error.message}\n    at invokeRuntimeMethod (runtime-rpc.ts:1:1)`;
  assert.equal(errorTypeName(error), "ModuleNotFoundError");
});

test("radioEventParams sends driver identity and nothing else", () => {
  assert.deepEqual(
    radioEventParams({
      vendor: "Baofeng",
      model: "UV-5R",
      module: "chirp.drivers.uv5r",
      className: "BaofengUV5R",
      // Fields that exist on catalog entries but must never be reported.
      key: "uv5r",
      baudRate: 9600,
    }),
    {
      radio: "Baofeng UV-5R",
      radio_module: "chirp.drivers.uv5r",
      radio_class: "BaofengUV5R",
    },
  );
  assert.deepEqual(radioEventParams(null), {});
});

test("firstIssueColumn reports a column name, never a rejected value", () => {
  assert.equal(
    firstIssueColumn([
      { rowIndex: 2, column: "", message: "no column" },
      { rowIndex: 3, column: "Frequency", message: "444.000 out of range" },
    ]),
    "Frequency",
  );
  assert.equal(firstIssueColumn([]), "");
  assert.equal(firstIssueColumn(undefined), "");
});

test("channelCountBucket covers each range at its boundaries", () => {
  assert.equal(channelCountBucket(0), "0");
  assert.equal(channelCountBucket(1), "1-16");
  assert.equal(channelCountBucket(16), "1-16");
  assert.equal(channelCountBucket(17), "17-128");
  assert.equal(channelCountBucket(128), "17-128");
  assert.equal(channelCountBucket(129), "129-512");
  assert.equal(channelCountBucket(512), "129-512");
  assert.equal(channelCountBucket(513), "512+");
});

test("channelCountBucket refuses to invent a bucket for a non-count", () => {
  assert.equal(channelCountBucket(-1), "unknown");
  assert.equal(channelCountBucket(1.5), "unknown");
  assert.equal(channelCountBucket(NaN), "unknown");
  assert.equal(channelCountBucket(undefined), "unknown");
});

test("codeplugParams reports the editor's scale and provenance", () => {
  assert.deepEqual(
    codeplugParams({ currentRows: new Array(200).fill({}), codeplugSource: "img" }),
    { channel_count: 200, channel_count_bucket: "129-512", codeplug_source: "img" },
  );
  // Before anything has been loaded there is no provenance to report, and an
  // empty editor must not be reported as a zero-channel codeplug someone made.
  assert.deepEqual(
    codeplugParams({ currentRows: [], codeplugSource: "" }),
    { channel_count: 0, channel_count_bucket: "0", codeplug_source: "unknown" },
  );
  assert.deepEqual(
    codeplugParams(undefined),
    { channel_count: 0, channel_count_bucket: "0", codeplug_source: "unknown" },
  );
});

test("every parameter these helpers produce is a declared dimension", () => {
  // tests/channels/ga-dimensions.mjs reads the object literals at the call sites,
  // so it cannot see parameters that arrive by spreading a helper. Those are
  // exactly the ones on every radio-scoped event, and an undeclared one is
  // collected by GA and shown nowhere.
  const declared = new Set(CUSTOM_DIMENSIONS.map((dimension) => dimension.parameterName));
  const produced = [
    ...Object.keys(radioEventParams({ vendor: "v", model: "m", module: "mod", className: "C" })),
    ...Object.keys(codeplugParams({ currentRows: [], codeplugSource: "csv" })),
  ];
  assert.deepEqual(produced.filter((name) => !declared.has(name)), []);
});

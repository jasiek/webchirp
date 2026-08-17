import assert from "node:assert/strict";
import test from "node:test";

import { CUSTOM_DIMENSIONS } from "../web/js/analytics.js";
import {
  channelCountBucket,
  classifyErrorKind,
  codeplugParams,
  errorTypeName,
  firstIssueColumn,
  radioEventParams,
} from "../web/js/ui/analytics.js";

// The parameters the UI attaches to its events. What these produce is what GA
// stores forever, so the tests here are as much about what must never be sent —
// a file name, a frequency, a raw error message — as about what must.
// web/js/analytics.js owns the gtag side of it and is covered in
// scripts/test-analytics.mjs.

// A Pyodide failure reaches the UI as the Python traceback string wrapped in a
// JS Error, so the interesting content sits in the middle of error.stack: the
// first line is the generic "Traceback" banner and the last lines are JS stack
// frames. These fixtures keep that shape.
function pythonError(exceptionLine) {
  const error = new Error(`Traceback (most recent call last):\n  File "<exec>", line 1, in <module>\n${exceptionLine}`);
  error.stack = `Error: ${error.message}\n    at invokeRuntimeMethod (runtime-rpc.js:1:1)`;
  return error;
}

test("classifyErrorKind maps radio failures onto the fixed vocabulary", () => {
  assert.equal(
    classifyErrorKind(pythonError("chirp.errors.RadioError: Radio did not respond")),
    "no_response",
  );
  assert.equal(
    classifyErrorKind(pythonError("chirp.errors.RadioError: Incorrect model ID, got 0x1234")),
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

test("classifyErrorKind falls back to other rather than leaking the message", () => {
  assert.equal(classifyErrorKind(new Error("something nobody anticipated")), "other");
  assert.equal(classifyErrorKind(null), "other");
});

test("errorTypeName reads the exception type from either error shape", () => {
  // Python names its exception on the last line, below the JS frames that the
  // wrapping Error appends.
  assert.equal(
    errorTypeName(pythonError("chirp.errors.RadioError: Radio did not respond")),
    "RadioError",
  );
  assert.equal(errorTypeName(new TypeError("x is not a function")), "TypeError");
  assert.equal(errorTypeName(new Error("plain")), "Error");
  // The traceback banner ends in a colon too, and must not be read as a type.
  assert.equal(errorTypeName("Traceback (most recent call last):"), "");
  assert.equal(errorTypeName("no colon here at all"), "");
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
  // scripts/test-ga-dimensions.mjs reads the object literals at the call sites,
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

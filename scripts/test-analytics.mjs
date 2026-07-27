import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyErrorKind,
  errorTypeName,
  firstIssueColumn,
  radioEventParams,
  trackEvent,
} from "../web/js/ui/analytics.js";

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
      radio_make: "Baofeng",
      radio_model: "UV-5R",
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

test("trackEvent is inert without gtag and survives a throwing one", () => {
  assert.equal(globalThis.gtag, undefined);
  assert.doesNotThrow(() => trackEvent("radio_download", { radio_make: "Baofeng" }));

  const sent = [];
  globalThis.gtag = (...args) => sent.push(args);
  try {
    trackEvent("radio_download_success", { duration_ms: 12 });
    assert.deepEqual(sent, [["event", "radio_download_success", { duration_ms: 12 }]]);

    // Content blockers commonly replace gtag with a stub that throws; a clone
    // must not fail because its telemetry did.
    globalThis.gtag = () => {
      throw new Error("blocked");
    };
    assert.doesNotThrow(() => trackEvent("radio_download_failure", {}));
  } finally {
    delete globalThis.gtag;
  }
});

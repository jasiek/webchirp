import assert from "node:assert/strict";
import test from "node:test";

import { errorDetails, errorSummary } from "../../web/js/ui/format.js";

test("a stack without a message preserves the Python traceback and JS frames", () => {
  const message = "Traceback (most recent call last):\n  File \"channel_rows.py\", line 105\nchirp.errors.InvalidDataError: No channels found";
  const stack = "new_error@pyodide.asm.js:10:10028\n307@wasm-function[307]";
  const error = { name: "PythonError", message, stack };
  assert.equal(errorDetails(error), `PythonError: ${message}\n${stack}`);
  assert.equal(errorSummary(error), "PythonError: Traceback (most recent call last):");
});

test("a stack already containing the complete message is not duplicated", () => {
  const error = new Error("Traceback:\nValueError: invalid value");
  error.stack = `Error: ${error.message}\n    at invokeRuntimeMethod (runtime-rpc.js:1:1)`;
  assert.equal(errorDetails(error), error.stack);
});

test("partial messages in a stack do not replace the complete traceback", () => {
  const error = { message: "Traceback:\nValueError: invalid value", stack: "ValueError: invalid value\nframe@runtime.js:1:1" };
  assert.equal(errorDetails(error), `${error.message}\n${error.stack}`);
});

test("message-only, stack-only and non-Error diagnostics remain available", () => {
  assert.equal(errorDetails({ message: "failed" }), "failed");
  assert.equal(errorDetails({ stack: "frame@runtime.js:1:1" }), "frame@runtime.js:1:1");
  assert.equal(errorDetails("failed"), "failed");
  assert.equal(errorDetails(null), "Unknown error");
  assert.equal(errorDetails({ code: 1 }), '{"code":1}');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(errorDetails(cyclic), "[object Object]");
});

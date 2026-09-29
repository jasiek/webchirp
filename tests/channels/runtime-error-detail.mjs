// The debug-panel detail of a runtime failure keeps the JS frames of the call
// that asked for it in every browser's stack syntax.
//
// runtimeErrorDetail (web/js/runtime-errors.mjs) prints its own headline and
// the Python traceback, then the frames of error.stack. Only V8 opens a stack
// with a headline of its own; Firefox and Safari write frames alone, in a
// different syntax, so a filter that knew only V8's "at" lines dropped every
// frame there.

import assert from "node:assert/strict";
import test from "node:test";

import { runtimeErrorDetail } from "../../web/js/runtime-errors.mjs";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";

// A runtime failure whose stack is the given text, as that browser wrote it.
function failureWithStack(stack) {
  const error = runtimeCallError("RadioError", "Radio did not respond");
  error.stack = stack;
  return error;
}

// The lines runtimeErrorDetail printed after the Python traceback.
function jsFramesOf(detail) {
  const lines = detail.split("\n");
  const last = lines.findIndex((line) => line.startsWith("chirp.errors.RadioError: "));
  assert.ok(last > 0, "the traceback should come before the JS frames");
  return lines.slice(last + 1);
}

test("V8 frames are kept and its headline is dropped", () => {
  const detail = runtimeErrorDetail(failureWithStack([
    "Error: Radio did not respond",
    "    at unwrapRpcEnvelope (https://example.test/js/rpc-dispatch.mjs:112:11)",
    "    at async download (https://example.test/js/runtime-rpc.js:40:5)",
  ].join("\n")));
  assert.match(detail, /^RadioError: Radio did not respond\n/);
  assert.deepEqual(jsFramesOf(detail), [
    "    at unwrapRpcEnvelope (https://example.test/js/rpc-dispatch.mjs:112:11)",
    "    at async download (https://example.test/js/runtime-rpc.js:40:5)",
  ]);
});

test("Firefox frames are kept", () => {
  const frames = [
    "unwrapRpcEnvelope@https://example.test/js/rpc-dispatch.mjs:112:11",
    "async*download@https://example.test/js/runtime-rpc.js:40:5",
    "@https://example.test/js/app.js:7:1",
  ];
  assert.deepEqual(jsFramesOf(runtimeErrorDetail(failureWithStack(`${frames.join("\n")}\n`))), frames);
});

test("Safari frames are kept, native ones included", () => {
  const frames = [
    "unwrapRpcEnvelope@https://example.test/js/rpc-dispatch.mjs:112:11",
    "forEach@[native code]",
    "module code@https://example.test/js/app.js:7:1",
  ];
  assert.deepEqual(jsFramesOf(runtimeErrorDetail(failureWithStack(frames.join("\n")))), frames);
});

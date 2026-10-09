// A Python failure crosses the Pyodide boundary as a typed error.
//
// rpc_dispatch (web/python/webchirp_bridge/rpc.py) answers a failed call with
// an envelope naming the exception's class, bases, module, message, traceback
// and -- for a JsException -- the JS error underneath; unwrapRpcEnvelope
// (web/js/rpc-dispatch.ts) throws it as a RuntimeCallError
// (web/js/runtime-errors.ts). Every UI classifier tests those fields instead
// of searching traceback text, so these tests drive real failures through the
// real dispatcher -- the same one the browser uses, reached through the Node
// harness -- and check each classifier on what comes out.

import assert from "node:assert/strict";
import test from "node:test";

import { loadImageWithDriverFallback } from "../../web/js/image-metadata.ts";
import {
  RuntimeCallError,
  isPythonError,
  isUserPreconditionFailure,
  runtimeErrorSentence,
} from "../../web/js/runtime-errors.ts";
import {
  PORT_SELECTION_CANCELLED,
  PORT_SELECTION_CANCELLED_MESSAGE,
  createPortSelectionCancelledError,
  isPortSelectionCancelled,
} from "../../web/js/serial-errors.ts";
import { classifyErrorKind, errorTypeName } from "../../web/js/ui/analytics.js";
import { createDebugLog } from "../../web/js/ui/debug-log.js";
import { errorSummary } from "../../web/js/ui/format.js";
import { ensureModule, readImage, sharedHarness } from "../support/chirp.mjs";
import { fakeDebugDom } from "../support/fake-dom.mjs";

// Run a call that must fail and hand back what it threw.
async function failure(promise) {
  return promise.then(
    () => assert.fail("the call was expected to fail"),
    (error) => error,
  );
}

// Make the harness's serial bridge reject open() with the given error for the
// duration of fn. Python awaits serial_open, which calls the bridge's open()
// by name, so the rejection becomes a JsException inside webserial_connect.
async function withRejectingOpen(harness, error, fn) {
  const bridge = harness.serialBridge;
  const original = bridge.open;
  bridge.open = async () => {
    throw error;
  };
  try {
    return await fn();
  } finally {
    bridge.open = original;
  }
}

test("a precondition failure arrives as a RuntimeCallError with its type and bases", async () => {
  const harness = await sharedHarness();
  const error = await failure(harness.rpc("get_radio_settings", { session_id: "never-opened" }));

  assert.ok(error instanceof RuntimeCallError);
  assert.equal(error.name, "RuntimePreconditionError");
  assert.equal(error.pythonType, "RuntimePreconditionError");
  assert.equal(error.pythonModule, "webchirp_bridge.runtime_errors");
  assert.equal(error.rpcMethod, "get_radio_settings");
  assert.deepEqual(
    [...error.pythonBases],
    ["RuntimeUnsupportedError", "RadioError", "Exception", "BaseException"],
  );
  // The message is the sentence; the class and the frames are elsewhere.
  assert.match(error.message, /never-opened.*is not open/s);
  assert.doesNotMatch(error.message, /Traceback|RuntimePreconditionError/);
  assert.match(error.pythonTraceback, /webchirp_bridge\.runtime_errors\.RuntimePreconditionError:/);
  assert.equal(error.jsCause, null);

  // Matched by its own class and by every base, never by a sibling.
  assert.equal(isPythonError(error, "RuntimePreconditionError"), true);
  assert.equal(isPythonError(error, "RuntimeUnsupportedError"), true);
  assert.equal(isPythonError(error, "RadioError"), true);
  assert.equal(isPythonError(error, "ImageDetectionError"), false);
  assert.equal(isUserPreconditionFailure(error), true);
  assert.equal(runtimeErrorSentence(error), error.message);
  assert.equal(errorTypeName(error), "RuntimePreconditionError");
});

test("an ImageDetectionError is recognised by type and still triggers the all-drivers retry", async () => {
  // No driver that claims a UV-3R image is imported yet, so the first load
  // fails detection for real. The "sweep" here imports the one module that
  // does claim it, which is all the retry needs to succeed on the second load.
  const harness = await sharedHarness();
  const image = await readImage("Baofeng_UV-3R.img");
  const calls = [];

  const loaded = await loadImageWithDriverFallback({
    resolvedDriver: { module: "uv5r", className: "BaofengUV5R" },
    loadImage: async () => {
      calls.push("load");
      try {
        return await harness.loadCodeplugBinary(image);
      } catch (error) {
        calls.push(`failed:${error.name}`);
        assert.ok(isPythonError(error, "ImageDetectionError"));
        throw error;
      }
    },
    importAllDrivers: async () => {
      calls.push("sweep");
      await ensureModule(harness, "baofeng_uv3r");
    },
    log: (line) => calls.push(line.includes("retrying against all drivers") ? "retry" : line),
  });

  assert.deepEqual(calls, ["load", "failed:ImageDetectionError", "retry", "sweep", "load"]);
  assert.equal(loaded.module, "baofeng_uv3r");
});

test("a generic exception carries its traceback to the debug log", async () => {
  const harness = await sharedHarness();
  const error = await failure(
    harness.rpc("open_session", { module_name: "no_such_driver", class_name: "Nope" }),
  );
  assert.equal(error.name, "ModuleNotFoundError");
  assert.ok(isPythonError(error, "ImportError"), "a builtin subclass matches its base too");

  const dom = fakeDebugDom();
  const log = createDebugLog({ dom, notice: { show: () => assert.fail("not a precondition") } });
  log.reportActionError("Open radio", error);

  const panel = dom.debugOutputEl.value;
  // The whole traceback, frames and all, under a line that names the cause.
  assert.match(panel, /OPEN RADIO ERROR\nModuleNotFoundError: /);
  assert.match(panel, /Traceback \(most recent call last\):/);
  assert.match(panel, /File "[^"]*webchirp_bridge\/rpc\.py", line \d+, in rpc_dispatch/);
  assert.match(panel, /\nModuleNotFoundError: No module named /);
  // Followed by the JS frames of the call that asked for it.
  assert.match(panel, /\n\s+at .*rpc-dispatch\.ts/);
  // And the one-line summary is the cause, not the traceback banner.
  assert.match(errorSummary(error), /^ModuleNotFoundError: No module named /);
  assert.match(log.getLastErrorSummary(), /^OPEN RADIO ERROR ModuleNotFoundError: /);
});

test("a JsException from a rejected JS call carries the JS error's name through", async () => {
  const harness = await sharedHarness();
  const lost = new Error("The device has been lost.");
  lost.name = "NetworkError";

  const error = await withRejectingOpen(harness, lost, () => failure(
    harness.rpc("webserial_connect", { baudrate: 9600 }),
  ));

  assert.equal(error.pythonType, "JsException");
  assert.equal(error.pythonModule, "pyodide.ffi");
  assert.deepEqual(error.jsCause, { name: "NetworkError", message: "The device has been lost." });
  assert.equal(classifyErrorKind(error), "serial_disconnect");
  assert.equal(isPortSelectionCancelled(error), false);
});

test("a JS error re-raised as a RadioError still names the JS error underneath", async () => {
  // Drivers wrap serial failures in errors of their own; the envelope follows
  // the exception chain to the JsException at the bottom.
  const harness = await sharedHarness();
  const envelope = await harness.runPythonJson(`
import js
from chirp import errors as _chirp_errors
from pyodide.ffi import JsException as _JsException
from webchirp_bridge.rpc import rpc_error_envelope as _rpc_error_envelope
js.eval("globalThis.__envelopeProbe = () => { const e = new Error('gone'); e.name = 'NetworkError'; throw e; }")
try:
    try:
        js.__envelopeProbe()
    except _JsException as _inner:
        raise _chirp_errors.RadioError("Failed to communicate with radio") from _inner
except _chirp_errors.RadioError as _outer:
    _envelope = _rpc_error_envelope(_outer)
json.dumps(_envelope)
  `);
  delete globalThis.__envelopeProbe;
  assert.equal(envelope.type, "RadioError");
  assert.equal(envelope.module, "chirp.errors");
  assert.equal(envelope.message, "Failed to communicate with radio");
  assert.deepEqual(envelope.js, { name: "NetworkError", message: "gone" });
  assert.deepEqual(envelope.causes.map((cause) => cause.type), ["JsException"]);
});

test("a failure a driver re-raised under a generic message still classifies by its cause", async () => {
  // iradio_uv_5118plus catches "Block failed checksum!" and raises "Failed to
  // read block" while handling it; the envelope names the inner failure, so
  // error_kind is checksum rather than other.
  const harness = await sharedHarness();
  const envelope = await harness.runPythonJson(`
from chirp import errors as _chirp_errors
from webchirp_bridge.rpc import rpc_error_envelope as _rpc_error_envelope
try:
    try:
        raise _chirp_errors.RadioError("Block failed checksum!")
    except _chirp_errors.RadioError:
        raise _chirp_errors.RadioError("Failed to read block at 0x0040")
except _chirp_errors.RadioError as _outer:
    _envelope = _rpc_error_envelope(_outer)
json.dumps(_envelope)
  `);
  assert.equal(envelope.message, "Failed to read block at 0x0040");
  assert.deepEqual(envelope.causes, [{ type: "RadioError", message: "Block failed checksum!" }]);

  const { unwrapRpcEnvelope } = await import("../../web/js/rpc-dispatch.ts");
  const error = await failure(Promise.resolve().then(() => unwrapRpcEnvelope("download", { ok: false, error: envelope })));
  assert.deepEqual(error.pythonCauses, [{ type: "RadioError", message: "Block failed checksum!" }]);
  assert.equal(classifyErrorKind(error), "checksum");
});

test("a dismissed port chooser is still classified port_not_selected after crossing Python", async () => {
  const harness = await sharedHarness();
  const error = await withRejectingOpen(harness, createPortSelectionCancelledError(), () => failure(
    harness.rpc("webserial_connect", { baudrate: 9600 }),
  ));

  assert.equal(error.pythonType, "JsException");
  assert.equal(error.jsCause?.name, PORT_SELECTION_CANCELLED);
  assert.equal(error.jsCause?.message, PORT_SELECTION_CANCELLED_MESSAGE);
  assert.equal(isPortSelectionCancelled(error), true);
  assert.equal(classifyErrorKind(error), "port_not_selected");
});

test("a reply that is not an envelope fails loudly instead of passing as a result", async () => {
  const { unwrapRpcEnvelope } = await import("../../web/js/rpc-dispatch.ts");
  assert.deepEqual(unwrapRpcEnvelope("get_default_schema", { ok: true, result: { a: 1 } }), { a: 1 });
  assert.throws(
    () => unwrapRpcEnvelope("get_default_schema", { columns: [] }),
    /get_default_schema returned no envelope/,
  );
});

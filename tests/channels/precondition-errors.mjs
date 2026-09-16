// Pressing Upload before ever downloading is not a bug report.
//
// The runtime refuses that upload -- there is no image to write channels onto
// -- and the refusal used to arrive in Sentry as a RuntimeUnsupportedError with
// a full Python traceback, once per user who pressed the buttons in that order.
// A guard whose own message tells the user what to do next is the app working,
// and a stream of them buries the failures worth reading.
//
// Two halves have to agree for the drop to happen, and neither is visible from
// the other: the runtime has to raise RuntimePreconditionError
// (web/python/webchirp_bridge/runtime_errors.py), and IGNORE_ERRORS in
// web/js/sentry.js has to match that name. Pyodide flattens the exception into
// the error message, so the class name is the only contract between them --
// rename the class and the rule stops matching in a way nothing else notices.

import assert from "node:assert/strict";
import test from "node:test";

import { initOptions } from "../../web/js/sentry.js";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";

// A clone-mode driver, so the upload gets past the clone-mode check and reaches
// the cached-image guard this test is about. Which model it is does not matter.
const DRIVER_MODULE = "uv5r";
const DRIVER_CLASS = "BaofengF11Radio";

function isIgnored(message) {
  return initOptions().ignoreErrors.some((pattern) => pattern.test(message));
}

test("an upload with nothing downloaded raises the precondition error, and Sentry drops it", async () => {
  // A fresh runtime: the shared one may have cached an image for this driver in
  // an earlier test, which is exactly the state the guard is checking for.
  const harness = await sharedHarness({ isolated: true });
  await ensureModule(harness, DRIVER_MODULE);

  const error = await harness
    .runPython("await upload_selected_radio(_m, _c, [])", {
      _m: DRIVER_MODULE,
      _c: DRIVER_CLASS,
    })
    .then(
      () => null,
      (thrown) => thrown,
    );

  assert.ok(error, "upload with no cached image should have failed");
  const message = String(error.message || error);
  assert.match(message, /RuntimePreconditionError/);
  assert.match(message, /Download from radio first/);
  assert.ok(isIgnored(message), "the traceback should be filtered out of Sentry");
});

test("an ordinary radio failure is still reported", () => {
  // The same shape of traceback, raised by the error class that means something
  // went wrong. A filter that swallowed this too would be worse than none.
  const message = [
    "PythonError: Traceback (most recent call last):",
    '  File "/webchirp_runtime/webchirp_bridge/clone.py", line 216, in upload_selected_radio',
    "chirp.errors.RadioError: Radio did not respond",
  ].join("\n");
  assert.equal(isIgnored(message), false);
});

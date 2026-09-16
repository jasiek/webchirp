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
import { runtimeErrorSentence } from "../../web/js/runtime-errors.mjs";
import { createDebugLog } from "../../web/js/ui/debug-log.js";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import { fakeDebugDom } from "../support/fake-dom.mjs";

// The traceback as it reaches the UI: Pyodide prefixes its own line, CHIRP's
// frames sit in the middle, and the sentence the user needs is the last line.
const UPLOAD_TRACEBACK = [
  "PythonError: Traceback (most recent call last):",
  '  File "/lib/python312.zip/_pyodide/_base.py", line 597, in eval_code_async',
  "    await CodeRunner(",
  '  File "/webchirp_runtime/webchirp_bridge/clone.py", line 216, in upload_selected_radio',
  "    return _upload_selected_radio_sync(module_name, class_name, rows, settings_groups)",
  "webchirp_bridge.runtime_errors.RuntimePreconditionError: No cached radio image for this"
  + " model. Download from radio first, then upload.",
].join("\n");

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

test("the sentence is lifted out of the traceback, not shown alongside it", () => {
  assert.equal(
    runtimeErrorSentence(new Error(UPLOAD_TRACEBACK)),
    "No cached radio image for this model. Download from radio first, then upload.",
  );
  // A JS failure has no traceback to read; its own message is the sentence.
  assert.equal(runtimeErrorSentence(new Error("Failed to fetch")), "Failed to fetch");
});

test("a precondition failure raises a notice instead of a bug report", () => {
  const shown = [];
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom, notice: { show: (notice) => shown.push(notice) } });

  log.reportActionError("Upload", new Error(UPLOAD_TRACEBACK));

  assert.deepEqual(shown, [{
    title: "Upload not possible yet",
    message: "No cached radio image for this model. Download from radio first, then upload.",
  }]);
  // Not a defect, so it does not become the title of the user's next bug report
  // and does not throw the debug panel open in their face.
  assert.equal(log.getLastErrorSummary(), "");
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "false");
  // The panel still has all of it, which is the rule that has no exceptions.
  assert.match(dom.debugOutputEl.value, /UPLOAD BLOCKED/);
  assert.match(dom.debugOutputEl.value, /clone\.py/);
});

test("an ordinary failure still opens the panel and raises no notice", () => {
  const shown = [];
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom, notice: { show: (notice) => shown.push(notice) } });

  log.reportActionError("Upload", new Error("chirp.errors.RadioError: Radio did not respond"));

  assert.deepEqual(shown, []);
  assert.match(String(log.getLastErrorSummary()), /Radio did not respond/);
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
});

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
// (web/python/webchirp_bridge/runtime_errors.py), and isIgnoredError in
// web/js/sentry.js has to test for that class. The dispatcher sends the class
// as a field of the error envelope, so the class name is the contract between
// them -- rename the class and the rule stops matching in a way nothing else
// notices.

import assert from "node:assert/strict";
import test from "node:test";

import { initOptions } from "../../web/js/sentry.js";
import { isPythonError, runtimeErrorSentence } from "../../web/js/runtime-errors.mjs";
import { createDebugLog } from "../../web/js/ui/debug-log.js";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import { fakeDebugDom } from "../support/fake-dom.mjs";
import { runtimeCallError } from "../support/runtime-call-errors.mjs";

const UPLOAD_SENTENCE = "No cached radio image for this model. Download from radio first, then upload.";

// The failure as it reaches the UI: a RuntimeCallError whose message is the
// sentence the user needs and whose traceback carries CHIRP's frames.
function uploadPreconditionError() {
  return runtimeCallError("RuntimePreconditionError", UPLOAD_SENTENCE);
}

// A clone-mode driver, so the upload gets past the clone-mode check and reaches
// the cached-image guard this test is about. Which model it is does not matter.
const DRIVER_MODULE = "uv5r";
const DRIVER_CLASS = "BaofengF11Radio";

// Whether beforeSend drops the event Sentry would build for this failure.
function isIgnored(error) {
  const event = { exception: { values: [{ type: error.name, value: error.message }] } };
  return initOptions().beforeSend(event, { originalException: error }) === null;
}

test("an upload with nothing downloaded raises the precondition error, and Sentry drops it", async () => {
  // A session of its own, freshly opened: nothing has been downloaded into
  // it, which is exactly the state the guard is checking for. Called through
  // the dispatcher, so the error is the one the browser would hold.
  const harness = await sharedHarness();
  await ensureModule(harness, DRIVER_MODULE);
  const { sessionId } = await harness.rpc("open_session", {
    module_name: DRIVER_MODULE,
    class_name: DRIVER_CLASS,
  });

  const error = await harness
    .rpc("upload_selected_radio", { session_id: sessionId, rows: [], settings_groups: [] })
    .then(
      () => null,
      (thrown) => thrown,
    );
  await harness.rpc("close_session", { session_id: sessionId });

  assert.ok(error, "upload with no cached image should have failed");
  assert.ok(isPythonError(error, "RuntimePreconditionError"));
  assert.match(error.message, /Download from radio first/);
  assert.ok(isIgnored(error), "the failure should be filtered out of Sentry");
});

test("an ordinary radio failure is still reported", () => {
  // The same shape of failure, raised by the error class that means something
  // went wrong. A filter that swallowed this too would be worse than none.
  assert.equal(isIgnored(runtimeCallError("RadioError", "Radio did not respond")), false);
});

test("the sentence is the Python message, not the traceback that carries it", () => {
  assert.equal(runtimeErrorSentence(uploadPreconditionError()), UPLOAD_SENTENCE);
  // A JS failure has no traceback to read; its own message is the sentence.
  assert.equal(runtimeErrorSentence(new Error("Failed to fetch")), "Failed to fetch");
});

test("a precondition failure raises a notice instead of a bug report", () => {
  const shown = [];
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom, notice: { show: (notice) => shown.push(notice) } });

  log.reportActionError("Upload", uploadPreconditionError());

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

  log.reportActionError("Upload", runtimeCallError("RadioError", "Radio did not respond"));

  assert.deepEqual(shown, []);
  assert.match(String(log.getLastErrorSummary()), /Radio did not respond/);
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
});

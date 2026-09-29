// The JS side of web/python/webchirp_bridge/runtime_errors.py: what a runtime
// failure can be recognised as once it has crossed the Pyodide boundary.
//
// rpc_dispatch (web/python/webchirp_bridge/rpc.py) never raises across the
// boundary; a failed call comes back as an envelope of fields describing the
// Python exception, and web/js/rpc-dispatch.mjs turns that envelope into the
// RuntimeCallError below. Every classifier here tests those fields, so the
// Python class names are the contract and they are stated once, in this module,
// rather than at each call site.

// A Python exception that crossed rpc_dispatch, as a JS Error. name is the
// Python class name, so Sentry titles and groups the event by it and a stack
// trace reads "RadioError: Radio did not respond"; message is str(exc) alone,
// the sentence a user can be shown. The rest is what the envelope carried:
// pythonBases (every class above it, up to BaseException), pythonModule, the
// full pythonTraceback the debug panel prints, jsCause ({name, message} of the
// JS error behind a JsException, or null) and the rpcMethod that failed.
export class RuntimeCallError extends Error {
  constructor(envelope = {}, { method = "" } = {}) {
    super(String(envelope.message ?? ""));
    this.name = String(envelope.type || "RuntimeCallError");
    this.pythonType = String(envelope.type || "");
    this.pythonBases = Object.freeze((envelope.bases || []).map(String));
    this.pythonModule = String(envelope.module || "");
    this.pythonTraceback = String(envelope.traceback || "");
    this.jsCause = envelope.js
      ? Object.freeze({ name: String(envelope.js.name || ""), message: String(envelope.js.message || "") })
      : null;
    this.rpcMethod = String(method || "");
  }
}

// Whether an error is a Python failure that came through rpc_dispatch. Tested
// by its fields rather than instanceof: the fields are what every classifier
// below reads, and they survive a caller that copies the error onto a plain
// object.
export function isRuntimeCallError(error) {
  return typeof error?.pythonType === "string" && error.pythonType !== ""
    && Array.isArray(error?.pythonBases);
}

// Whether error is a Python exception of class typeName or of any subclass of
// it: the class itself is checked first, then every base the envelope listed.
// This is the whole replacement for the regexes that used to look for a class
// name somewhere in a traceback's text.
export function isPythonError(error, typeName) {
  if (!isRuntimeCallError(error)) {
    return false;
  }
  return error.pythonType === typeName || error.pythonBases.includes(typeName);
}

// The name of the JS error at the bottom of a failure: the one a rejected JS
// call raised inside Python (a JsException's jsCause), or, for an error that
// never crossed the runtime, its own name. The port chooser and the serial
// transport report what happened through DOMException names, so this is what
// a classifier reads to recognise them wherever they surfaced.
export function jsErrorName(error) {
  if (isRuntimeCallError(error)) {
    return error.jsCause?.name || "";
  }
  return typeof error?.name === "string" ? error.name : "";
}

// Text the old regex classifiers read: the traceback for a runtime failure,
// the message for anything else. Transitional -- the classifiers below move to
// type checks in the next change and this goes with them.
function legacyErrorText(error) {
  if (isRuntimeCallError(error)) {
    return error.pythonTraceback;
  }
  return String(error?.message || error || "");
}

// A step the user has not taken yet, rather than something that went wrong:
// pressing Upload before anything has been downloaded is the case this exists
// for. The message is already the instruction that fixes it, which is why the
// UI answers with a modal (web/js/ui/notice-modal.js) instead of a traceback in
// the debug panel, and why the event never reaches Sentry (IGNORE_ERRORS,
// web/js/sentry.js).
export function isUserPreconditionFailure(error) {
  return /\bRuntimePreconditionError\b/.test(legacyErrorText(error));
}

// The sentence a Python failure ends on, without the exception class in front
// of it -- "No cached radio image for this model. Download from radio first,
// then upload." rather than the twenty lines of traceback that carry it.
//
// Scans from the end for the same reason errorTypeName (web/js/ui/analytics.js)
// does: a Python traceback names its exception on the last line, under the
// stack frames rather than above them. Anything that is not a Python traceback
// -- a JS Error, a bare string -- falls through to its own text, so a caller
// never has to ask which kind of failure it is holding.
export function runtimeErrorSentence(error) {
  const text = legacyErrorText(error).trim();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // "webchirp_bridge.runtime_errors.RuntimePreconditionError: Download ..."
    const match = lines[i].match(/^([\w.]+(?:Error|Exception)):\s*(.+)$/);
    if (match?.[2]) {
      return match[2].trim();
    }
  }
  return lines[0] || "Unknown error";
}

// Full detail of a failure for the debug panel. A runtime failure prints its
// Python traceback -- the frames that say where CHIRP broke -- followed by the
// JS frames of the call that asked for it; anything else prints its own stack
// or message. This is what the panel showed before the envelope, minus the
// Pyodide wrapper line, and CLAUDE.md requires the whole of it to reach the
// panel.
export function runtimeErrorDetail(error) {
  if (isRuntimeCallError(error)) {
    const jsFrames = String(error.stack || "")
      .split("\n")
      .filter((line) => /^\s+at\s/.test(line));
    return [error.pythonTraceback.trimEnd(), ...jsFrames].join("\n");
  }
  if (typeof error?.stack === "string" && error.stack) {
    return error.stack;
  }
  return error?.message || String(error);
}

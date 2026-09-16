// The JS side of web/python/webchirp_bridge/runtime_errors.py: what a runtime
// failure can be recognised as once it has crossed the Pyodide boundary.
//
// Pyodide flattens a Python exception into the text of the error it hands back,
// so on this side there is no class to test and no fields to read -- the
// traceback's last line is the whole contract. Both helpers here read that
// line, and both are kept in one module so the coupling to the Python names is
// stated once rather than at each call site.

// A step the user has not taken yet, rather than something that went wrong:
// pressing Upload before anything has been downloaded is the case this exists
// for. The message is already the instruction that fixes it, which is why the
// UI answers with a modal (web/js/ui/notice-modal.js) instead of a traceback in
// the debug panel, and why the event never reaches Sentry (IGNORE_ERRORS,
// web/js/sentry.js).
export function isUserPreconditionFailure(error) {
  return /\bRuntimePreconditionError\b/.test(String(error?.message || error || ""));
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
  const text = String(error?.message || error || "").trim();
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

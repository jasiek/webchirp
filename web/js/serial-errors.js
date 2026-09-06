// Dismissing the browser's serial port (or WebUSB device) chooser is a user
// decision, not an adapter failure, but the browser reports it the same way it
// reports everything else the chooser can go wrong with: a rejected promise.
// Left untranslated it reached the UI as a Pyodide traceback ending in
// "JsException: NotFoundError", which the app dumped into the Debug Output
// panel -- unreadable enough that pressing Connect and then Cancel looked like
// the click had never registered at all.
//
// This module is the one place that names that outcome, shared by the serial
// bridge that raises it and the UI that reports it. It is deliberately tiny and
// dependency-free so the UI can import it without pulling in the whole serial
// stack.

// Carried on the Error object while it stays inside one JS realm (the bridge's
// own callers, the CLI, tests).
export const PORT_SELECTION_CANCELLED = "PortSelectionCancelledError";

// The wording matters twice over. It has to read as a sentence to a user, and
// it has to contain "No port selected" because that is the substring
// classifyErrorKind() in web/js/ui/analytics.js matches to report the outcome
// as error_kind=port_not_selected -- the only part of the error that survives
// the round trip through Pyodide, which flattens everything else into a
// traceback string.
export const PORT_SELECTION_CANCELLED_MESSAGE =
  "No port selected: the browser's port chooser was dismissed.";

// Build the error the bridge throws when the chooser is dismissed.
export function createPortSelectionCancelledError() {
  const error = new Error(PORT_SELECTION_CANCELLED_MESSAGE);
  error.name = PORT_SELECTION_CANCELLED;
  return error;
}

// Recognize that outcome again on the far side of the runtime boundary. The
// name survives only when the error was never serialized, so the message text
// is checked too: by the time serialConnect() rejects in the UI, the error is a
// plain Error whose message is a whole Python traceback with our sentence on
// its last line.
export function isPortSelectionCancelled(error) {
  if (!error) {
    return false;
  }
  if (error.name === PORT_SELECTION_CANCELLED) {
    return true;
  }
  const text = typeof error === "string"
    ? error
    : `${error.message || ""}\n${error.stack || ""}`;
  return text.includes(PORT_SELECTION_CANCELLED_MESSAGE);
}

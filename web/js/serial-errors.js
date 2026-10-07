// Dismissing the browser's serial port (or WebUSB device) chooser is a user
// decision, not an adapter failure, but the browser reports it the same way it
// reports everything else the chooser can go wrong with: a rejected promise.
// Left untranslated it reached the UI as a Pyodide traceback ending in
// "JsException: NotFoundError", which the app dumped into the Debug Output
// panel -- unreadable enough that pressing Connect and then Cancel looked like
// the click had never registered at all.
//
// This module is the one place that names that outcome, shared by the serial
// bridge that raises it and the UI that reports it. It is deliberately tiny,
// depending only on the equally dependency-free web/js/runtime-errors.mjs, so
// the UI can import it without pulling in the whole serial stack.

import { jsErrorName } from "./runtime-errors.mjs";

// Carried on the Error object while it stays inside one JS realm (the bridge's
// own callers, the CLI, tests).
export const PORT_SELECTION_CANCELLED = "PortSelectionCancelledError";

// A capability limit stays recognizable after Pyodide flattens the exception.
export const SERIAL_UNSUPPORTED = "SerialUnsupportedError";

// Name transport capability refusals without coupling reporting to UI wording.
export function createSerialUnsupportedError(message) {
  const error = new Error(message);
  error.name = SERIAL_UNSUPPORTED;
  return error;
}

// Recognize the bridge error, its runtime envelope and bootstrap traceback.
export function isSerialUnsupported(error) {
  if (!error) return false;
  if (jsErrorName(error) === SERIAL_UNSUPPORTED) return true;
  const text = typeof error === "string"
    ? error
    : `${error.message || ""}\n${error.stack || ""}`;
  return /\bSerialUnsupportedError\b/.test(text);
}

// The sentence a user is shown for it. Nothing matches on this wording: the
// cancellation is recognised by name (isPortSelectionCancelled below), so the
// copy can change freely.
export const PORT_SELECTION_CANCELLED_MESSAGE =
  "No port selected: the browser's port chooser was dismissed.";

// Build the error the bridge throws when the chooser is dismissed.
export function createPortSelectionCancelledError() {
  const error = new Error(PORT_SELECTION_CANCELLED_MESSAGE);
  error.name = PORT_SELECTION_CANCELLED;
  return error;
}

// Recognize that outcome on either side of the runtime boundary, by name. An
// error that stayed in JS (the bridge's own callers, the CLI, tests) carries
// the name itself; one that went through Python -- webserial_connect awaits
// the bridge, so the rejection becomes a JsException -- arrives as a
// RuntimeCallError whose jsCause names the JS error underneath, which
// jsErrorName (web/js/runtime-errors.mjs) reads for either shape.
export function isPortSelectionCancelled(error) {
  return jsErrorName(error) === PORT_SELECTION_CANCELLED;
}

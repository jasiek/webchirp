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
// depending only on the equally dependency-free web/js/runtime-errors.ts, so
// the UI can import it without pulling in the whole serial stack.

import { jsErrorName } from "./runtime-errors.ts";
import { errorFields } from "./error-details.ts";

// Carried on the Error object while it stays inside one JS realm (the bridge's
// own callers, the CLI, tests).
export const PORT_SELECTION_CANCELLED = "PortSelectionCancelledError";

// A capability limit stays recognizable after Pyodide flattens the exception.
export const SERIAL_UNSUPPORTED = "SerialUnsupportedError";

// Native Web Serial refused to open the port: another program holds it, or the
// OS driver failed. The browser reports it as a NetworkError, the same name it
// gives a port lost mid-clone, so the open failure gets a name of its own --
// reporting drops this one (isIgnoredError, web/js/sentry.ts) and keeps that one.
export const SERIAL_PORT_OPEN_FAILED = "SerialPortOpenFailedError";

// Rename the browser's open failure, keeping its message for the debug panel.
export function createSerialPortOpenFailedError(message: string): Error {
  const error = new Error(message);
  error.name = SERIAL_PORT_OPEN_FAILED;
  return error;
}

// Recognize that outcome by name, in JS or after crossing Python (jsErrorName
// reads a RuntimeCallError's jsCause).
export function isSerialPortOpenFailed(error: unknown): boolean {
  return jsErrorName(error) === SERIAL_PORT_OPEN_FAILED;
}

// Name transport capability refusals without coupling reporting to UI wording.
export function createSerialUnsupportedError(message: string): Error {
  const error = new Error(message);
  error.name = SERIAL_UNSUPPORTED;
  return error;
}

// Recognize the bridge error, its runtime envelope and bootstrap traceback.
export function isSerialUnsupported(error: unknown): boolean {
  if (!error) return false;
  if (jsErrorName(error) === SERIAL_UNSUPPORTED) return true;
  const fields = errorFields(error);
  const text = typeof error === "string"
    ? error
    : `${fields.message || ""}\n${fields.stack || ""}`;
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
// jsErrorName (web/js/runtime-errors.ts) reads for either shape.
export function isPortSelectionCancelled(error: unknown): boolean {
  return jsErrorName(error) === PORT_SELECTION_CANCELLED;
}

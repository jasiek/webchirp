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

// Another driver holds the cable's USB interface -- Android's own kernel
// driver, most often -- so WebUSB cannot claim it. Named for the same reason
// as SERIAL_UNSUPPORTED: the cause is on the user's machine, and reporting
// recognizes it by name after Pyodide has flattened it into a JsException.
export const USB_INTERFACE_BUSY = "UsbInterfaceBusyError";

// Build the error a chip driver throws when claimInterface is refused.
export function createUsbInterfaceBusyError(message: string): Error {
  const error = new Error(message);
  error.name = USB_INTERFACE_BUSY;
  return error;
}

// Recognize that outcome by name, in JS or after crossing Python (jsErrorName
// reads a RuntimeCallError's jsCause).
export function isUsbInterfaceBusy(error: unknown): boolean {
  return jsErrorName(error) === USB_INTERFACE_BUSY;
}

// WebUSB refused to open the device itself (USBDevice.open), before any
// interface was claimed or the chip touched: the OS denied access, or the
// device is in a state the browser will not drive. Named so a failed connect
// over WebUSB can say which of its three stages it died in -- the device, the
// claim, or the chip's own setup -- which is what the failure metric groups by.
// A device gone between the chooser and the open keeps the browser's
// NotFoundError, which analytics already counts as a disconnect.
export const USB_DEVICE_OPEN_FAILED = "UsbDeviceOpenFailedError";

// Build the error a chip driver throws when USBDevice.open() is refused.
export function createUsbDeviceOpenFailedError(message: string, cause: unknown): Error {
  const error = new Error(message, { cause });
  error.name = USB_DEVICE_OPEN_FAILED;
  return error;
}

// Recognize that outcome by name, in JS or after crossing Python.
export function isUsbDeviceOpenFailed(error: unknown): boolean {
  return jsErrorName(error) === USB_DEVICE_OPEN_FAILED;
}

// The device opened and its interface was claimed, but programming the chip
// failed: a control transfer stalled, a register read came back empty, the
// endpoints were not where the driver expected them. These are the failures
// this app's own chip drivers are answerable for -- a chip-type ladder that
// picks the wrong register map ends here -- so, unlike the two above, this one
// is reported.
export const USB_CHIP_SETUP_FAILED = "UsbChipSetupFailedError";

// Recognize that outcome by name, in JS or after crossing Python.
export function isUsbChipSetupFailed(error: unknown): boolean {
  return jsErrorName(error) === USB_CHIP_SETUP_FAILED;
}

// Name a failure thrown while a chip driver was setting its chip up. A failure
// that already carries a name -- the browser's NotFoundError for a device
// unplugged mid-setup, the busy-interface error -- says something more exact
// and is left as it is; a plain Error becomes the chip-setup error, keeping
// its sentence for the debug panel and itself as the cause.
export function nameUsbChipSetupFailure(error: unknown): unknown {
  const { name, message } = errorFields(error);
  if (name && name !== "Error") {
    return error;
  }
  const named = new Error(String(message || error), { cause: error });
  named.name = USB_CHIP_SETUP_FAILED;
  return named;
}

// The named transport failures a wrapper must not erase: reporting recognizes
// them by name alone, so a plain Error around one would be reported after all.
const PRESERVED_TRANSPORT_FAILURES: readonly string[] = [
  USB_INTERFACE_BUSY,
  SERIAL_PORT_OPEN_FAILED,
  USB_DEVICE_OPEN_FAILED,
  USB_CHIP_SETUP_FAILED,
];

// Wrap a transport failure in a sentence of the caller's, keeping the failure
// as the cause and, when it is one of the names above, its name too -- the
// serial bridge's re-rate and reconfigure paths reopen the port, which can
// fail exactly as the first open did.
export function wrapTransportError(message: string, cause: unknown): Error {
  const error = new Error(message, { cause });
  const name = jsErrorName(cause);
  if (PRESERVED_TRANSPORT_FAILURES.includes(name)) {
    error.name = name;
  }
  return error;
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

// A chooser the browser refused because the click's user activation (about
// five seconds in Chrome) had lapsed. A permissions policy refuses with the
// same SecurityError, so the bridge tells them apart by navigator.userActivation
// (BrowserSerialBridge._requestPort in web/js/serial.ts) and renames this one,
// which analytics would otherwise count as a denied permission
// (WEBCHIRP-FRONTEND-1W).
export const USER_GESTURE_REQUIRED = "UserGestureRequiredError";

// Rename the browser's refusal, keeping it as the cause and its sentence in
// the message, since the debug panel prints the message and not the cause.
export function createUserGestureRequiredError(cause: unknown): Error {
  const { name, message } = errorFields(cause);
  const error = new Error(
    "The browser shows its port chooser only straight after a click, and this one was asked for too late. "
      + `Press Connect again. (${name}: ${message})`,
    { cause },
  );
  error.name = USER_GESTURE_REQUIRED;
  return error;
}

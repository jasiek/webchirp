// The browser's serial bridge: the shared SerialBridge (web/js/serial-bridge.mjs)
// plus the one thing only a browser has, a chooser. It decides which provider
// a connect goes through -- native Web Serial, the WebUSB drivers
// (web/js/webusb-serial.js) or Web Bluetooth (web/js/webbluetooth-serial.js) --
// shows that provider's chooser, and hands the bridge a port that satisfies
// the transport contract (web/js/serial-transport.mjs). Native ports are the
// browser's own objects, so they are wrapped (web/js/native-serial-port.js)
// rather than modified.
import { createPortSelectionCancelledError, createSerialUnsupportedError } from "./serial-errors.js";
import { NativeSerialPort } from "./native-serial-port.js";
import { SerialBridge } from "./serial-bridge.mjs";
import { createWebUsbSerial } from "./webusb-serial.js";
import { createWebBluetoothSerial } from "./webbluetooth-serial.js";

/** @typedef {import("./serial-transport.mjs").SerialTransport} SerialTransport */

/**
 * Something with a chooser: navigator.serial, or one of the WebUSB and Web
 * Bluetooth providers, which mirror its requestPort().
 * @typedef {{requestPort(options?: object): Promise<SerialPort|SerialTransport>}} PortProvider
 */

function hasNativeSerial() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

// The browser's own Web Serial object, or undefined where there is none. Read
// once by the provider choice below, so the object it checks is the one it uses.
/** @returns {Serial|undefined} */
function nativeSerial() {
  return typeof navigator !== "undefined" ? navigator.serial : undefined;
}

function hasWebUsb() {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

// Check the actual chooser API so unsupported platforms never offer BLE.
function hasWebBluetooth() {
  return typeof navigator !== "undefined"
    && typeof navigator.bluetooth?.requestDevice === "function";
}

export class BrowserSerialBridge extends SerialBridge {
  /**
   * @param {{createWebUsbSerial?: () => PortProvider,
   *   createWebBluetoothSerial?: () => PortProvider}} [options]  Test seams
   *   for the two providers this module would otherwise build itself.
   */
  constructor({ createWebUsbSerial: createWebUsbSerialImpl,
    createWebBluetoothSerial: createWebBluetoothSerialImpl } = {}) {
    super();
    // The resolved native, USB, or Bluetooth provider, set on connect. Each
    // offers requestPort(); this.transport names which one it is.
    /** @type {PortProvider|null} */
    this.serial = null;
    // Which transport open() should use: "auto" (native preferred), "webserial",
    // "webusb", or "webbluetooth". Forcing "webusb" is needed where native Web Serial exists but
    // cannot drive the adapter (e.g. FTDI cables on Chrome for Android).
    this.preferredTransport = "auto";
    this._createWebUsbSerial = createWebUsbSerialImpl || createWebUsbSerial;
    this._createWebBluetoothSerial = createWebBluetoothSerialImpl || createWebBluetoothSerial;
  }

  // Choose the transport open() will use. Resets any cached provider while
  // disconnected so the next connect re-resolves against the new preference.
  /** @param {string} transport  "auto", "webserial", "webusb" or "webbluetooth". */
  setPreferredTransport(transport) {
    this.preferredTransport =
      ["webusb", "webserial", "webbluetooth"].includes(transport) ? transport : "auto";
    if (!this.port) {
      this.serial = null;
      this.transport = "";
    }
  }

  isSupported() {
    return hasNativeSerial() || hasWebUsb() || hasWebBluetooth();
  }

  // Report what serial transport(s) this browser can offer.
  /** @returns {{supported: boolean, native: boolean, webusb: boolean, webbluetooth: boolean}} */
  getCapability() {
    const native = hasNativeSerial();
    const webusb = hasWebUsb();
    const webbluetooth = hasWebBluetooth();
    return { supported: native || webusb || webbluetooth, native, webusb, webbluetooth };
  }

  // Resolve the serial provider: prefer native Web Serial, otherwise fall back
  // to the WebUSB chip-aware provider. Cached after the first call.
  /** @returns {Promise<PortProvider>} */
  async _ensureSerial() {
    if (this.serial) {
      return this.serial;
    }
    if (this.preferredTransport === "webbluetooth") {
      if (!hasWebBluetooth()) {
        throw createSerialUnsupportedError("Web Bluetooth is not supported in this browser.");
      }
      this.serial = this._createWebBluetoothSerial();
      this.transport = "webbluetooth";
      return this.serial;
    }
    if (this.preferredTransport === "webusb") {
      if (!hasWebUsb()) {
        throw createSerialUnsupportedError("WebUSB is not supported in this browser.");
      }
      this.serial = this._createWebUsbSerial();
      this.transport = "webusb";
      return this.serial;
    }
    if (this.preferredTransport === "webserial") {
      const native = nativeSerial();
      if (!native) {
        throw createSerialUnsupportedError("Native Web Serial is not supported in this browser.");
      }
      this.serial = native;
      this.transport = "webserial";
      return native;
    }
    // Auto: prefer native Web Serial, fall back to the WebUSB chip-aware provider.
    const native = nativeSerial();
    if (native) {
      this.serial = native;
      this.transport = "webserial";
      return native;
    }
    if (hasWebUsb()) {
      this.serial = this._createWebUsbSerial();
      this.transport = "webusb";
      return this.serial;
    }
    throw createSerialUnsupportedError("Neither Web Serial nor WebUSB is supported in this browser.");
  }

  // Show the browser's chooser and return the port the user picked. Both
  // providers reject with NotFoundError when the chooser is dismissed without a
  // selection ("No port selected by the user." on native Web Serial, "No device
  // selected." on WebUSB); translate that one case into an error the UI can
  // recognise as a cancellation. Everything else the chooser can raise -- a
  // SecurityError outside a user gesture, a NotAllowedError from a permissions
  // policy -- is a real failure and passes through untouched.
  //
  // This sits apart from the open() body on purpose: only the chooser
  // produces NotFoundError, so translating inside the wider try would risk
  // relabelling a later failure as a user cancellation.
  /**
   * @param {PortProvider} serial
   * @returns {Promise<SerialPort|SerialTransport>}
   */
  async _requestPort(serial) {
    try {
      return await serial.requestPort({});
    } catch (error) {
      if (error?.name === "NotFoundError") {
        throw createPortSelectionCancelledError();
      }
      throw error;
    }
  }

  // The bridge's transport factory: resolve the provider, show its chooser,
  // and wrap a native SerialPort so it meets the contract like every other
  // port does. Its loss events arrive on navigator.serial, the provider.
  /**
   * @override
   * @returns {Promise<SerialTransport>}
   */
  async requestTransport() {
    const serial = await this._ensureSerial();
    const port = await this._requestPort(serial);
    // Only navigator.serial hands back a bare SerialPort; the WebUSB and Web
    // Bluetooth providers already return contract ports.
    if (this.transport === "webserial") {
      return new NativeSerialPort(/** @type {SerialPort} */ (port), {
        events: /** @type {Serial} */ (serial),
      });
    }
    return /** @type {SerialTransport} */ (port);
  }
}

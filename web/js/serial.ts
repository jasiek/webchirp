// The browser's serial bridge: the shared SerialBridge (web/js/serial-bridge.ts)
// plus the one thing only a browser has, a chooser. It decides which provider
// a connect goes through -- native Web Serial, the WebUSB drivers
// (web/js/webusb-serial.ts) or Web Bluetooth (web/js/webbluetooth-serial.ts) --
// shows that provider's chooser, and hands the bridge a port that satisfies
// the transport contract (web/js/serial-transport.ts). Native ports are the
// browser's own objects, so they are wrapped (web/js/native-serial-port.ts)
// rather than modified.
import {
  createPortSelectionCancelledError,
  createSerialUnsupportedError,
  createUserGestureRequiredError,
} from "./serial-errors.ts";
import { NativeSerialPort } from "./native-serial-port.ts";
import { SerialBridge } from "./serial-bridge.ts";
import { chipFamilyOf, createWebUsbSerial } from "./webusb-serial.ts";
import { createWebBluetoothSerial } from "./webbluetooth-serial.ts";
import type { SerialTransport } from "./serial-transport.ts";
import { errorFields } from "./error-details.ts";

/**
 * Something with a chooser: navigator.serial, or one of the WebUSB and Web
 * Bluetooth providers, which mirror its requestPort().
 */
export type PortProvider = {requestPort(options?: object): Promise<SerialPort | SerialTransport>};

function hasNativeSerial() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

// The browser's own Web Serial object, or undefined where there is none. Read
// once by the provider choice below, so the object it checks is the one it uses.
function nativeSerial(): Serial | undefined {
  return typeof navigator !== "undefined" ? navigator.serial : undefined;
}

function hasWebUsb() {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

// What the UI may say about the port the chooser picked, before and after the
// open: the transport it will go over and the cable behind it. Everything
// here names a kind of adapter, never a particular one -- the failure metric
// carries it (web/js/ui/serial-actions.ts), and metrics send nothing that
// could identify a user.
export interface ChosenPortDescription {
  /** The transport name the port reports ("webserial", "webusb", "webbluetooth"). */
  transport: string;
  /** The chip family (chipFamilyOf), "cdc" for a WebUSB port none of the chip drivers took, "none" for a port with no USB identity. */
  chip: string;
  usbVendorId: string | null;
  usbProductId: string | null;
}

// Check the actual chooser API so unsupported platforms never offer BLE.
function hasWebBluetooth() {
  return typeof navigator !== "undefined"
    && typeof navigator.bluetooth?.requestDevice === "function";
}

export class BrowserSerialBridge extends SerialBridge {
  serial: PortProvider | null;
  preferredTransport: string;
  _chosenTransport: SerialTransport | null;
  _createWebUsbSerial: () => PortProvider;
  _createWebBluetoothSerial: () => PortProvider;

  /**
   * @param options Test seams
   *   for the two providers this module would otherwise build itself.
   */
  constructor({ createWebUsbSerial: createWebUsbSerialImpl,
    createWebBluetoothSerial: createWebBluetoothSerialImpl }: {
    createWebUsbSerial?: () => PortProvider;
    createWebBluetoothSerial?: () => PortProvider;
  } = {}) {
    super();
    // The resolved native, USB, or Bluetooth provider, set on connect. Each
    // offers requestPort(); this.transport names which one it is.
    this.serial = null;
    // Which transport open() should use: "auto" (native preferred), "webserial",
    // "webusb", or "webbluetooth". Forcing "webusb" is needed where native Web Serial exists but
    // cannot drive the adapter (e.g. FTDI cables on Chrome for Android).
    this.preferredTransport = "auto";
    // The port choosePort() picked, held unopened for the next open().
    this._chosenTransport = null;
    this._createWebUsbSerial = createWebUsbSerialImpl || createWebUsbSerial;
    this._createWebBluetoothSerial = createWebBluetoothSerialImpl || createWebBluetoothSerial;
  }

  // Choose the transport open() will use. Resets any cached provider while
  // disconnected so the next connect re-resolves against the new preference.
  /** @param transport "auto", "webserial", "webusb" or "webbluetooth". */
  setPreferredTransport(transport: string) {
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
  getCapability(): { supported: boolean; native: boolean; webusb: boolean; webbluetooth: boolean } {
    const native = hasNativeSerial();
    const webusb = hasWebUsb();
    const webbluetooth = hasWebBluetooth();
    return { supported: native || webusb || webbluetooth, native, webusb, webbluetooth };
  }

  // Resolve the serial provider: prefer native Web Serial, otherwise fall back
  // to the WebUSB chip-aware provider. Cached after the first call.
  // Synchronous, so choosePort() reaches the chooser before its first await.
  _ensureSerial(): PortProvider {
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
  // recognise as a cancellation, and a SecurityError raised while the page had
  // no user activation into a UserGestureRequiredError. Everything else the
  // chooser can raise -- a permissions-policy refusal -- is a real failure and
  // passes through untouched, as does every SecurityError in a browser without
  // navigator.userActivation.
  //
  // This sits apart from the open() body on purpose: only the chooser
  // produces NotFoundError, so translating inside the wider try would risk
  // relabelling a later failure as a user cancellation.
  async _requestPort(serial: PortProvider): Promise<SerialPort | SerialTransport> {
    const activationLapsed = typeof navigator !== "undefined" && navigator.userActivation?.isActive === false;
    try {
      return await serial.requestPort({});
    } catch (error) {
      const { name } = errorFields(error);
      if (name === "NotFoundError") {
        throw createPortSelectionCancelledError();
      }
      if (name === "SecurityError" && activationLapsed) {
        throw createUserGestureRequiredError(error);
      }
      throw error;
    }
  }

  // Show the chooser for transport ("auto", "webserial", "webusb" or
  // "webbluetooth") and hold the port picked for the next open(). The UI calls
  // this from the Connect click itself: the browser shows a chooser only for
  // about five seconds after a click, and the open() that follows can wait
  // longer than that on the runtime call queue (WEBCHIRP-FRONTEND-1W). Rejects
  // as the chooser does. A live port is left alone, as open() would reuse it.
  async choosePort(transport: string): Promise<void> {
    this._chosenTransport = null;
    if (this.port && this.writer) {
      return;
    }
    this.setPreferredTransport(transport);
    this._chosenTransport = await this._chooseTransport();
  }

  // Describe the port choosePort() picked -- or, once open() has taken it, the
  // live port -- for the connect's metric: which transport it goes over and
  // which cable is behind it. null when nothing has been chosen, as after a
  // dismissed chooser. Read by the UI between choosePort() and the open, so a
  // failed open can still say which cable it failed on.
  describeChosenPort(): ChosenPortDescription | null {
    const port = this._chosenTransport || this.port;
    if (!port) {
      return null;
    }
    const identity = this._getPortIdentity(port);
    const info = port.getInfo?.() || {};
    const family = chipFamilyOf({ vendorId: info.usbVendorId, productId: info.usbProductId });
    let chip = family;
    if (!chip) {
      // WebUSB hands a device none of the chip drivers claim to the CDC
      // polyfill; a native or Bluetooth port without USB ids has no chip to
      // name, and one with ids this app has no driver for is "other".
      chip = port.transport === "webusb" ? "cdc" : (identity.usbVendorId ? "other" : "none");
    }
    return {
      transport: port.transport,
      chip,
      usbVendorId: identity.usbVendorId,
      usbProductId: identity.usbProductId,
    };
  }

  // The bridge's transport factory: the port choosePort() picked, once, or --
  // for a caller that opens without choosing first -- the chooser itself.
  override async requestTransport(): Promise<SerialTransport> {
    const chosen = this._chosenTransport;
    this._chosenTransport = null;
    return chosen || this._chooseTransport();
  }

  // Resolve the provider, show its chooser, and wrap a native SerialPort so it
  // meets the contract like every other port does. Its loss events arrive on
  // navigator.serial, the provider. Nothing before the chooser call awaits.
  async _chooseTransport(): Promise<SerialTransport> {
    const serial = this._ensureSerial();
    const port = await this._requestPort(serial);
    // Only navigator.serial hands back a bare SerialPort; the WebUSB and Web
    // Bluetooth providers already return contract ports.
    if (this.transport === "webserial") {
      return new NativeSerialPort(port as SerialPort, {
        events: serial as Serial,
      });
    }
    return port as SerialTransport;
  }
}

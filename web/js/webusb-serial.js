// A Web Serial-shaped provider (`requestPort`) backed by WebUSB, for browsers
// that expose WebUSB but not Web Serial (e.g. Chrome on Android). A single
// device chooser is shown; the chosen device is then dispatched to a chip
// specific driver:
//   - FTDI adapters (FT231X, FT232R, ...) -> native FTDI-over-WebUSB driver.
//   - Prolific PL2303 adapters (HX/TA/TB/HXN) -> native PL2303-over-WebUSB driver.
//   - WCH CH340/CH341 adapters -> native CH340-over-WebUSB driver.
//   - Silicon Labs single-UART CP210x adapters (CP2101/2/3/4/9, CP2102N) ->
//     native CP2102-over-WebUSB driver. Its predicate declines the multi-UART
//     and non-UART parts, and declines anything enumerating as CDC (the
//     CP2102C), so those fall through to the polyfill below rather than being
//     configured with the vendor register map.
//   - Everything else -> Google's web-serial-polyfill, which handles USB
//     CDC-ACM devices and reports a clear error for anything it cannot drive.
import { CH340_DEVICE_IDS, Ch340SerialPort, isCh340Device } from "./ch340-webusb.js";
import { CP210X_VENDOR_ID, Cp2102SerialPort, isCp2102Device } from "./cp2102-webusb.js";
import { FTDI_VENDOR_ID, FtdiSerialPort, isFtdiDevice } from "./ftdi-webusb.js";
import { PROLIFIC_VENDOR_ID, Pl2303SerialPort, isProlificDevice } from "./pl2303-webusb.js";
import { WebUsbTransport } from "./webusb-transport.js";

/** @typedef {import("./serial-transport.mjs").SerialTransport} SerialTransport */

const WEB_SERIAL_POLYFILL_URL =
  "https://cdn.jsdelivr.net/npm/web-serial-polyfill@1.0.15/+esm";

// Single source of truth for user-facing "what can WebUSB drive" text; update
// alongside USB_DEVICE_FILTERS / the dispatch below when adding chip drivers.
export const WEBUSB_SUPPORTED_ADAPTERS =
  "FTDI (FT231X/FT232R, etc.), Prolific PL2303 (HX/TA/TB/HXN), "
  + "WCH CH340/CH341, Silicon Labs CP2102 (single-UART CP210x), "
  + "and USB CDC-ACM devices";

// WebUSB only lists devices that match a filter — an empty filter list shows an
// EMPTY chooser. So we filter to the adapters we can actually drive: FTDI,
// Prolific and Silicon Labs by vendor id, CH340/CH341 by exact vendor/product
// pair (WCH's vendor id also covers CDC parts and non-serial chips), and USB
// CDC by interface class (control class 0x02 / data 0x0a).
const USB_DEVICE_FILTERS = [
  { vendorId: FTDI_VENDOR_ID },
  { vendorId: PROLIFIC_VENDOR_ID },
  { vendorId: CP210X_VENDOR_ID },
  ...CH340_DEVICE_IDS,
  { classCode: 0x02 },
  { classCode: 0x0a },
];

// Lazily import the CDC polyfill's SerialPort class only when a non-FTDI device
// is chosen, so the FTDI path never depends on the CDN.
/** @returns {Promise<new (device: USBDevice) => SerialPort>} */
async function defaultLoadCdcSerialPort() {
  const mod = await import(WEB_SERIAL_POLYFILL_URL);
  return mod.SerialPort;
}

// What the polyfill can do: it sends open()'s framing in SET_LINE_CODING and
// SET_CONTROL_LINE_STATE for DTR/RTS, and like Web Serial it changes settings
// only through close() and open().
/** @type {Readonly<import("./serial-transport.mjs").SerialTransportCapabilities>} */
export const CDC_CAPABILITIES = Object.freeze({
  framing: true,
  signals: true,
  reconfigure: "reopen",
});

// The CDC polyfill's SerialPort, wrapped to the transport contract
// (web/js/serial-transport.mjs). The polyfill is a CDN module we do not
// modify, and it keeps its USBDevice private; the device is the one the
// chooser just returned, so the wrapper holds it in the open and the bridge
// matches a loss by device identity instead of by vendor and product id,
// which could not tell two identical adapters apart.
/** @implements {SerialTransport} */
export class CdcSerialPort extends WebUsbTransport {
  /**
   * @param {SerialPort} polyfillPort  web-serial-polyfill's SerialPort, which
   *   mirrors Web Serial's.
   * @param {USBDevice} device  The device the polyfill port drives.
   * @param {import("./webusb-transport.js").WebUsbTransportOptions} [options]
   */
  constructor(polyfillPort, device, options = {}) {
    super(device, options);
    this.polyfillPort = polyfillPort;
    /** @type {(() => Promise<SerialInputSignals>)|undefined} */
    this.getSignals = undefined;
    // Input lines, for the loopback page, exactly when the polyfill has them.
    if (typeof polyfillPort.getSignals === "function") {
      this.getSignals = () => polyfillPort.getSignals();
    }
  }

  // The polyfill honours framing, unlike the chip drivers.
  /**
   * @override
   * @returns {Readonly<import("./serial-transport.mjs").SerialTransportCapabilities>}
   */
  get capabilities() {
    return CDC_CAPABILITIES;
  }

  // The polyfill replaces its streams on every open(), so they are read
  // through rather than copied.
  get readable() {
    return this.polyfillPort.readable ?? null;
  }

  get writable() {
    return this.polyfillPort.writable ?? null;
  }

  // Open the polyfill port, then start reporting the device's loss.
  /** @param {import("./serial-transport.mjs").SerialOpenOptions} options */
  async open(options) {
    await this.polyfillPort.open(options);
    this._watchDisconnect();
  }

  // Stop reporting loss first, so an intentional close is never one.
  async close() {
    this._unwatchDisconnect();
    await this.polyfillPort.close();
  }

  // DTR/RTS go straight to the polyfill's SET_CONTROL_LINE_STATE.
  /** @param {import("./serial-transport.mjs").SerialSignals} signals */
  async setSignals(signals) {
    await this.polyfillPort.setSignals(signals);
  }
}

// usb is the WebUSB loss-event source every port it returns watches
// (navigator.usb when omitted); tests pass a stand-in.
/**
 * @param {{loadCdcSerialPort?: () => Promise<new (device: USBDevice) => SerialPort>,
 *   usb?: EventTarget|null}} [options]  loadCdcSerialPort: where the CDC
 *   polyfill's SerialPort class comes from (the CDN by default).
 * @returns {{requestPort(): Promise<SerialTransport>}}
 */
export function createWebUsbSerial({ loadCdcSerialPort, usb } = {}) {
  const loadCdc = loadCdcSerialPort || defaultLoadCdcSerialPort;

  return {
    async requestPort() {
      const device = await navigator.usb.requestDevice({ filters: USB_DEVICE_FILTERS });
      if (isFtdiDevice(device)) {
        return new FtdiSerialPort(device, { usb });
      }
      if (isProlificDevice(device)) {
        return new Pl2303SerialPort(device, { usb });
      }
      if (isCh340Device(device)) {
        return new Ch340SerialPort(device, { usb });
      }
      if (isCp2102Device(device)) {
        return new Cp2102SerialPort(device, { usb });
      }
      const PolyfillSerialPort = await loadCdc();
      return new CdcSerialPort(new PolyfillSerialPort(device), device, { usb });
    },
  };
}

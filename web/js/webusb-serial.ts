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
import { CH340_DEVICE_IDS, Ch340SerialPort, isCh340Device } from "./ch340-webusb.ts";
import { CP210X_VENDOR_ID, Cp2102SerialPort, isCp2102Device } from "./cp2102-webusb.ts";
import { FTDI_VENDOR_ID, FtdiSerialPort, isFtdiDevice } from "./ftdi-webusb.ts";
import { PROLIFIC_VENDOR_ID, Pl2303SerialPort, isProlificDevice } from "./pl2303-webusb.ts";
import { WebUsbTransport } from "./webusb-transport.ts";
import { WEB_SERIAL_POLYFILL_URL } from "./cdn-urls.ts";
import type { SerialOpenOptions, SerialSignals, SerialTransport, SerialTransportCapabilities } from "./serial-transport.ts";
import type { WebUsbTransportOptions } from "./webusb-transport.ts";

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
async function defaultLoadCdcSerialPort(): Promise<new (device: USBDevice) => SerialPort> {
  const mod = await import(WEB_SERIAL_POLYFILL_URL);
  return mod.SerialPort;
}

// What the polyfill can do: it sends open()'s framing in SET_LINE_CODING and
// SET_CONTROL_LINE_STATE for DTR/RTS, and like Web Serial it changes settings
// only through close() and open().
export const CDC_CAPABILITIES: Readonly<SerialTransportCapabilities> = Object.freeze({
  framing: true,
  signals: true,
  reconfigure: "reopen",
});

// The CDC polyfill's SerialPort, wrapped to the transport contract
// (web/js/serial-transport.ts). The polyfill is a CDN module we do not
// modify, and it keeps its USBDevice private; the device is the one the
// chooser just returned, so the wrapper holds it in the open and the bridge
// matches a loss by device identity instead of by vendor and product id,
// which could not tell two identical adapters apart.
export class CdcSerialPort extends WebUsbTransport implements SerialTransport {
  polyfillPort: SerialPort;
  getSignals: (() => Promise<SerialInputSignals>) | undefined;

  /**
   * @param polyfillPort web-serial-polyfill's SerialPort, which
   *   mirrors Web Serial's.
   * @param device The device the polyfill port drives.
   */
  constructor(polyfillPort: SerialPort, device: USBDevice, options: WebUsbTransportOptions = {}) {
    super(device, options);
    this.polyfillPort = polyfillPort;
    this.getSignals = undefined;
    // Input lines, for the loopback page, exactly when the polyfill has them.
    if (typeof polyfillPort.getSignals === "function") {
      this.getSignals = () => polyfillPort.getSignals();
    }
  }

  // The polyfill honours framing, unlike the chip drivers.
  override get capabilities(): Readonly<SerialTransportCapabilities> {
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
  async open(options: SerialOpenOptions) {
    await this.polyfillPort.open(options);
    this._watchDisconnect();
  }

  // Stop reporting loss first, so an intentional close is never one.
  async close() {
    this._unwatchDisconnect();
    await this.polyfillPort.close();
  }

  // DTR/RTS go straight to the polyfill's SET_CONTROL_LINE_STATE.
  async setSignals(signals: SerialSignals) {
    await this.polyfillPort.setSignals(signals);
  }
}

// usb is the WebUSB loss-event source every port it returns watches
// (navigator.usb when omitted); tests pass a stand-in.
/**
 * @param options loadCdcSerialPort: where the CDC
 *   polyfill's SerialPort class comes from (the CDN by default).
 */
export function createWebUsbSerial({ loadCdcSerialPort, usb }: {
  loadCdcSerialPort?: () => Promise<new (device: USBDevice) => SerialPort>;
  usb?: EventTarget | null;
} = {}): { requestPort(): Promise<SerialTransport> } {
  const loadCdc = loadCdcSerialPort || defaultLoadCdcSerialPort;

  return {
    async requestPort() {
      if (!navigator.usb) {
        throw new Error("WebUSB is not available in this browser.");
      }
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

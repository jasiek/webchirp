// A Web Serial-shaped provider (`requestPort`) backed by WebUSB, for browsers
// that expose WebUSB but not Web Serial (e.g. Chrome on Android). A single
// device chooser is shown; the chosen device is then dispatched to a chip
// specific driver:
//   - FTDI adapters (FT231X, FT232R, ...) -> native FTDI-over-WebUSB driver.
//   - Prolific PL2303 adapters (HX/TA/TB/HXN) -> native PL2303-over-WebUSB driver.
//   - WCH CH340/CH341 adapters -> native CH340-over-WebUSB driver.
//   - Everything else -> Google's web-serial-polyfill, which handles USB
//     CDC-ACM devices and reports a clear error for anything it cannot drive.
import { CH340_DEVICE_IDS, Ch340SerialPort, isCh340Device } from "./ch340-webusb.js";
import { FTDI_VENDOR_ID, FtdiSerialPort, isFtdiDevice } from "./ftdi-webusb.js";
import { PROLIFIC_VENDOR_ID, Pl2303SerialPort, isProlificDevice } from "./pl2303-webusb.js";

const WEB_SERIAL_POLYFILL_URL =
  "https://cdn.jsdelivr.net/npm/web-serial-polyfill@1.0.15/+esm";

// Single source of truth for user-facing "what can WebUSB drive" text; update
// alongside USB_DEVICE_FILTERS / the dispatch below when adding chip drivers.
export const WEBUSB_SUPPORTED_ADAPTERS =
  "FTDI (FT231X/FT232R, etc.), Prolific PL2303 (HX/TA/TB/HXN), "
  + "WCH CH340/CH341, and USB CDC-ACM devices";
export const WEBUSB_UNSUPPORTED_ADAPTERS = "CP2102";

// WebUSB only lists devices that match a filter — an empty filter list shows an
// EMPTY chooser. So we filter to the adapters we can actually drive: FTDI and
// Prolific by vendor id, CH340/CH341 by exact vendor/product pair (WCH's vendor
// id also covers CDC parts and non-serial chips), and USB CDC by interface
// class (control class 0x02 / data 0x0a).
const USB_DEVICE_FILTERS = [
  { vendorId: FTDI_VENDOR_ID },
  { vendorId: PROLIFIC_VENDOR_ID },
  ...CH340_DEVICE_IDS,
  { classCode: 0x02 },
  { classCode: 0x0a },
];

// Lazily import the CDC polyfill's SerialPort class only when a non-FTDI device
// is chosen, so the FTDI path never depends on the CDN.
async function defaultLoadCdcSerialPort() {
  const mod = await import(WEB_SERIAL_POLYFILL_URL);
  return mod.SerialPort;
}

export function createWebUsbSerial({ loadCdcSerialPort } = {}) {
  const loadCdc = loadCdcSerialPort || defaultLoadCdcSerialPort;

  return {
    async requestPort() {
      const device = await navigator.usb.requestDevice({ filters: USB_DEVICE_FILTERS });
      if (isFtdiDevice(device)) {
        return new FtdiSerialPort(device);
      }
      if (isProlificDevice(device)) {
        return new Pl2303SerialPort(device);
      }
      if (isCh340Device(device)) {
        return new Ch340SerialPort(device);
      }
      const CdcSerialPort = await loadCdc();
      return new CdcSerialPort(device);
    },
  };
}

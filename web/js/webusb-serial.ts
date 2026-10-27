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
import { errorFields } from "./error-details.ts";
import { createUsbInterfaceBusyError } from "./serial-errors.ts";
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

// What the polyfill can do, read from the pinned version's source
// (web-serial-polyfill 1.0.15, dist/serial.js): open() validates
// dataBits/stopBits/parity against Web Serial's values and sends them in
// SET_LINE_CODING with the CDC encodings (bCharFormat 0/2, bParityType
// 0/1/2), failing the open when the device refuses it; setSignals() sends
// DTR/RTS in SET_CONTROL_LINE_STATE. The polyfill also has an in-place
// reconfigure(), but the wrapper does not forward it, so a change goes
// through close() and open() as on Web Serial. tests/e2e/web-serial-polyfill.mjs
// loads the CDN module and holds it to this; whether an adapter's firmware
// honours the line coding is unmeasured.
export const CDC_CAPABILITIES: Readonly<SerialTransportCapabilities> = Object.freeze({
  framing: true,
  signals: true,
  reconfigure: "reopen",
});

// How long open() waits before each retry of a refused interface claim.
// Android releases a closed device's claim asynchronously, so a reopen right
// after close() -- every baud pass of the loopback suite, every mid-clone
// re-rate or reframe (reconfigure: "reopen") -- can find the interface still
// held and be refused. Five attempts over 750 ms of waiting covered the
// alternating failures seen on a Raspberry Pi Debug Probe under Android Chrome.
export const CDC_CLAIM_RETRY_DELAYS_MS: readonly number[] = Object.freeze([50, 100, 200, 400]);

// The polyfill's open() catches every failure, closes the device and throws
// new Error("Error setting up device: " + error.toString()), so the
// DOMException's name survives only as text. Matching that text is the one
// way to tell WebUSB's claim refusal (a NetworkError from claimInterface)
// from a line-coding or configuration failure; nothing else here classifies
// by message.
function isPolyfillClaimRefusal(error: unknown): boolean {
  const message = String(errorFields(error).message ?? error);
  return /NetworkError/.test(message) && /claim ?interface/i.test(message);
}

// Resolve after ms milliseconds; the default pause between claim retries.
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CdcSerialPortOptions extends WebUsbTransportOptions {
  /** Waits between claim retries; tests pass one that does not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

// The CDC polyfill's SerialPort, wrapped to the transport contract
// (web/js/serial-transport.ts). The polyfill is a CDN module we do not
// modify, and it keeps its USBDevice private; the device is the one the
// chooser just returned, so the wrapper holds it in the open and the bridge
// matches a loss by device identity instead of by vendor and product id,
// which could not tell two identical adapters apart.
export class CdcSerialPort extends WebUsbTransport implements SerialTransport {
  polyfillPort: SerialPort;
  getSignals: (() => Promise<SerialInputSignals>) | undefined;
  _sleep: (ms: number) => Promise<void>;

  /**
   * @param polyfillPort web-serial-polyfill's SerialPort, which
   *   mirrors Web Serial's.
   * @param device The device the polyfill port drives.
   */
  constructor(polyfillPort: SerialPort, device: USBDevice, options: CdcSerialPortOptions = {}) {
    super(device, { usb: options.usb });
    this.polyfillPort = polyfillPort;
    this._sleep = options.sleep ?? defaultSleep;
    this.getSignals = undefined;
    // Input lines, for the loopback page, exactly when the polyfill has them.
    if (typeof polyfillPort.getSignals === "function") {
      this.getSignals = () => polyfillPort.getSignals();
    }
  }

  // The polyfill sends the frame in SET_LINE_CODING (CDC_CAPABILITIES).
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

  // Open the polyfill port, then start reporting the device's loss. A claim
  // refusal is retried after each of CDC_CLAIM_RETRY_DELAYS_MS (the polyfill
  // has already closed the device again), because right after a close it is
  // most often Android still releasing the previous claim; once the retries
  // run out it is the named busy-interface error the chip drivers throw.
  // Any other failure is thrown at once, and deliberately unnamed: the
  // polyfill folds the device open, the configuration and the line coding
  // into one "Error setting up device: ..." sentence, so naming it as either
  // the device-open or the chip-setup stage would be a guess, and the metric
  // would then say the wrong stage with confidence. A CDC failure reports as
  // error_kind "other" with chip "cdc", and its sentence reaches Sentry,
  // which is where the stage can still be read.
  async open(options: SerialOpenOptions) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.polyfillPort.open(options);
        break;
      } catch (error) {
        if (!isPolyfillClaimRefusal(error)) {
          throw error;
        }
        const delay = CDC_CLAIM_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          throw createUsbInterfaceBusyError(
            `CDC: could not claim the USB interface after ${attempt + 1} attempts `
            + `(another driver may still control it): ${errorFields(error).message || error}`,
          );
        }
        await this._sleep(delay);
      }
    }
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

// The chip drivers, in the order requestPort() tries them: each knows the
// devices it drives and builds its port. One table for both the provider and
// chipFamilyOf(), so the family a metric carries for a cable is by
// construction the driver that opened it -- a fifth driver added here is
// picked and named in the same edit.
export const WEBUSB_CHIP_DRIVERS: ReadonlyArray<{
  family: string;
  matches: (device: Partial<USBDevice> | null | undefined) => boolean;
  create: (device: USBDevice, options: WebUsbTransportOptions) => SerialTransport;
}> = Object.freeze([
  { family: "ftdi", matches: isFtdiDevice, create: (device, options) => new FtdiSerialPort(device, options) },
  { family: "pl2303", matches: isProlificDevice, create: (device, options) => new Pl2303SerialPort(device, options) },
  { family: "ch340", matches: isCh340Device, create: (device, options) => new Ch340SerialPort(device, options) },
  { family: "cp2102", matches: isCp2102Device, create: (device, options) => new Cp2102SerialPort(device, options) },
]);

// The chip family behind a USB serial adapter, from its vendor and product
// ids: the driver in WEBUSB_CHIP_DRIVERS that claims them. "" for ids none
// of them claims -- a CDC device on WebUSB, or a native Web Serial port whose
// chip this app has no driver for -- and for a port with no USB ids at all (a
// Bluetooth link, a built-in UART).
export function chipFamilyOf(
  device: { vendorId?: number; productId?: number } | null | undefined,
): string {
  if (!device || !Number.isInteger(device.vendorId)) {
    return "";
  }
  return WEBUSB_CHIP_DRIVERS.find((driver) => driver.matches(device))?.family || "";
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
      const driver = WEBUSB_CHIP_DRIVERS.find((candidate) => candidate.matches(device));
      if (driver) {
        return driver.create(device, { usb });
      }
      const PolyfillSerialPort = await loadCdc();
      return new CdcSerialPort(new PolyfillSerialPort(device), device, { usb });
    },
  };
}

// The part of the serial transport contract (web/js/serial-transport.ts) that
// every WebUSB-backed port shares: the four chip drivers
// (web/js/ftdi-webusb.ts, web/js/pl2303-webusb.ts, web/js/ch340-webusb.ts,
// web/js/cp2102-webusb.ts) extend it, and the CDC polyfill wrapper in
// web/js/webusb-serial.ts does too. What differs per chip -- the protocol --
// stays in the subclass; how a WebUSB port names its device, reports its ids
// and reports its own loss is written once here.
import { errorFields } from "./error-details.ts";
import {
  createUsbDeviceOpenFailedError,
  createUsbInterfaceBusyError,
  nameUsbChipSetupFailure,
} from "./serial-errors.ts";
import { createDisconnectNotifier, watchUsbDisconnect } from "./serial-transport.ts";
import type {
  DisconnectNotifier,
  SerialDisconnectPayload,
  SerialOpenOptions,
  SerialTransport,
  SerialTransportCapabilities,
} from "./serial-transport.ts";

/** What every WebUSB port takes besides its device. */
export interface WebUsbTransportOptions {
  /**
   * Where device loss is reported;
   * navigator.usb when absent. Tests pass a stand-in, or null for none.
   */
  usb?: EventTarget | null;
}

// What a chip driver that can only program 8N1 can do: a framing change has
// to be refused rather than reopened and reported as done; a rate change goes
// through close() and open() like Web Serial's; DTR/RTS reach the chip. The
// default for a WebUSB port, so a driver claims framing only by overriding
// capabilities once it programs open()'s dataBits/stopBits/parity.
export const WEBUSB_CHIP_CAPABILITIES: Readonly<SerialTransportCapabilities> = Object.freeze({
  framing: false,
  signals: true,
  reconfigure: "reopen",
});

// What a chip driver that programs the frame open() asks for can do: the
// same, plus framing.
export const WEBUSB_FRAMING_CHIP_CAPABILITIES: Readonly<SerialTransportCapabilities> = Object.freeze({
  ...WEBUSB_CHIP_CAPABILITIES,
  framing: true,
});

/** The character frame a chip driver is asked to program, checked and defaulted. */
export interface ChipFraming {
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
}

// open()'s dataBits, stopBits and parity, each defaulted the way Web Serial
// defaults it (8, 1, "none") and checked against what the contract can ask
// for. Every chip encodes its frame from this, so a value outside the
// contract (5 data bits, mark parity, 1.5 stop bits) is refused by name here
// rather than encoded as something else: a misframed line corrupts every
// byte and the clone that fails on it names nothing.
/**
 * @param chip The prefix the errors carry ("CH340").
 */
export function resolveChipFraming(options: Partial<SerialOpenOptions>, chip: string): ChipFraming {
  const dataBits = Number(options.dataBits ?? 8);
  const stopBits = Number(options.stopBits ?? 1);
  const parity = String(options.parity ?? "none");
  if (dataBits !== 7 && dataBits !== 8) {
    throw new Error(`${chip}: cannot program ${options.dataBits} data bits (7 or 8 only)`);
  }
  if (stopBits !== 1 && stopBits !== 2) {
    throw new Error(`${chip}: cannot program ${options.stopBits} stop bits (1 or 2 only)`);
  }
  if (parity !== "none" && parity !== "even" && parity !== "odd") {
    throw new Error(`${chip}: cannot program parity "${options.parity}" (none, even or odd only)`);
  }
  return { dataBits, stopBits, parity };
}

// The frame's conventional short name ("8E1"), for error messages.
export function framingLabel({ dataBits, parity, stopBits }: ChipFraming): string {
  return `${dataBits}${parity[0].toUpperCase()}${stopBits}`;
}

// Write one chunk to a chip's bulk OUT endpoint: every byte of it, or an
// error. Shared by the four chip drivers' writable streams, because a bulk OUT
// transfer that fails does *not* reject: WebUSB resolves it with a
// USBOutTransferResult carrying `status` and `bytesWritten`. Ignoring both
// makes writer.write() report success while a protocol block went nowhere --
// an upload that silently loses a frame, surfacing later as an unrelated read
// timeout. So every transfer's status is checked, a stalled endpoint is
// cleared (so the caller's next write is not refused too) before the write
// fails, and a short write is resumed from where it stopped rather than
// assumed complete.
/**
 * @param chip The prefix the errors carry ("CH340").
 */
export async function writeBulkOut(
  device: USBDevice,
  endpointNumber: number,
  chunk: BufferSource,
  chip: string,
): Promise<void> {
  // The contract hands a Uint8Array; a caller outside it may hand any view or
  // a bare buffer. A view keeps its own window onto its buffer.
  const bytes = ArrayBuffer.isView(chunk)
    ? new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength)
    : new Uint8Array(chunk);
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.subarray(offset);
    const result = await device.transferOut(endpointNumber, remaining);
    const status = result?.status || "ok";
    if (status === "stall") {
      // Leave the endpoint usable for whatever the caller does next; the
      // write itself still fails, because the bytes are gone.
      try {
        await device.clearHalt("out", endpointNumber);
      } catch {
        // The halt may already be cleared, or the device gone.
      }
      throw new Error(
        `${chip}: bulk OUT endpoint stalled after ${offset} of ${bytes.length} bytes`,
      );
    }
    if (status !== "ok") {
      throw new Error(
        `${chip}: bulk OUT transfer failed (${status}) after ${offset} of ${bytes.length} bytes`,
      );
    }
    // An implementation that reports no count is taken at its word that an
    // "ok" transfer wrote everything it was given; Chrome always reports one.
    const written = result?.bytesWritten === undefined
      ? remaining.length
      : Number(result.bytesWritten);
    if (!(written > 0)) {
      throw new Error(
        `${chip}: bulk OUT wrote no bytes at offset ${offset} of ${bytes.length}`,
      );
    }
    offset += written;
  }
}

export class WebUsbTransport {
  device: USBDevice;
  _usbEvents: EventTarget | null | undefined;
  _lossNotifier: DisconnectNotifier;
  _stopUsbWatch: (() => void) | null;

  // usb is the event source WebUSB reports device loss on. It defaults to
  // navigator.usb, read when the port opens rather than here, so a port can be
  // constructed where no navigator exists; tests pass a stand-in. The streams
  // are the subclass's to define: the chip drivers hold their own, the CDC
  // wrapper forwards the polyfill's.
  constructor(device: USBDevice, { usb }: WebUsbTransportOptions = {}) {
    this.device = device;
    this._usbEvents = usb;
    // The subclass is the whole port; the notifier only reads its transport
    // name and hands it back as the payload's port.
    this._lossNotifier = createDisconnectNotifier(this as unknown as SerialTransport);
    this._stopUsbWatch = null;
  }

  // Every WebUSB-backed port reports as "webusb", which is also the transport
  // name the UI and analytics already use for this path.
  get transport() {
    return "webusb";
  }

  // The conservative default (8N1 only). A chip driver that programs the
  // frame overrides it, and so does the CDC wrapper, because the polyfill
  // sends the frame in SET_LINE_CODING.
  get capabilities(): Readonly<SerialTransportCapabilities> {
    return WEBUSB_CHIP_CAPABILITIES;
  }

  // The USBDevice this port drives, under the one name the contract gives it,
  // so nothing has to probe for where a port class keeps it.
  get usbDevice(): USBDevice | null {
    return this.device || null;
  }

  // Web Serial's getInfo(), answered from the device descriptor.
  getInfo(): { usbVendorId: number; usbProductId: number } {
    return {
      usbVendorId: Number(this.device.vendorId),
      usbProductId: Number(this.device.productId),
    };
  }

  // Open the USB device, the first step of every chip driver's open().
  // Chromium rejects open() with NotFoundError only when the device is gone
  // ("The device was disconnected."): unplugged after the chooser, which the
  // connect's wait in the runtime queue leaves time for. That one keeps its
  // name, so analytics counts it as a disconnect. The user's machine refusing
  // the device -- NetworkError for the OS declining to open it, SecurityError
  // for a permission it does not have -- is the named device-open failure
  // (isUsbDeviceOpenFailed), the first of the three stages a WebUSB connect
  // can fail in, which reporting drops as the native open's NetworkError is.
  // Anything else (InvalidStateError for a device already open, UnknownError)
  // keeps the browser's own name and stays reported: it may be this app's
  // doing. Every one carries the chip and the browser's sentence for the
  // debug panel.
  /**
   * @param chip The prefix the driver's own errors carry ("CH340").
   */
  async _openDevice(chip: string): Promise<void> {
    try {
      await this.device.open();
    } catch (error) {
      const { name, message } = errorFields(error);
      const sentence = `${chip}: could not open USB device: ${message || error}`;
      if (name === "NetworkError" || name === "SecurityError") {
        throw createUsbDeviceOpenFailedError(sentence, error);
      }
      const wrapped = new Error(sentence, { cause: error });
      if (typeof name === "string" && name && name !== "Error") {
        wrapped.name = name;
      }
      throw wrapped;
    }
  }

  // Run the chip's own setup -- everything a driver's open() does after the
  // device is open, from selecting the configuration to the last register
  // write before the streams start -- and name what fails in it
  // (nameUsbChipSetupFailure): the third stage of a WebUSB connect, and the
  // one this app's drivers are answerable for. Failures that already carry a
  // name, the busy-interface error and the browser's disconnect, pass through
  // as they are.
  /**
   * @param setup The driver's setup sequence; its value is returned.
   */
  async _setUpChip<T>(setup: () => Promise<T>): Promise<T> {
    try {
      return await setup();
    } catch (error) {
      throw nameUsbChipSetupFailure(error);
    }
  }

  // The device's active configuration, selecting the first one when none is
  // active yet. Shared by the four chip drivers, which all open this way.
  // WebUSB sets it once selectConfiguration() resolves; a device that still
  // has none is named here instead of failing on a null property.
  /**
   * @param chip The prefix the driver's own errors carry ("CH340").
   */
  async _activeConfiguration(chip: string): Promise<USBConfiguration> {
    if (!this.device.configuration) {
      await this.device.selectConfiguration(1);
    }
    const configuration = this.device.configuration;
    if (!configuration) {
      throw new Error(`${chip}: the USB device has no active configuration`);
    }
    return configuration;
  }

  // Claim the chip's interface. WebUSB rejects with NetworkError when another
  // driver already holds it, and only that becomes the named error reporting
  // filters (isUsbInterfaceBusy). Anything else -- NotFoundError for an
  // interface the device lacks, InvalidStateError for a device not open -- is
  // this app's mistake, so it stays a plain, reported Error.
  async _claimInterface(chip: string, interfaceNumber: number): Promise<void> {
    try {
      await this.device.claimInterface(interfaceNumber);
    } catch (error) {
      const { name, message } = errorFields(error);
      if (name === "NetworkError") {
        throw createUsbInterfaceBusyError(
          `${chip}: could not claim USB interface ${interfaceNumber} `
          + `(another driver may already control it): ${message || error}`,
        );
      }
      throw new Error(
        `${chip}: could not claim USB interface ${interfaceNumber}: ${message || error}`,
      );
    }
  }

  // Contract: register a loss callback, get its unsubscribe back.
  onDisconnect(callback: (payload: SerialDisconnectPayload) => void): () => void {
    return this._lossNotifier.subscribe(callback);
  }

  // Start reporting loss of this port's device. Called by a subclass at the
  // end of a successful open(), so a failed open never leaves a watch behind.
  _watchDisconnect() {
    this._unwatchDisconnect();
    const usbEvents = this._usbEvents === undefined
      ? globalThis.navigator?.usb
      : this._usbEvents;
    this._stopUsbWatch = watchUsbDisconnect(usbEvents, this.device, () => {
      this._unwatchDisconnect({ keepArmed: true });
      this._lossNotifier.fire();
    });
    this._lossNotifier.arm();
  }

  // Stop reporting loss. Called at the start of close(), so an intentional
  // close is never reported as one; keepArmed is for the loss path itself,
  // which drops the listener but still has to fire.
  _unwatchDisconnect({ keepArmed = false } = {}) {
    if (!keepArmed) {
      this._lossNotifier.disarm();
    }
    const stop = this._stopUsbWatch;
    this._stopUsbWatch = null;
    stop?.();
  }
}

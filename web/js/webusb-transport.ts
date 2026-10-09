// The part of the serial transport contract (web/js/serial-transport.ts) that
// every WebUSB-backed port shares: the four chip drivers
// (web/js/ftdi-webusb.ts, web/js/pl2303-webusb.ts, web/js/ch340-webusb.ts,
// web/js/cp2102-webusb.ts) extend it, and the CDC polyfill wrapper in
// web/js/webusb-serial.ts does too. What differs per chip -- the protocol --
// stays in the subclass; how a WebUSB port names its device, reports its ids
// and reports its own loss is written once here.
import { createDisconnectNotifier, watchUsbDisconnect } from "./serial-transport.ts";
import type {
  DisconnectNotifier,
  SerialDisconnectPayload,
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

// What the chip drivers can do. They program 8N1 whatever open() asks for
// (none of them reads dataBits/stopBits/parity), so a framing change has to be
// refused rather than reopened and reported as done; a rate change goes
// through close() and open() like Web Serial's; DTR/RTS reach the chip.
export const WEBUSB_CHIP_CAPABILITIES: Readonly<SerialTransportCapabilities> = Object.freeze({
  framing: false,
  signals: true,
  reconfigure: "reopen",
});

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

  // The chip default; the CDC wrapper overrides it because the polyfill does
  // honour framing.
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

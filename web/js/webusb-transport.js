// The part of the serial transport contract (web/js/serial-transport.mjs) that
// every WebUSB-backed port shares: the four chip drivers
// (web/js/ftdi-webusb.js, web/js/pl2303-webusb.js, web/js/ch340-webusb.js,
// web/js/cp2102-webusb.js) extend it, and the CDC polyfill wrapper in
// web/js/webusb-serial.js does too. What differs per chip -- the protocol --
// stays in the subclass; how a WebUSB port names its device, reports its ids
// and reports its own loss is written once here.
import { createDisconnectNotifier, watchUsbDisconnect } from "./serial-transport.mjs";

// What the chip drivers can do. They program 8N1 whatever open() asks for
// (none of them reads dataBits/stopBits/parity), so a framing change has to be
// refused rather than reopened and reported as done; a rate change goes
// through close() and open() like Web Serial's; DTR/RTS reach the chip.
export const WEBUSB_CHIP_CAPABILITIES = Object.freeze({
  framing: false,
  signals: true,
  reconfigure: "reopen",
});

export class WebUsbTransport {
  // usb is the event source WebUSB reports device loss on. It defaults to
  // navigator.usb, read when the port opens rather than here, so a port can be
  // constructed where no navigator exists; tests pass a stand-in.
  constructor(device, { usb } = {}) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this._usbEvents = usb;
    this._lossNotifier = createDisconnectNotifier(this);
    this._stopUsbWatch = null;
  }

  // Every WebUSB-backed port reports as "webusb", which is also the transport
  // name the UI and analytics already use for this path.
  get transport() {
    return "webusb";
  }

  // The chip default; the CDC wrapper overrides it because the polyfill does
  // honour framing.
  get capabilities() {
    return WEBUSB_CHIP_CAPABILITIES;
  }

  // The USBDevice this port drives, under the one name the contract gives it,
  // so nothing has to probe for where a port class keeps it.
  get usbDevice() {
    return this.device || null;
  }

  // Web Serial's getInfo(), answered from the device descriptor.
  getInfo() {
    return {
      usbVendorId: Number(this.device.vendorId),
      usbProductId: Number(this.device.productId),
    };
  }

  // Contract: register a loss callback, get its unsubscribe back.
  onDisconnect(callback) {
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

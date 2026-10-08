// Native Web Serial's SerialPort, wrapped to the transport contract
// (web/js/serial-transport.mjs). The browser's object cannot be given the
// contract's members -- and monkey-patching a platform object would hide what
// it really is -- so the bridge holds this wrapper and the wrapper holds the
// port. Everything Web Serial already does is forwarded as it is.
import { createDisconnectNotifier } from "./serial-transport.mjs";

/** @typedef {import("./serial-transport.mjs").SerialTransport} SerialTransport */
/** @typedef {import("./serial-transport.mjs").SerialTransportCapabilities} SerialTransportCapabilities */
/** @typedef {import("./serial-transport.mjs").SerialOpenOptions} SerialOpenOptions */
/** @typedef {import("./serial-transport.mjs").SerialSignals} SerialSignals */

// What native Web Serial can do: the OS driver honours open()'s framing and
// DTR/RTS, and the only way to change settings is close() then open() on the
// same port, which keeps the user's permission and needs no second chooser.
/** @type {Readonly<SerialTransportCapabilities>} */
export const NATIVE_SERIAL_CAPABILITIES = Object.freeze({
  framing: true,
  signals: true,
  reconfigure: "reopen",
});

/** @implements {SerialTransport} */
export class NativeSerialPort {
  // events is where the browser reports the port's loss: Web Serial fires
  // "disconnect" at the SerialPort itself and bubbles it to navigator.serial,
  // so watching navigator.serial (the default, read now because the chooser
  // that produced the port has just run) and matching the event's target
  // catches it. Tests pass a stand-in.
  /**
   * @param {SerialPort} port  The browser's port, from requestPort().
   * @param {{events?: EventTarget|null}} [options]
   */
  constructor(port, { events = globalThis.navigator?.serial ?? null } = {}) {
    this.nativePort = port;
    this._events = events;
    this._lossNotifier = createDisconnectNotifier(this);
    /** @type {(() => void)|null} */
    this._stopWatch = null;
    /** @type {(() => Promise<SerialInputSignals>)|undefined} */
    this.getSignals = undefined;
    // Input lines, for the loopback page, exactly when the browser has them.
    if (typeof port.getSignals === "function") {
      this.getSignals = () => port.getSignals();
    }
  }

  get transport() {
    return "webserial";
  }

  /** @returns {Readonly<SerialTransportCapabilities>} */
  get capabilities() {
    return NATIVE_SERIAL_CAPABILITIES;
  }

  // The OS owns the device; Web Serial exposes no USBDevice.
  /** @returns {null} */
  get usbDevice() {
    return null;
  }

  // Web Serial replaces the streams on every open(), so they are read through.
  get readable() {
    return this.nativePort.readable ?? null;
  }

  get writable() {
    return this.nativePort.writable ?? null;
  }

  // Web Serial's own identity of the port, where it has one.
  /** @returns {SerialPortInfo} */
  getInfo() {
    return this.nativePort.getInfo?.() || {};
  }

  // Open the native port, then start reporting its loss.
  /** @param {SerialOpenOptions} options */
  async open(options) {
    await this.nativePort.open(options);
    this._watch();
  }

  // Stop reporting loss first, so an intentional close is never one.
  async close() {
    this._unwatch();
    await this.nativePort.close();
  }

  // Forwarded as it is: native Web Serial reaches DTR/RTS.
  /** @param {SerialSignals} signals */
  async setSignals(signals) {
    await this.nativePort.setSignals(signals);
  }

  // Contract: register a loss callback, get its unsubscribe back.
  /** @type {SerialTransport["onDisconnect"]} */
  onDisconnect(callback) {
    return this._lossNotifier.subscribe(callback);
  }

  // Listen for this port's "disconnect" and turn it into one contract report.
  // The event names the port as its target; another port going away is
  // someone else's.
  _watch() {
    this._unwatch();
    const events = this._events;
    if (events && typeof events.addEventListener === "function") {
      /** @param {Event} event */
      const handler = (event) => {
        if (event?.target === this.nativePort) {
          this._unwatch({ keepArmed: true });
          this._lossNotifier.fire();
        }
      };
      events.addEventListener("disconnect", handler);
      this._stopWatch = () => events.removeEventListener("disconnect", handler);
    }
    this._lossNotifier.arm();
  }

  // Drop the listener; keepArmed is for the loss path, which still fires.
  _unwatch({ keepArmed = false } = {}) {
    if (!keepArmed) {
      this._lossNotifier.disarm();
    }
    const stop = this._stopWatch;
    this._stopWatch = null;
    try {
      stop?.();
    } catch {
      // The watch is gone either way.
    }
  }
}

import { bt1adDriver } from "./webbluetooth/bt-1ad.js";
import { createDisconnectNotifier } from "./serial-transport.mjs";

/** @typedef {import("./serial-transport.mjs").SerialTransport} SerialTransport */
/** @typedef {import("./serial-transport.mjs").SerialTransportCapabilities} SerialTransportCapabilities */
/** @typedef {import("./serial-transport.mjs").SerialOpenOptions} SerialOpenOptions */
/** @typedef {import("./serial-transport.mjs").SerialSignals} SerialSignals */

/**
 * A matched adapter's UART protocol, as a profile's probe() returns it
 * (web/js/webbluetooth/bt-1ad.js is the one there is).
 * @typedef {Object} BluetoothSerialProtocol
 * @property {string} name  How the debug panel names the adapter.
 * @property {boolean} supportsFraming
 * @property {boolean} supportsSignals
 * @property {BluetoothRemoteGATTCharacteristic} rx  Where received bytes arrive.
 * @property {(options: SerialOpenOptions) => void} validateOptions  Throws on
 *   settings the adapter cannot carry, before any command is sent.
 * @property {(options: SerialOpenOptions, previous: SerialOpenOptions|null) => Promise<void>} configure
 * @property {(bytes: Uint8Array) => Promise<void>} write
 * @property {(signals: SerialSignals) => Promise<void>} setSignals
 */

/**
 * One adapter profile: what the chooser filters on and how to recognise the
 * adapter once connected.
 * @typedef {Object} BluetoothSerialDriver
 * @property {string} name
 * @property {BluetoothLEScanFilter[]} filters
 * @property {BluetoothServiceUUID[]} optionalServices
 * @property {(server: BluetoothRemoteGATTServer, options?: object) => Promise<BluetoothSerialProtocol|null>} probe
 *   The protocol for a matching adapter, or null for a mismatch.
 */

// Register adapter profiles here; chooser permissions and probing share this list.
/** @type {BluetoothSerialDriver[]} */
export const BLUETOOTH_SERIAL_DRIVERS = [bt1adDriver];

// Present the dongle as a serial transport (web/js/serial-transport.mjs) so the
// existing buffered bridge and every CHIRP driver retain ownership of radio
// handshakes and memory formats.
/** @implements {SerialTransport} */
export class WebBluetoothSerialPort {
  // Keep GATT state on the port; it survives UART-rate changes without a picker.
  /**
   * @param {BluetoothDevice} device
   * @param {{drivers?: BluetoothSerialDriver[], [option: string]: unknown}} [options]
   *   drivers to probe, plus options handed to each probe().
   */
  constructor(device, { drivers = BLUETOOTH_SERIAL_DRIVERS, ...driverOptions } = {}) {
    this.device = device;
    this._lossNotifier = createDisconnectNotifier(this);
    /** @type {ReadableStream<Uint8Array>|null} */
    this.readable = null;
    /** @type {WritableStream<Uint8Array>|null} */
    this.writable = null;
    /** @type {ReadableStreamDefaultController<Uint8Array>|null} */
    this._controller = null;
    /** @type {BluetoothSerialProtocol|null} */
    this._driver = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this._rx = null;
    /** @type {SerialOpenOptions|null} */
    this._options = null;
    this._queue = Promise.resolve();
    this._drivers = drivers;
    this._driverOptions = driverOptions;
    /** @type {string|null} */
    this.driverName = null;
    /** @param {Event} event */
    this._onValue = (event) => {
      const value = /** @type {BluetoothRemoteGATTCharacteristic} */ (event.target).value;
      if (value && this._controller) {
        // Copy the DataView's exact window; browsers may reuse its buffer.
        this._controller.enqueue(new Uint8Array(
          value.buffer, value.byteOffset, value.byteLength,
        ).slice());
      }
    };
    this._onDisconnect = () => {
      const error = new Error("Bluetooth serial adapter disconnected.");
      this._controller?.error(error);
      this._controller = null;
      this._lossNotifier.fire();
    };
  }

  get transport() {
    return "webbluetooth";
  }

  // What the matched adapter profile can do. Framing and DTR/RTS are the
  // profile's to declare (BT-1AD has neither); before open() no profile is
  // matched, so nothing beyond the rate is promised. The UART rate always
  // changes in place, over the same GATT link: a reconnect would drop
  // notifications mid-clone.
  /** @returns {SerialTransportCapabilities} */
  get capabilities() {
    return {
      framing: Boolean(this._driver?.supportsFraming),
      signals: Boolean(this._driver?.supportsSignals),
      reconfigure: "update",
    };
  }

  // A Bluetooth adapter has no USBDevice and no USB ids to report.
  get usbDevice() {
    return null;
  }

  getInfo() {
    return {};
  }

  // How the debug panel names the port, since there are no USB ids.
  get displayName() {
    return this.driverName || "BLE serial adapter";
  }

  // Contract: register a loss callback, get its unsubscribe back. Fired once
  // when the GATT link drops while open, never for close().
  onDisconnect(callback) {
    return this._lossNotifier.subscribe(callback);
  }

  // Serialize GATT operations: overlapping writes can fail with "busy" even
  // when they target different characteristics on the same connection.
  _enqueue(operation) {
    const pending = this._queue.then(operation);
    this._queue = pending.catch(() => {});
    return pending;
  }

  // Discover only the verified UART characteristics and subscribe before any
  // radio traffic can arrive. Every failed open cleans up its partial session.
  async open(options) {
    if (this._driver) {
      throw new Error("Bluetooth serial port is already open.");
    }
    this.driverName = null;
    this.device.addEventListener("gattserverdisconnected", this._onDisconnect);
    try {
      // Null when the site may not reach the device's GATT server.
      const gatt = this.device.gatt;
      if (!gatt) {
        throw new Error("The Bluetooth device does not expose a GATT server.");
      }
      const server = await gatt.connect();
      for (const driver of this._drivers) {
        this._driver = await driver.probe(server, this._driverOptions);
        if (this._driver) break;
      }
      if (!this._driver) {
        throw new Error("No supported BLE serial driver matched the selected device.");
      }
      this.driverName = this._driver.name;
      this._driver.validateOptions(options);
      this._rx = this._driver.rx;
      this.readable = new ReadableStream({
        start: (controller) => { this._controller = controller; },
        cancel: () => { this._controller = null; },
      });
      this.writable = new WritableStream({
        write: (bytes) => this._write(bytes),
      });
      this._rx.addEventListener("characteristicvaluechanged", this._onValue);
      // startNotifications also enables indications; the browser sends their
      // ATT confirmations, which are not part of the UART byte stream.
      await this._rx.startNotifications();
      await this.reconfigure(options);
      if (!gatt.connected) {
        throw new Error("Bluetooth adapter disconnected while opening the serial port.");
      }
      this._lossNotifier.arm();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  // Serialize device-specific UART changes with outgoing data on the same link.
  async reconfigure(options) {
    this._driver?.validateOptions(options);
    await this._enqueue(async () => {
      if (!this.device.gatt?.connected || !this._driver) {
        throw new Error("Bluetooth serial port is not connected.");
      }
      await this._driver.configure(options, this._options);
      if (!this.device.gatt?.connected) {
        throw new Error("Bluetooth adapter disconnected while setting the baud rate.");
      }
      this._options = { ...options };
    });
  }

  // Copy outgoing bytes and let the matched driver encode and split them in order.
  async _write(bytes) {
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    await this._enqueue(async () => {
      if (!this.device.gatt?.connected || !this._driver) {
        throw new Error("Bluetooth serial port is not connected.");
      }
      await this._driver.write(data);
    });
  }

  // Forward optional control-line operations to the matched adapter protocol.
  async setSignals(signals) {
    await this._enqueue(async () => {
      if (!this._driver) throw new Error("Bluetooth serial port is not connected.");
      await this._driver.setSignals(signals);
    });
  }

  // Remove callbacks before intentional disconnect so it is never reported
  // as device loss. Safe after a partial open or an actual link loss.
  async close() {
    this._lossNotifier.disarm();
    this.device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    this._rx?.removeEventListener("characteristicvaluechanged", this._onValue);
    this._controller?.close();
    this._controller = null;
    // Disconnect immediately instead of waiting for a stuck GATT operation.
    this.device.gatt?.disconnect();
    await this._queue;
    this._driver = null;
    this._rx = null;
    this._options = null;
    this.readable = null;
    this.writable = null;
  }
}

// Request devices advertised by registered profiles and permit their services.
// Detection occurs during open, so failed probes use the normal port cleanup.
/**
 * @param {{drivers?: BluetoothSerialDriver[]}} [options]
 * @returns {{requestPort(): Promise<WebBluetoothSerialPort>}}
 */
export function createWebBluetoothSerial({ drivers = BLUETOOTH_SERIAL_DRIVERS } = {}) {
  return {
    // Keep the picker call within the user gesture, before any async discovery.
    async requestPort() {
      if (!navigator.bluetooth) {
        throw new Error("Web Bluetooth is not available in this browser.");
      }
      const device = await navigator.bluetooth.requestDevice({
        filters: drivers.flatMap((driver) => driver.filters),
        optionalServices: [...new Set(drivers.flatMap((driver) => driver.optionalServices))],
      });
      return new WebBluetoothSerialPort(device, { drivers });
    },
  };
}

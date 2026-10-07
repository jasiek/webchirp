import { bt1adDriver } from "./webbluetooth/bt-1ad.js";
import { createDisconnectNotifier } from "./serial-transport.mjs";

// Register adapter profiles here; chooser permissions and probing share this list.
export const BLUETOOTH_SERIAL_DRIVERS = [bt1adDriver];

// Present the dongle as a serial transport (web/js/serial-transport.mjs) so the
// existing buffered bridge and every CHIRP driver retain ownership of radio
// handshakes and memory formats.
export class WebBluetoothSerialPort extends EventTarget {
  // Keep GATT state on the port; it survives UART-rate changes without a picker.
  constructor(device, { drivers = BLUETOOTH_SERIAL_DRIVERS, ...driverOptions } = {}) {
    super();
    this.device = device;
    this._lossNotifier = createDisconnectNotifier(this);
    this.readable = null;
    this.writable = null;
    this._controller = null;
    this._driver = null;
    this._rx = null;
    this._options = null;
    this._queue = Promise.resolve();
    this._drivers = drivers;
    this._driverOptions = driverOptions;
    this.driverName = null;
    this._onValue = (event) => {
      const value = event.target.value;
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
      this.dispatchEvent(new Event("disconnect"));
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
      const server = await this.device.gatt.connect();
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
      if (!this.device.gatt.connected) {
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
      if (!this.device.gatt.connected || !this._driver) {
        throw new Error("Bluetooth serial port is not connected.");
      }
      await this._driver.configure(options, this._options);
      if (!this.device.gatt.connected) {
        throw new Error("Bluetooth adapter disconnected while setting the baud rate.");
      }
      this._options = { ...options };
    });
  }

  // Copy outgoing bytes and let the matched driver encode and split them in order.
  async _write(bytes) {
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    await this._enqueue(async () => {
      if (!this.device.gatt.connected || !this._driver) {
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
export function createWebBluetoothSerial({ drivers = BLUETOOTH_SERIAL_DRIVERS } = {}) {
  return {
    // Keep the picker call within the user gesture, before any async discovery.
    async requestPort() {
      const device = await navigator.bluetooth.requestDevice({
        filters: drivers.flatMap((driver) => driver.filters),
        optionalServices: [...new Set(drivers.flatMap((driver) => driver.optionalServices))],
      });
      return new WebBluetoothSerialPort(device, { drivers });
    },
  };
}

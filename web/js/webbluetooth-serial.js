// BF_Writer dongles expose a UART over FF00, distinct from their JL OTA
// characteristics. Protocol verified against an Ola UV-5R HCI capture and
// documented in the companion ola-radio-reveng project's research directory.
export const BF_WRITER_SERVICE = "0000ff00-0000-1000-8000-00805f9b34fb";
export const BF_WRITER_ADVERTISEMENT = "0000bf98-0000-1000-8000-00805f9b34fb";
export const BF_WRITER_TX = "0000ff02-0000-1000-8000-00805f9b34fb";
export const BF_WRITER_RX = "0000ff01-0000-1000-8000-00805f9b34fb";
export const BF_WRITER_BAUD = "0000ae10-0000-1000-8000-00805f9b34fb";

// Web Bluetooth does not expose the negotiated ATT MTU. Twenty bytes fits
// even the minimum MTU; awaiting each write preserves UART byte order.
const WRITE_CHUNK_SIZE = 20;
// Ola leaves one second between configuring the UART and the radio handshake.
const BAUD_SETTLE_MS = 1000;

// Refuse unsupported framing instead of silently corrupting a CHIRP transfer.
function validateOptions(options) {
  if (!Number.isInteger(options.baudRate) || options.baudRate <= 0
    || options.baudRate > 0xffffffff) {
    throw new Error("The Bluetooth adapter requires a positive 32-bit baud rate.");
  }
  if ((options.dataBits ?? 8) !== 8 || (options.stopBits ?? 1) !== 1
    || (options.parity ?? "none") !== "none"
    || (options.flowControl ?? "none") !== "none") {
    throw new Error("This Bluetooth adapter supports 8N1 without flow control only.");
  }
}

// Present the dongle as a Web Serial port so the existing buffered bridge and
// every CHIRP driver retain ownership of radio handshakes and memory formats.
export class WebBluetoothSerialPort extends EventTarget {
  // Keep GATT state on the port; it survives UART-rate changes without a picker.
  constructor(device, { settleMs = BAUD_SETTLE_MS } = {}) {
    super();
    this.device = device;
    this.supportsFraming = false;
    this.readable = null;
    this.writable = null;
    this._controller = null;
    this._tx = null;
    this._rx = null;
    this._baud = null;
    this._options = null;
    this._queue = Promise.resolve();
    this._settleMs = settleMs;
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
      this.dispatchEvent(new Event("disconnect"));
    };
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
    validateOptions(options);
    if (this._tx) {
      throw new Error("Bluetooth serial port is already open.");
    }
    this.device.addEventListener("gattserverdisconnected", this._onDisconnect);
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(BF_WRITER_SERVICE);
      this._tx = await service.getCharacteristic(BF_WRITER_TX);
      this._rx = await service.getCharacteristic(BF_WRITER_RX);
      this._baud = await service.getCharacteristic(BF_WRITER_BAUD);
      if (!this._tx.properties.writeWithoutResponse
        || !this._rx.properties.indicate || !this._baud.properties.write) {
        throw new Error("The selected device does not expose the BF_Writer serial interface.");
      }
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
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  // AE10 accepts the UART rate as four little-endian bytes with a GATT write
  // response. No JL envelope or model-specific initialization is needed.
  async reconfigure(options) {
    validateOptions(options);
    await this._enqueue(async () => {
      if (!this.device.gatt.connected || !this._baud) {
        throw new Error("Bluetooth serial port is not connected.");
      }
      if (this._options?.baudRate === options.baudRate) {
        return;
      }
      const value = new Uint8Array(4);
      new DataView(value.buffer).setUint32(0, options.baudRate, true);
      await this._baud.writeValueWithResponse(value);
      await new Promise((resolve) => setTimeout(resolve, this._settleMs));
      if (!this.device.gatt.connected) {
        throw new Error("Bluetooth adapter disconnected while setting the baud rate.");
      }
      this._options = { ...options };
    });
  }

  // Deliver unframed CHIRP bytes in order, using the minimum-MTU-safe size.
  async _write(bytes) {
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    await this._enqueue(async () => {
      for (let offset = 0; offset < data.length; offset += WRITE_CHUNK_SIZE) {
        if (!this.device.gatt.connected || !this._tx) {
          throw new Error("Bluetooth serial port is not connected.");
        }
        await this._tx.writeValueWithoutResponse(data.slice(offset, offset + WRITE_CHUNK_SIZE));
      }
    });
  }

  // There is no known DTR/RTS command; the bridge treats clone preparation's
  // lines as advisory, while a driver requiring a mid-clone toggle gets an error.
  async setSignals() {
    throw new Error("This Bluetooth adapter does not support DTR/RTS control lines.");
  }

  // Remove callbacks before intentional disconnect so it is never reported
  // as device loss. Safe after a partial open or an actual link loss.
  async close() {
    this.device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    this._rx?.removeEventListener("characteristicvaluechanged", this._onValue);
    this._controller?.close();
    this._controller = null;
    // Disconnect immediately instead of waiting for a stuck GATT operation.
    this.device.gatt?.disconnect();
    await this._queue;
    this._tx = null;
    this._rx = null;
    this._baud = null;
    this._options = null;
    this.readable = null;
    this.writable = null;
  }
}

// Request the advertised BF98 device but explicitly permit FF00 discovery:
// the adapter's advertising UUID is not its actual UART service UUID.
export function createWebBluetoothSerial() {
  return {
    async requestPort() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BF_WRITER_ADVERTISEMENT] }],
        optionalServices: [BF_WRITER_SERVICE],
      });
      return new WebBluetoothSerialPort(device);
    },
  };
}

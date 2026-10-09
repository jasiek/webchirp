// BT-1AD UART protocol, verified in the companion ola-radio-reveng project.
import type { BluetoothSerialDriver, BluetoothSerialProtocol } from "../webbluetooth-serial.ts";
import type { SerialOpenOptions } from "../serial-transport.ts";
import { errorFields } from "../error-details.ts";

const SERVICE = "0000ff00-0000-1000-8000-00805f9b34fb";
const ADVERTISEMENT = "0000bf98-0000-1000-8000-00805f9b34fb";
const TX = "0000ff02-0000-1000-8000-00805f9b34fb";
const RX = "0000ff01-0000-1000-8000-00805f9b34fb";
const BAUD = "0000ae10-0000-1000-8000-00805f9b34fb";

// Keep device-specific framing, baud control and packet limits out of the
// shared Web Bluetooth stream lifecycle in web/js/webbluetooth-serial.ts.
class Bt1adProtocol implements BluetoothSerialProtocol {
  name: string;
  supportsFraming: boolean;
  supportsSignals: boolean;
  rx: BluetoothRemoteGATTCharacteristic;
  tx: BluetoothRemoteGATTCharacteristic;
  baud: BluetoothRemoteGATTCharacteristic;
  settleMs: number;

  // Retain discovered characteristics without changing the device during probing.
  constructor(
    tx: BluetoothRemoteGATTCharacteristic,
    rx: BluetoothRemoteGATTCharacteristic,
    baud: BluetoothRemoteGATTCharacteristic,
    { settleMs = 1000 }: { settleMs?: number } = {},
  ) {
    this.name = "BT-1AD";
    this.supportsFraming = false;
    // No DTR/RTS command is known for this adapter; see setSignals().
    this.supportsSignals = false;
    this.rx = rx;
    this.tx = tx;
    this.baud = baud;
    this.settleMs = settleMs;
  }

  // Refuse unsupported UART settings before issuing a device command.
  validateOptions(options: SerialOpenOptions): void {
    if (!Number.isInteger(options.baudRate) || options.baudRate <= 0
      || options.baudRate > 0xffffffff) {
      throw new Error("BT-1AD requires a positive 32-bit baud rate.");
    }
    if ((options.dataBits ?? 8) !== 8 || (options.stopBits ?? 1) !== 1
      || (options.parity ?? "none") !== "none"
      || (options.flowControl ?? "none") !== "none") {
      throw new Error("BT-1AD supports 8N1 without flow control only.");
    }
  }

  // AE10 accepts LE32 baud with a response; retain Ola's one-second settle time.
  async configure(options: SerialOpenOptions, previous: SerialOpenOptions | null): Promise<void> {
    if (previous?.baudRate === options.baudRate) return;
    const value = new Uint8Array(4);
    new DataView(value.buffer).setUint32(0, options.baudRate, true);
    await this.baud.writeValueWithResponse(value);
    await new Promise((resolve) => setTimeout(resolve, this.settleMs));
  }

  // Twenty bytes fits the minimum ATT MTU, which Web Bluetooth cannot report.
  async write(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += 20) {
      await this.tx.writeValueWithoutResponse(bytes.slice(offset, offset + 20));
    }
  }

  // No DTR/RTS command is known for this adapter.
  async setSignals(): Promise<void> {
    throw new Error("BT-1AD does not support DTR/RTS control lines.");
  }
}

export const bt1adDriver: BluetoothSerialDriver = {
  name: "BT-1AD",
  filters: [{ services: [ADVERTISEMENT] }],
  optionalServices: [SERVICE],
  // Match the complete UART profile, never the editable advertised device name.
  // Only missing attributes mean a mismatch; link/permission failures propagate.
  async probe(server: BluetoothRemoteGATTServer, options?: { settleMs?: number }) {
    try {
      const service = await server.getPrimaryService(SERVICE);
      const tx = await service.getCharacteristic(TX);
      const rx = await service.getCharacteristic(RX);
      const baud = await service.getCharacteristic(BAUD);
      if (!tx.properties.writeWithoutResponse || !rx.properties.indicate
        || !baud.properties.write) return null;
      return new Bt1adProtocol(tx, rx, baud, options);
    } catch (error) {
      if (errorFields(error).name === "NotFoundError") return null;
      throw error;
    }
  },
};

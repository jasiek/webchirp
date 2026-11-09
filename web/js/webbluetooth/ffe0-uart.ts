// Built-in BLE UART on radios that program wirelessly without a dongle: one
// FFE1 characteristic on service FFE0 carries both directions (written to,
// notifies back). Verified against a Baofeng UV-5R Mini's own Bluetooth
// ("Wireless CPS"), whose CHIRP driver already switches to its BLE block size
// when the pipe reports a Bluetooth port (see serial_pipe.WebSerialPipe.port).
import type { BluetoothSerialDriver, BluetoothSerialProtocol } from "../webbluetooth-serial.ts";
import type { SerialOpenOptions } from "../serial-transport.ts";
import { errorFields } from "../error-details.ts";

const SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const UART = "0000ffe1-0000-1000-8000-00805f9b34fb";

// The radio-side UART rate is fixed in the radio; nothing over GATT sets it.
class Ffe0UartProtocol implements BluetoothSerialProtocol {
  name: string;
  supportsFraming: boolean;
  supportsSignals: boolean;
  rx: BluetoothRemoteGATTCharacteristic;
  uart: BluetoothRemoteGATTCharacteristic;

  constructor(uart: BluetoothRemoteGATTCharacteristic) {
    this.name = "Built-in Bluetooth (FFE0)";
    this.supportsFraming = false;
    this.supportsSignals = false;
    this.rx = uart;
    this.uart = uart;
  }

  // Any rate is accepted because there is no rate to set; anything other than
  // 8N1 cannot be honoured, so it is refused before a byte is sent.
  validateOptions(options: SerialOpenOptions): void {
    if (!Number.isInteger(options.baudRate) || options.baudRate <= 0) {
      throw new Error("Built-in Bluetooth requires a positive baud rate.");
    }
    if ((options.dataBits ?? 8) !== 8 || (options.stopBits ?? 1) !== 1
      || (options.parity ?? "none") !== "none"
      || (options.flowControl ?? "none") !== "none") {
      throw new Error("Built-in Bluetooth supports 8N1 without flow control only.");
    }
  }

  // Nothing to configure: the driver's rate changes never reach the radio.
  async configure(): Promise<void> {}

  // Twenty bytes fits the minimum ATT MTU. Each chunk waits for its write
  // response where the characteristic offers one: unacknowledged writes were
  // dropped by the radio under clone-sized bursts, corrupting uploads.
  async write(bytes: Uint8Array): Promise<void> {
    const acknowledged = this.uart.properties.write;
    for (let offset = 0; offset < bytes.length; offset += 20) {
      const chunk = bytes.slice(offset, offset + 20);
      if (acknowledged) await this.uart.writeValueWithResponse(chunk);
      else await this.uart.writeValueWithoutResponse(chunk);
    }
  }

  async setSignals(): Promise<void> {
    throw new Error("Built-in Bluetooth has no DTR/RTS control lines.");
  }
}

export const ffe0UartDriver: BluetoothSerialDriver = {
  name: "Built-in Bluetooth (FFE0)",
  // Whether every radio advertises FFE0 is unknown, so the chooser also lists
  // the name the tested radio advertises; the probe below decides by profile.
  filters: [{ services: [SERVICE] }, { namePrefix: "walkie-talkie" }],
  optionalServices: [SERVICE],
  // Match the GATT profile, never the editable advertised name. Only missing
  // attributes mean a mismatch; link and permission failures propagate.
  async probe(server: BluetoothRemoteGATTServer) {
    try {
      const service = await server.getPrimaryService(SERVICE);
      const uart = await service.getCharacteristic(UART);
      const { notify, write, writeWithoutResponse } = uart.properties;
      if (!notify || !(write || writeWithoutResponse)) return null;
      return new Ffe0UartProtocol(uart);
    } catch (error) {
      if (errorFields(error).name === "NotFoundError") return null;
      throw error;
    }
  },
};

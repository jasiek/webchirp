// FTDI USB-UART driver implemented over WebUSB, exposing the subset of the Web
// Serial `SerialPort` interface that BrowserSerialBridge uses (open, readable,
// writable, setSignals, getInfo, close). This lets browsers that have WebUSB
// but not Web Serial (e.g. Chrome on Android) talk to FTDI adapters such as the
// FT231X, which are vendor-specific USB devices the generic CDC-ACM polyfill
// cannot drive.
//
// Protocol constants and the baud-rate divisor math follow libftdi.

export const FTDI_VENDOR_ID = 0x0403;

// FTDI vendor control requests (bRequest values).
const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_SET_LATENCY_TIMER = 0x09;

// SIO_RESET wValue variants: 0 resets the port, 1/2 purge the RX/TX FIFOs.
const SIO_RESET_PURGE_RX = 0x0001;
const SIO_RESET_PURGE_TX = 0x0002;

// Latency timer in ms: how long the chip holds a partial packet before
// flushing it to the host. The 16 ms power-on default adds up to 16 ms to
// every short read; 4 ms keeps byte-oriented clone handshakes snappy.
const LATENCY_TIMER_MS = 4;

// 8 data bits, no parity, 1 stop bit.
const DATA_8N1 = 0x0008;

// Control requests other than baud target port/interface A (libftdi index 1).
const PORT_INDEX = 1;

export function isFtdiDevice(device) {
  return Boolean(device) && Number(device.vendorId) === FTDI_VENDOR_ID;
}

// Port of libftdi ftdi_to_clkbits / ftdi_convert_baudrate for the FT232R / FT-X
// family (3 MHz effective base clock). Returns the wValue/wIndex pair for the
// SIO_SET_BAUD_RATE control request.
export function ftdiConvertBaudrate(baudrate) {
  const baud = Number(baudrate);
  if (!Number.isFinite(baud) || baud <= 0) {
    throw new Error(`Invalid FTDI baud rate: ${baudrate}`);
  }

  const fracCode = [0, 3, 2, 4, 1, 5, 6, 7];
  const clk = 48000000;
  const clkDiv = 16; // clk / clkDiv == 3 MHz

  let encodedDivisor;
  if (baud >= clk / clkDiv) {
    encodedDivisor = 0;
  } else if (baud >= clk / (clkDiv + clkDiv / 2)) {
    encodedDivisor = 1; // special divisor 1.5
  } else if (baud >= clk / (2 * clkDiv)) {
    encodedDivisor = 2; // special divisor 2
  } else {
    let divisor = Math.floor((clk * 16) / clkDiv / baud);
    let bestDivisor = divisor & 1 ? (divisor >> 1) + 1 : divisor >> 1;
    if (bestDivisor > 0x20000) {
      bestDivisor = 0x1ffff;
    }
    encodedDivisor = (bestDivisor >> 3) | (fracCode[bestDivisor & 0x7] << 14);
  }

  return {
    value: encodedDivisor & 0xffff,
    index: (encodedDivisor >> 16) & 0xffff,
  };
}

// FTDI prepends two modem/line status bytes to every bulk-IN packet; strip them
// to recover the actual serial payload. Reads are issued one packet at a time,
// so each transfer carries a single status header.
export function stripFtdiStatusBytes(bytes) {
  if (!bytes || bytes.length <= 2) {
    return new Uint8Array(0);
  }
  return bytes.slice(2);
}

export class FtdiSerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this._interfaceNumber = 0;
    this._inEndpoint = 0;
    this._outEndpoint = 0;
    this._inPacketSize = 64;
    this._closed = false;
  }

  getInfo() {
    return {
      usbVendorId: Number(this.device.vendorId),
      usbProductId: Number(this.device.productId),
    };
  }

  // Bulk IN endpoint size, so a caller can size payloads around the boundary
  // that matters. The constructor default is the family's usual value; open()
  // replaces it with what the descriptor actually reports.
  get packetSize() {
    return this._inPacketSize;
  }

  async _controlOut(request, value, index) {
    const result = await this.device.controlTransferOut({
      requestType: "vendor",
      recipient: "device",
      request,
      value,
      index,
    });
    if (result && result.status && result.status !== "ok") {
      throw new Error(`FTDI control transfer failed (request 0x${request.toString(16)}): ${result.status}`);
    }
  }

  async open(options = {}) {
    const baudRate = Number(options.baudRate) || 9600;
    // close() latches _closed, and the read loop below exits the moment it is
    // set. Reopening the same port object without clearing it yields streams
    // that never deliver a byte.
    this._closed = false;

    try {
      await this.device.open();
    } catch (error) {
      throw new Error(`FTDI: could not open USB device: ${error?.message || error}`);
    }
    if (!this.device.configuration) {
      await this.device.selectConfiguration(1);
    }

    const iface = this.device.configuration.interfaces[0];
    this._interfaceNumber = iface.interfaceNumber;
    try {
      await this.device.claimInterface(this._interfaceNumber);
    } catch (error) {
      throw new Error(
        `FTDI: could not claim USB interface ${this._interfaceNumber} `
        + `(another driver may already control it): ${error?.message || error}`,
      );
    }

    for (const endpoint of iface.alternate.endpoints) {
      if (endpoint.direction === "in") {
        this._inEndpoint = endpoint.endpointNumber;
        this._inPacketSize = endpoint.packetSize || this._inPacketSize;
      } else if (endpoint.direction === "out") {
        this._outEndpoint = endpoint.endpointNumber;
      }
    }

    await this._controlOut(SIO_RESET, 0x0000, PORT_INDEX);
    // Purge both FIFOs so stale bytes from a previous session can never be
    // misread as protocol responses (mirrors native driver init).
    await this._controlOut(SIO_RESET, SIO_RESET_PURGE_RX, PORT_INDEX);
    await this._controlOut(SIO_RESET, SIO_RESET_PURGE_TX, PORT_INDEX);
    const baud = ftdiConvertBaudrate(baudRate);
    await this._controlOut(SIO_SET_BAUD_RATE, baud.value, baud.index);
    await this._controlOut(SIO_SET_DATA, DATA_8N1, PORT_INDEX);
    await this._controlOut(SIO_SET_FLOW_CTRL, 0x0000, PORT_INDEX);
    await this._controlOut(SIO_SET_LATENCY_TIMER, LATENCY_TIMER_MS, PORT_INDEX);

    this._setupStreams();
  }

  // Map Web Serial control-signal requests onto FTDI SIO_SET_MODEM_CTRL. The
  // high byte of wValue is a write mask; the low byte carries the bit values.
  async setSignals(signals = {}) {
    let value = 0;
    if (signals.dataTerminalReady !== undefined) {
      value |= 0x0100;
      if (signals.dataTerminalReady) {
        value |= 0x0001;
      }
    }
    if (signals.requestToSend !== undefined) {
      value |= 0x0200;
      if (signals.requestToSend) {
        value |= 0x0002;
      }
    }
    if (value !== 0) {
      await this._controlOut(SIO_SET_MODEM_CTRL, value, PORT_INDEX);
    }
  }

  _setupStreams() {
    const device = this.device;
    const inEndpoint = this._inEndpoint;
    const outEndpoint = this._outEndpoint;
    const packetSize = this._inPacketSize;
    const isClosed = () => this._closed;

    this.readable = new ReadableStream({
      // CRITICAL: pull must not resolve until it has enqueued payload. The
      // FTDI chip completes a bulk IN transfer with a 2-byte status header
      // (and usually nothing else) every latency-timer tick; per the Streams
      // spec, a pull that resolves WITHOUT enqueuing is never re-invoked
      // until a new read request or enqueue occurs — so returning early on a
      // status-only packet wedged the read path permanently after the first
      // idle packet. Loop over status-only packets and stalls instead.
      pull: async (controller) => {
        try {
          while (!isClosed()) {
            const result = await device.transferIn(inEndpoint, packetSize);
            if (result.status === "stall") {
              // A stalled IN endpoint returns "stall" forever until the halt
              // is cleared; without this the read path goes permanently silent.
              await device.clearHalt("in", inEndpoint);
              continue;
            }
            if (result.status === "babble") {
              throw new Error("FTDI: babble on bulk IN endpoint (device sent more data than requested)");
            }
            if (result.status === "ok" && result.data && result.data.byteLength > 0) {
              const bytes = new Uint8Array(
                result.data.buffer,
                result.data.byteOffset,
                result.data.byteLength,
              );
              const payload = stripFtdiStatusBytes(bytes);
              if (payload.length > 0) {
                controller.enqueue(payload);
                return;
              }
            }
          }
        } catch (error) {
          if (!isClosed()) {
            controller.error(error);
          }
        }
      },
      cancel: () => {
        this._closed = true;
      },
    });

    this.writable = new WritableStream({
      write: async (chunk) => {
        await device.transferOut(outEndpoint, chunk);
      },
    });
  }

  async close() {
    this._closed = true;
    try {
      await this.device.releaseInterface(this._interfaceNumber);
    } catch {
      // Interface may already be released or the device gone.
    }
    try {
      await this.device.close();
    } catch {
      // Ignore close errors.
    }
  }
}

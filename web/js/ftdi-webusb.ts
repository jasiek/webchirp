// FTDI USB-UART driver implemented over WebUSB, implementing the serial
// transport contract (web/js/serial-transport.ts) the serial bridge drives:
// Web Serial's open, readable, writable, setSignals, getInfo and close, plus
// the members WebUsbTransport (web/js/webusb-transport.ts) supplies. This lets
// browsers that have WebUSB but not Web Serial (e.g. Chrome on Android) talk
// to FTDI adapters such as the FT231X, which are vendor-specific USB devices
// the generic CDC-ACM polyfill cannot drive.
//
// Protocol constants and the baud-rate divisor math follow libftdi.
import {
  WEBUSB_FRAMING_CHIP_CAPABILITIES,
  WebUsbTransport,
  resolveChipFraming,
  writeBulkOut,
} from "./webusb-transport.ts";
import type { ChipFraming, WebUsbTransportOptions } from "./webusb-transport.ts";
import type {
  SerialOpenOptions,
  SerialSignals,
  SerialTransport,
  SerialTransportCapabilities,
} from "./serial-transport.ts";

export const FTDI_VENDOR_ID = 0x0403;

// FTDI vendor control requests (bRequest values).
const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_POLL_MODEM_STATUS = 0x05;
const SIO_SET_LATENCY_TIMER = 0x09;

// SIO_RESET wValue variants: 0 resets the port, 1/2 purge the RX/TX FIFOs.
const SIO_RESET_PURGE_RX = 0x0001;
const SIO_RESET_PURGE_TX = 0x0002;

// Latency timer in ms: how long the chip holds a partial packet before
// flushing it to the host. The 16 ms power-on default adds up to 16 ms to
// every short read; 4 ms keeps byte-oriented clone handshakes snappy.
const LATENCY_TIMER_MS = 4;

// How many single-packet bulk IN transfers to keep queued at once.
//
// With one transfer in flight the host has no IN request outstanding between
// one completing and the next being issued, and the chip's RX FIFO overruns in
// that gap — silently, with status "ok" and no error at any layer. The CH340
// and PL2303 drivers were fixed for this first; this chip is the last one that
// still read a transfer at a time.
//
// Linux never had the problem: ftdi_sio sets no read callback and inherits
// read_urbs[2] (include/linux/usb/serial.h) — both submitted at open and each
// resubmitted from its own completion callback. Depth 2 suffices when the
// resubmit runs in interrupt context; a JS resubmit crosses Chrome's IPC
// boundary and the event loop, hence the deeper queue.
const READ_PIPELINE_DEPTH = 16;

// SIO_SET_DATA wValue, as the kernel's ftdi_sio.h lays it out: the data bit
// count in the low byte, parity in bits 8-10, stop bits in bits 11-12 (bit 14
// is break, never set here).
const DATA_PARITY_NONE = 0x0 << 8;
const DATA_PARITY_ODD = 0x1 << 8;
const DATA_PARITY_EVEN = 0x2 << 8;
const DATA_STOP_BITS_1 = 0x0 << 11;
const DATA_STOP_BITS_2 = 0x2 << 11;

// Modem status bits, in the first byte of the SIO_POLL_MODEM_STATUS reply (the
// same byte that heads every bulk IN packet), from the kernel's ftdi_sio.h.
const MODEM_STATUS_CTS = 0x10;
const MODEM_STATUS_DSR = 0x20;
const MODEM_STATUS_RI = 0x40;
const MODEM_STATUS_DCD = 0x80; // RLSD

// Control requests other than baud target port/interface A (libftdi index 1).
const PORT_INDEX = 1;

// The SIO_SET_DATA wValue for a frame, encoded as the kernel's
// ftdi_set_termios() does: 8N1 is 0x0008, 8E1 0x0208, 7E1 0x0207, 8N2 0x1008.
export function ftdiDataValue({ dataBits, parity, stopBits }: ChipFraming): number {
  const parityBits = parity === "odd"
    ? DATA_PARITY_ODD
    : parity === "even" ? DATA_PARITY_EVEN : DATA_PARITY_NONE;
  const stopBitsValue = stopBits === 2 ? DATA_STOP_BITS_2 : DATA_STOP_BITS_1;
  return dataBits | parityBits | stopBitsValue;
}

export function isFtdiDevice(device: Partial<USBDevice> | null | undefined): boolean {
  return !!device && Number(device.vendorId) === FTDI_VENDOR_ID;
}

// How a chip turns a baud rate into a divisor: "am" is the FT8U232AM (four
// fractions, 16-bit divisor), "bm" the FT232BM, FT2232C, FT232R and FT-X (48
// MHz / 16, 17-bit divisor), "h" the hi-speed parts (120 MHz / 10 as well,
// divisor bit 16 moved to wIndex bit 8). These are libftdi's three paths.
export type FtdiBaudFamily = "am" | "bm" | "h";

// The bcdDevice of every hi-speed part: libftdi's FT2232H, FT4232H and FT232H,
// plus the HP/HA parts the kernel's ftdi_determine_type() adds after them and
// sends down the same hi-speed path.
const FTDI_HI_SPEED_BCD_DEVICES = new Set([
  0x0700, 0x0800, 0x0900, 0x2800, 0x2900, 0x3000, 0x3100, 0x3200, 0x3300, 0x3600,
]);

// The divisor family of a device, read from bcdDevice as libftdi's
// ftdi_usb_open_dev() does: no FTDI product id says which chip is behind it,
// and the families lay SIO_SET_BAUD_RATE out differently (see
// ftdiConvertBaudrate). WebUSB splits the word as Chromium's UsbDevice does (major is the whole high
// byte, minor and subminor a nibble each), so it reassembles exactly. 0x0200
// is an AM only with a serial number: an FT232BM whose iSerialNumber is 0
// reports 0x0200 too, a silicon bug libftdi and the kernel both work around.
// Anything unrecognised keeps the FT232R/FT-X divisor, as libftdi does.
export function ftdiBaudFamily(device: Partial<USBDevice>): FtdiBaudFamily {
  const bcdDevice = (Number(device.deviceVersionMajor) << 8)
    | ((Number(device.deviceVersionMinor) & 0x0f) << 4)
    | (Number(device.deviceVersionSubminor) & 0x0f);
  if (FTDI_HI_SPEED_BCD_DEVICES.has(bcdDevice)) {
    return "h";
  }
  if (bcdDevice === 0x0200 && device.serialNumber) {
    return "am";
  }
  return "bm";
}

// FTDI's sub-integer divisor codes: an eighth-step fraction (the index) as the
// three bits the chip expects at divisor bits 14-16.
const FTDI_FRAC_CODE = [0, 3, 2, 4, 1, 5, 6, 7];

// Port of libftdi ftdi_to_clkbits(): the encoded divisor for a base clock
// `clk` divided by `clkDiv`, before it is split into wValue and wIndex.
function ftdiToClkbits(baud: number, clk: number, clkDiv: number): number {
  if (baud >= clk / clkDiv) {
    return 0;
  }
  if (baud >= clk / (clkDiv + clkDiv / 2)) {
    return 1; // special divisor 1.5
  }
  if (baud >= clk / (2 * clkDiv)) {
    return 2; // special divisor 2
  }
  // Eighths of the divisor, plus one more bit to round on.
  const divisor = Math.floor((clk * 16) / clkDiv / baud);
  let bestDivisor = divisor & 1 ? (divisor >> 1) + 1 : divisor >> 1;
  if (bestDivisor > 0x20000) {
    bestDivisor = 0x1ffff;
  }
  return (bestDivisor >> 3) | (FTDI_FRAC_CODE[bestDivisor & 0x7] << 14);
}

// Port of libftdi ftdi_to_clkbits_AM(): the FT8U232AM can add only 0, 1/8, 1/4
// or 1/2 to its divisor, so the eighth-step divisor is rounded down to one of
// those, and the candidate above it is tried in case it lands closer.
function ftdiToClkbitsAm(baud: number): number {
  const amAdjustUp = [0, 0, 0, 1, 0, 3, 2, 1];
  const amAdjustDown = [0, 0, 0, 1, 0, 1, 2, 3];
  let divisor = Math.floor(24000000 / baud);
  divisor -= amAdjustDown[divisor & 7];

  let bestDivisor = 0;
  let bestBaudDiff = 0;
  for (let i = 0; i < 2; i++) {
    let tryDivisor = divisor + i;
    if (tryDivisor <= 8) {
      tryDivisor = 8; // the smallest divisor the chip takes
    } else if (tryDivisor < 16) {
      tryDivisor = 16; // the AM has no divisors 9 to 15
    } else {
      tryDivisor += amAdjustUp[tryDivisor & 7];
      if (tryDivisor > 0x1fff8) {
        tryDivisor = 0x1fff8; // the largest divisor the AM takes
      }
    }
    const baudEstimate = Math.floor((24000000 + Math.floor(tryDivisor / 2)) / tryDivisor);
    const baudDiff = Math.abs(baudEstimate - baud);
    if (i === 0 || baudDiff < bestBaudDiff) {
      bestDivisor = tryDivisor;
      bestBaudDiff = baudDiff;
      if (baudDiff === 0) {
        break;
      }
    }
  }
  const encoded = (bestDivisor >> 3) | (FTDI_FRAC_CODE[bestDivisor & 7] << 14);
  if (encoded === 1) {
    return 0; // 3000000 baud
  }
  return encoded === 0x4001 ? 1 : encoded;
}

// Port of libftdi ftdi_convert_baudrate(): the wValue/wIndex pair of the
// SIO_SET_BAUD_RATE control request for a chip of the given family. The
// default is the FT232R/FT-X family the driver was written against.
export function ftdiConvertBaudrate(
  baudrate: number,
  family: FtdiBaudFamily = "bm",
): { value: number; index: number } {
  const baud = Number(baudrate);
  if (!Number.isFinite(baud) || baud <= 0) {
    throw new Error(`Invalid FTDI baud rate: ${baudrate}`);
  }

  if (family === "h") {
    // Left alone, a hi-speed chip divides its 120 MHz by 2.5 and then 16: the
    // 3 MHz the older parts use. Bit 17 turns the 2.5 off for 120 MHz / 10,
    // used wherever its 14-bit divisor reaches the rate (from 733 baud up);
    // slower rates keep 48 MHz / 16. Either way divisor bit 16 rides in wIndex
    // bit 8, because the low byte names the port (A here, as for every other
    // request).
    const encodedDivisor = baud * 10 > Math.floor(120000000 / 0x3fff)
      ? ftdiToClkbits(baud, 120000000, 10) | 0x20000
      : ftdiToClkbits(baud, 48000000, 16);
    return {
      value: encodedDivisor & 0xffff,
      index: ((encodedDivisor >> 8) & 0xff00) | PORT_INDEX,
    };
  }

  const encodedDivisor = family === "am"
    ? ftdiToClkbitsAm(baud)
    : ftdiToClkbits(baud, 48000000, 16);
  return {
    value: encodedDivisor & 0xffff,
    index: (encodedDivisor >> 16) & 0xffff,
  };
}

// FTDI prepends two modem/line status bytes to every bulk-IN packet; strip them
// to recover the actual serial payload. Every transfer requests exactly one
// packet, so each carries a single status header — a longer request would
// return several packets concatenated, headers and all, and this would strip
// only the first pair and pass the rest off as data.
export function stripFtdiStatusBytes(bytes: Uint8Array | null | undefined): Uint8Array {
  if (!bytes || bytes.length <= 2) {
    return new Uint8Array(0);
  }
  return bytes.slice(2);
}

export class FtdiSerialPort extends WebUsbTransport implements SerialTransport {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  _interfaceNumber: number;
  _inEndpoint: number;
  _outEndpoint: number;
  _inPacketSize: number;
  _closed: boolean;

  // options.usb is the WebUSB loss-event source (navigator.usb by default).
  constructor(device: USBDevice, options: WebUsbTransportOptions = {}) {
    super(device, options);
    this.readable = null;
    this.writable = null;
    this._interfaceNumber = 0;
    this._inEndpoint = 0;
    this._outEndpoint = 0;
    this._inPacketSize = 64;
    this._closed = false;
  }

  // Bulk IN endpoint size, so a caller can size payloads around the boundary
  // that matters. The constructor default is the family's usual value; open()
  // replaces it with what the descriptor actually reports.
  get packetSize() {
    return this._inPacketSize;
  }

  // open() programs dataBits/stopBits/parity through SIO_SET_DATA, so a
  // framing change is a reopen like a rate change.
  override get capabilities(): Readonly<SerialTransportCapabilities> {
    return WEBUSB_FRAMING_CHIP_CAPABILITIES;
  }

  async _controlOut(request: number, value: number, index: number): Promise<void> {
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

  async open(options: Partial<SerialOpenOptions> = {}): Promise<void> {
    const baudRate = Number(options.baudRate) || 9600;
    // Checked before the device is touched: a frame this chip cannot carry
    // fails here, naming it, rather than half-way through the init sequence.
    const framing = resolveChipFraming(options, "FTDI");
    // close() latches _closed, and the read loop below exits the moment it is
    // set. Reopening the same port object without clearing it yields streams
    // that never deliver a byte.
    this._closed = false;

    await this._openDevice("FTDI");
    await this._setUpChip(async () => {
      const configuration = await this._activeConfiguration("FTDI");
      const iface = configuration.interfaces[0];
      this._interfaceNumber = iface.interfaceNumber;
      await this._claimInterface("FTDI", this._interfaceNumber);

      // Current FTDI parts expose a bare bulk pair here, but filter on type
      // anyway so a variant that adds an interrupt endpoint (as PL2303 and CH340
      // do for modem status) cannot silently bind the wrong endpoint.
      for (const endpoint of iface.alternate.endpoints) {
        if (endpoint.type !== "bulk") {
          continue;
        }
        if (endpoint.direction === "in") {
          this._inEndpoint = endpoint.endpointNumber;
          this._inPacketSize = endpoint.packetSize || this._inPacketSize;
        } else if (endpoint.direction === "out") {
          this._outEndpoint = endpoint.endpointNumber;
        }
      }
      if (!this._inEndpoint || !this._outEndpoint) {
        throw new Error(
          `FTDI: bulk IN/OUT endpoints not found on interface ${this._interfaceNumber}`,
        );
      }

      await this._controlOut(SIO_RESET, 0x0000, PORT_INDEX);
      // Purge both FIFOs so stale bytes from a previous session can never be
      // misread as protocol responses (mirrors native driver init).
      await this._controlOut(SIO_RESET, SIO_RESET_PURGE_RX, PORT_INDEX);
      await this._controlOut(SIO_RESET, SIO_RESET_PURGE_TX, PORT_INDEX);
      const baud = ftdiConvertBaudrate(baudRate, ftdiBaudFamily(this.device));
      await this._controlOut(SIO_SET_BAUD_RATE, baud.value, baud.index);
      await this._controlOut(SIO_SET_DATA, ftdiDataValue(framing), PORT_INDEX);
      await this._controlOut(SIO_SET_FLOW_CTRL, 0x0000, PORT_INDEX);
      await this._controlOut(SIO_SET_LATENCY_TIMER, LATENCY_TIMER_MS, PORT_INDEX);
    });

    this._setupStreams();
    this._watchDisconnect();
  }

  // Map Web Serial control-signal requests onto FTDI SIO_SET_MODEM_CTRL. The
  // high byte of wValue is a write mask; the low byte carries the bit values.
  async setSignals(signals: SerialSignals = {}): Promise<void> {
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

  // Input control lines, polled with SIO_POLL_MODEM_STATUS as the kernel's
  // tiocmget does (ftdi_get_modem_status), rather than read off the bulk IN
  // headers: a poll answers now, even when no reader is pulling packets. The
  // loopback page's control-line case is what reads it.
  async getSignals(): Promise<SerialInputSignals> {
    const result = await this.device.controlTransferIn({
      requestType: "vendor",
      recipient: "device",
      request: SIO_POLL_MODEM_STATUS,
      value: 0,
      index: PORT_INDEX,
    }, 2);
    if (result && result.status && result.status !== "ok") {
      throw new Error(`FTDI modem status request failed: ${result.status}`);
    }
    // The kernel accepts a 1-byte reply (the original SIO answers only that).
    const data = result?.data;
    if (!data || data.byteLength < 1) {
      throw new Error("FTDI: modem status request returned no data");
    }
    const status = data.getUint8(0);
    return {
      clearToSend: Boolean(status & MODEM_STATUS_CTS),
      dataSetReady: Boolean(status & MODEM_STATUS_DSR),
      dataCarrierDetect: Boolean(status & MODEM_STATUS_DCD),
      ringIndicator: Boolean(status & MODEM_STATUS_RI),
    };
  }

  _setupStreams() {
    const device = this.device;
    const inEndpoint = this._inEndpoint;
    const outEndpoint = this._outEndpoint;
    const packetSize = this._inPacketSize;
    const isClosed = () => this._closed;

    // Bulk IN transfers queued on the endpoint, oldest first. Transfers on one
    // endpoint complete in the order they were issued, so draining this as a
    // FIFO keeps the byte order intact — and each one carries its own status
    // header, so they stay independently strippable. See READ_PIPELINE_DEPTH
    // for why more than one has to be outstanding.
    let inFlight: Promise<USBInTransferResult>[] = [];
    const topUp = () => {
      while (inFlight.length < READ_PIPELINE_DEPTH && !isClosed()) {
        const transfer = device.transferIn(inEndpoint, packetSize);
        // close() aborts whatever is still queued. The pull path below awaits
        // `transfer` itself and reports the failure properly; this handler
        // exists only so a transfer nobody got to await cannot surface as an
        // unhandled rejection during teardown.
        transfer.catch(() => {});
        inFlight.push(transfer);
      }
    };
    this.readable = new ReadableStream({
      // CRITICAL: pull must not resolve until it has enqueued payload. The
      // FTDI chip completes a bulk IN transfer with a 2-byte status header
      // (and usually nothing else) every latency-timer tick; per the Streams
      // spec, a pull that resolves WITHOUT enqueuing is never re-invoked
      // until a new read request or enqueue occurs — so returning early on a
      // status-only packet wedged the read path permanently after the first
      // idle packet. Loop over status-only packets and stalls instead.
      //
      // Each transfer asks for exactly one packet, which on this chip is not
      // just a throughput choice: the status header repeats per packet, so a
      // multi-packet reply would arrive with headers buried mid-buffer.
      // Throughput comes from queue depth instead.
      pull: async (controller) => {
        try {
          while (!isClosed()) {
            // Topping up here, before every shift, is what guarantees the queue
            // is non-empty unless the port is closing — a pull that returns
            // without enqueuing is never called again.
            topUp();
            const transfer = inFlight.shift();
            if (!transfer) {
              return;
            }
            const result = await transfer;
            if (result.status === "stall") {
              // A stalled IN endpoint returns "stall" forever until the halt
              // is cleared; without this the read path goes permanently silent.
              //
              // Retire the pre-stall queue first. clearHalt() cancels every
              // transfer outstanding on the interface, and Chromium surfaces a
              // cancellation as a *rejected* promise (AbortError), not as a
              // result carrying a status — so leaving those queued means the
              // next shift awaits a cancelled transfer, whose rejection reaches
              // the catch below and errors the stream permanently. The dropped
              // promises already carry a no-op catch, so their rejections stay
              // handled, and the loop refills only once the endpoint is healthy.
              // Nothing is awaited here: a device that never retires its queued
              // transfers must not be able to wedge the read path.
              inFlight = [];
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
        inFlight = [];
      },
    // A stream that queues only one chunk puts the consumer's own work on the
    // critical path: nothing is re-queued on the endpoint until it has taken
    // the previous packet. Buffering a pipeline's worth lets pull keep cycling
    // transfers while the consumer is busy.
    }, new CountQueuingStrategy({ highWaterMark: READ_PIPELINE_DEPTH }));

    // Every byte of each chunk, or an error: a stalled or short bulk OUT
    // transfer resolves rather than rejects, so it is checked (writeBulkOut).
    this.writable = new WritableStream<Uint8Array<ArrayBuffer>>({
      write: (chunk) => writeBulkOut(device, outEndpoint, chunk, "FTDI"),
    });
  }

  async close() {
    this._unwatchDisconnect();
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
    // A closed port has no streams, as on Web Serial.
    this.readable = null;
    this.writable = null;
  }
}

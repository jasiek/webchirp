// WCH CH340/CH341 USB-UART driver implemented over WebUSB, exposing the same
// subset of the Web Serial `SerialPort` interface as the FTDI and PL2303
// drivers (open, readable, writable, setSignals, getInfo, close) so
// BrowserSerialBridge can use any of them interchangeably.
//
// Protocol reference: the Linux kernel driver (drivers/usb/serial/ch341.c),
// cross-checked against usb-serial-for-android's Ch34xSerialDriver. The chip
// speaks vendor control requests on the default endpoint; the bulk IN endpoint
// carries raw UART payload with no status header (modem status arrives on a
// separate interrupt endpoint, which this driver does not read).

// The CH340/CH341 family ships under several vendor/product id pairs — WCH's
// own, plus the QinHeng/clone ids the kernel's id_table also claims.
export const CH340_DEVICE_IDS = [
  { vendorId: 0x1a86, productId: 0x5523 }, // CH341 in serial mode
  { vendorId: 0x1a86, productId: 0x7522 }, // CH340K
  { vendorId: 0x1a86, productId: 0x7523 }, // CH340G/CH340C — the common cable
  { vendorId: 0x2184, productId: 0x0057 },
  { vendorId: 0x4348, productId: 0x5523 },
  { vendorId: 0x9986, productId: 0x7523 },
];

// Vendor requests (bmRequestType vendor|device for both directions).
const REQ_READ_VERSION = 0x5f;
const REQ_WRITE_REG = 0x9a;
const REQ_READ_REG = 0x95;
const REQ_SERIAL_INIT = 0xa1;
const REQ_MODEM_CTRL = 0xa4;

// Chip registers, addressed as a pair packed into wValue.
const REG_BREAK = 0x05;
const REG_PRESCALER = 0x12;
const REG_DIVISOR = 0x13;
const REG_LCR = 0x18;
const REG_LCR2 = 0x25;

// Line control bits. 8 data bits, no parity, 1 stop bit, RX+TX enabled — the
// only framing CHIRP uses, matching the FTDI and PL2303 drivers.
const LCR_ENABLE_RX = 0x80;
const LCR_ENABLE_TX = 0x40;
const LCR_CS8 = 0x03;
const LCR_8N1 = LCR_ENABLE_RX | LCR_ENABLE_TX | LCR_CS8;

// Modem control bits, as held in the driver-side MCR shadow.
const MCR_DTR = 0x20;
const MCR_RTS = 0x40;

// How many single-packet bulk IN transfers to keep queued at once.
//
// With one transfer in flight the host has no IN request outstanding between a
// transfer completing and the next being issued. This chip's bulk IN endpoint
// is 32 bytes, so at 115200 a transfer has to complete every 2.8 ms — shorter
// than the round trip through Chrome's USB IPC on Android — and the chip's RX
// FIFO overruns in the gap, dropping bytes with no error anywhere. Queueing
// several transfers means one is always outstanding.
//
// Measured on a Pixel 10 (Chrome 151) against a CH340G at 115200, echoing 16 KB
// through a TX-RX bridge, six runs each: depth 1 lost bytes on all six, depth 4
// on two, depth 8 on none. 9600 and 57600 never lost a byte at any depth — this
// is a latency problem, and it only bites at the top of the range.
//
// The depth is also the cushion for a main-thread stall: at 115200 each queued
// packet is 2.8 ms of slack, so 16 absorbs a ~45 ms hiccup. Depth 8 survived the
// isolated benchmark but still dropped a packet during a full suite run, where
// the consumer is doing real work between reads.
const READ_PIPELINE_DEPTH = 16;

// Baud generator: baud = 48 MHz / (2^(12 - 3*ps - fact) * div).
const CLOCK_RATE = 48000000;
const MIN_BAUD_RATE = 46;
const MAX_BAUD_RATE = 3000000;

function clockDivisor(ps, fact) {
  return 1 << (12 - 3 * ps - fact);
}

// Lowest rate each prescaler can reach (with fact = 1 and the largest usable
// divisor). Truncated like the kernel's integer division.
const MIN_RATES = [0, 1, 2, 3].map(
  (ps) => Math.floor(CLOCK_RATE / (clockDivisor(ps, 1) * 512)),
);

export function isCh340Device(device) {
  if (!device) {
    return false;
  }
  return CH340_DEVICE_IDS.some(
    (id) => id.vendorId === Number(device.vendorId)
      && id.productId === Number(device.productId),
  );
}

// Port of the kernel's ch341_get_divisor(). Returns the 16-bit value written
// as wIndex alongside the prescaler/divisor register pair: high byte is the
// divisor complement (register 0x13), low byte the prescaler and fact bits
// (register 0x12). `limitedPrescaler` is the quirk seen on clone silicon that
// cannot drive the faster base clocks.
export function ch340GetDivisor(baudRate, { limitedPrescaler = false } = {}) {
  const requested = Number(baudRate);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`Invalid CH340 baud rate: ${baudRate}`);
  }
  // Clamping to the supported range makes the div sanity checks below
  // unreachable for any in-range request, exactly as in the kernel.
  const speed = Math.min(Math.max(Math.trunc(requested), MIN_BAUD_RATE), MAX_BAUD_RATE);

  // Start from the highest base clock (fact = 1) whose divisor stays below 512.
  let fact = 1;
  let ps = 3;
  for (; ps >= 0; ps--) {
    if (speed > MIN_RATES[ps]) {
      break;
    }
  }
  if (ps < 0) {
    throw new Error(`Unsupported CH340 baud rate: ${baudRate}`);
  }

  let clkDiv = clockDivisor(ps, fact);
  let div = Math.floor(CLOCK_RATE / (clkDiv * speed));

  // Some devices require the lower base clock whenever the prescaler is fast.
  const forceFact0 = ps < 3 && limitedPrescaler;
  if (div < 9 || div > 255 || forceFact0) {
    div = Math.floor(div / 2);
    clkDiv *= 2;
    fact = 0;
  }
  if (div < 2) {
    throw new Error(`Unsupported CH340 baud rate: ${baudRate}`);
  }

  // Round to the neighbouring divisor when it lands closer to the request.
  // Scaled by 16 so low rates do not lose the comparison to truncation.
  const errorLow = Math.floor((16 * CLOCK_RATE) / (clkDiv * div)) - 16 * speed;
  const errorHigh = 16 * speed - Math.floor((16 * CLOCK_RATE) / (clkDiv * (div + 1)));
  if (errorLow >= errorHigh) {
    div += 1;
  }

  // Prefer the lower base clock when the divisor is even: same rate, and the
  // receiver tolerates more error.
  if (fact === 1 && div % 2 === 0) {
    div /= 2;
    fact = 0;
  }

  return ((0x100 - div) << 8) | (fact << 2) | ps;
}

export class Ch340SerialPort {
  // This driver programs the line at 8N1 and nothing reads open()'s
  // dataBits/stopBits/parity: the LCR pair is written LCR_8N1 unconditionally.
  // Declared so the bridge refuses a framing change on this transport
  // rather than reopening and reporting a success the wire does not have.
  supportsFraming = false;

  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.version = 0;
    this._interfaceNumber = 0;
    this._inEndpoint = 0;
    this._outEndpoint = 0;
    this._inPacketSize = 32;
    this._modemControl = 0;
    this.limitedPrescaler = false;
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
      throw new Error(
        `CH340 control request 0x${request.toString(16)} failed: ${result.status}`,
      );
    }
  }

  async _controlIn(request, value, index, length) {
    const result = await this.device.controlTransferIn({
      requestType: "vendor",
      recipient: "device",
      request,
      value,
      index,
    }, length);
    if (result && result.status && result.status !== "ok") {
      throw new Error(
        `CH340 control read 0x${request.toString(16)} failed: ${result.status}`,
      );
    }
    return result?.data || null;
  }

  // Chip version, as reported by the version request (0x27 on older CH341A,
  // 0x30+ on CH340G/CH340C-era parts). It gates two protocol details below.
  async _readVersion() {
    const data = await this._controlIn(REQ_READ_VERSION, 0, 0, 2);
    if (!data || data.byteLength < 1) {
      throw new Error("CH340: chip version request returned no data");
    }
    return data.getUint8(0);
  }

  // Clone silicon that rejects register reads outright also cannot drive the
  // faster prescaler base clocks; the kernel infers both from the same probe.
  async _detectLimitedPrescaler() {
    try {
      const data = await this._controlIn(REQ_READ_REG, REG_BREAK, 0, 2);
      return !data || data.byteLength < 2;
    } catch {
      return true;
    }
  }

  async _setBaudRateAndLineControl(baudRate) {
    let value = ch340GetDivisor(baudRate, { limitedPrescaler: this.limitedPrescaler });
    // The CH341A holds data back until a full 32-byte endpoint packet has been
    // received unless bit 7 is set. Chips at version 0x27 and below want the
    // bit clear (at least one such part has the meaning inverted).
    if (this.version > 0x27) {
      value |= 0x80;
    }
    await this._controlOut(REQ_WRITE_REG, (REG_DIVISOR << 8) | REG_PRESCALER, value);

    // Chips before version 0x30 configured framing through separate registers;
    // the driver leaves them at their 8N1 power-on defaults. From 0x30 up, the
    // LCR pair carries framing and LCR2 is always zero.
    if (this.version < 0x30) {
      return;
    }
    await this._controlOut(REQ_WRITE_REG, (REG_LCR2 << 8) | REG_LCR, LCR_8N1);
  }

  // The chip takes the modem control lines inverted, in wValue.
  async _writeModemControl(lines) {
    await this._controlOut(REQ_MODEM_CTRL, ~lines & 0xffff, 0);
    this._modemControl = lines;
  }

  async open(options = {}) {
    const baudRate = Number(options.baudRate) || 9600;
    // close() latches _closed and the read loop exits as soon as it is set;
    // reopening the same port object needs it cleared or no byte ever arrives.
    this._closed = false;

    try {
      await this.device.open();
    } catch (error) {
      throw new Error(`CH340: could not open USB device: ${error?.message || error}`);
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
        `CH340: could not claim USB interface ${this._interfaceNumber} `
        + `(another driver may already control it): ${error?.message || error}`,
      );
    }

    // The interface exposes an interrupt IN endpoint (modem status) alongside
    // the bulk data pair — select the bulk endpoints explicitly.
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
        `CH340: bulk IN/OUT endpoints not found on interface ${this._interfaceNumber}`,
      );
    }

    this.version = await this._readVersion();
    await this._controlOut(REQ_SERIAL_INIT, 0, 0);
    this.limitedPrescaler = await this._detectLimitedPrescaler();
    await this._setBaudRateAndLineControl(baudRate);
    // Start with both control lines deasserted and the shadow in sync, so the
    // first setSignals() call always reflects what the chip is actually doing.
    await this._writeModemControl(0);

    this._setupStreams();
  }

  // Web Serial-style signal control: only the provided keys change; the chip
  // takes an absolute DTR|RTS value, so unspecified lines keep cached state.
  async setSignals(signals = {}) {
    let lines = this._modemControl;
    if (signals.dataTerminalReady !== undefined) {
      lines = signals.dataTerminalReady ? lines | MCR_DTR : lines & ~MCR_DTR;
    }
    if (signals.requestToSend !== undefined) {
      lines = signals.requestToSend ? lines | MCR_RTS : lines & ~MCR_RTS;
    }
    if (lines === this._modemControl) {
      return;
    }
    await this._writeModemControl(lines);
  }

  _setupStreams() {
    const device = this.device;
    const inEndpoint = this._inEndpoint;
    const outEndpoint = this._outEndpoint;
    const packetSize = this._inPacketSize;
    const isClosed = () => this._closed;

    // Bulk IN transfers queued on the endpoint, oldest first. Transfers on one
    // endpoint complete in the order they were issued, so draining this as a
    // FIFO keeps the byte order intact.
    let inFlight = [];
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
      // pull must not resolve until it has enqueued data (a pull that resolves
      // without enqueuing is never re-invoked — the deadlock hit in the FTDI
      // driver). CH340 bulk IN carries raw payload with no status header, so
      // any non-empty packet is data.
      //
      // Every transfer asks for exactly one packet, never more. A bulk IN
      // transfer ends on a short packet or on the full requested length, and
      // this chip sends nothing to terminate one, so a multi-packet request
      // strands any reply whose length is an exact multiple of the packet size:
      // measured against a 512-byte request, 32-, 64- and 96-byte replies never
      // arrived at all. Throughput has to come from depth, not transfer size.
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
              // Retire the pre-stall queue before clearing the halt. clearHalt()
              // cancels every transfer outstanding on the interface, and Chromium
              // surfaces a cancellation as a *rejected* promise (AbortError), not
              // as a result carrying a status — so leaving those queued means the
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
              throw new Error("CH340: babble on bulk IN endpoint (device sent more data than requested)");
            }
            if (result.status === "ok" && result.data && result.data.byteLength > 0) {
              controller.enqueue(new Uint8Array(
                result.data.buffer,
                result.data.byteOffset,
                result.data.byteLength,
              ));
              return;
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
    // the previous 32 bytes. Buffering a pipeline's worth lets pull keep
    // cycling transfers while the consumer is busy, which is what stopped the
    // suite dropping a packet mid-run on a 16 KB transfer.
    }, new CountQueuingStrategy({ highWaterMark: READ_PIPELINE_DEPTH }));

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

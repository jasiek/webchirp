// Silicon Labs CP2102 (CP210x family) USB-UART driver implemented over WebUSB,
// exposing the same subset of the Web Serial `SerialPort` interface as the
// FTDI, PL2303 and CH340 drivers (open, readable, writable, setSignals,
// getInfo, close) so BrowserSerialBridge can use any of them interchangeably.
//
// Protocol reference: the Linux kernel driver (drivers/usb/serial/cp210x.c),
// itself derived from AN978 (CP210x USB-to-UART API specification). The chip
// speaks vendor control requests addressed to the *interface* — unlike the
// CH340's device-recipient requests — and the bulk IN endpoint carries raw
// UART payload with no status header, provided event-insertion mode is off.
// This driver never enables event mode, so 0xEC is an ordinary data byte.

// Silicon Labs' vendor id. Unlike WCH's 0x1a86 — which also covers CH9102/CH343
// parts that enumerate as CDC-ACM and must fall through to the polyfill — every
// serial device under 0x10c4 in the kernel's id_table is a CP210x bridge, so a
// vendor-wide filter is accurate here and catches the OEM cables that ship with
// custom product ids (the kernel lists ~150 of them). The exception is the
// CP2110, an HID-UART part Chrome will not let WebUSB claim at all; picking one
// fails at claimInterface with a clear message rather than misbehaving.
export const CP210X_VENDOR_ID = 0x10c4;

// Vendor requests, addressed to the interface (bmRequestType 0x41 / 0xc1).
const REQ_IFC_ENABLE = 0x00;
const REQ_SET_LINE_CTL = 0x03;
const REQ_SET_MHS = 0x07;
const REQ_GET_MDMSTS = 0x08;
const REQ_PURGE = 0x12;
const REQ_SET_FLOW = 0x13;
const REQ_GET_FLOW = 0x14;
const REQ_SET_BAUDRATE = 0x1e;
// The one request addressed to the device (bmRequestType 0xc0), carrying the
// register of interest in wValue.
const REQ_VENDOR_SPECIFIC = 0xff;
const VENDOR_GET_PARTNUM = 0x370b;

const UART_ENABLE = 0x0001;
const UART_DISABLE = 0x0000;
const PURGE_ALL = 0x000f;

// Line control: 8 data bits, no parity, 1 stop bit — the only framing CHIRP
// uses, matching the other three drivers.
const BITS_DATA_8 = 0x0800;
const BITS_PARITY_NONE = 0x0000;
const BITS_STOP_1 = 0x0000;
const LINE_CTL_8N1 = BITS_DATA_8 | BITS_PARITY_NONE | BITS_STOP_1;

// SET_MHS wValue / GET_MDMSTS reply bits. The write mask is what makes SET_MHS
// a partial update: a line only changes if its WRITE bit is set.
const CONTROL_DTR = 0x0001;
const CONTROL_RTS = 0x0002;
const CONTROL_CTS = 0x0010;
const CONTROL_DSR = 0x0020;
const CONTROL_RING = 0x0040;
const CONTROL_DCD = 0x0080;
const CONTROL_WRITE_DTR = 0x0100;
const CONTROL_WRITE_RTS = 0x0200;

// The 16-byte GET_FLOW/SET_FLOW block: four little-endian u32s
// (ulControlHandshake, ulFlowReplace, ulXonLimit, ulXoffLimit).
const FLOW_CTL_SIZE = 16;
const SERIAL_DTR_MASK = 0x03;
const SERIAL_DTR_ACTIVE = 0x01;
const SERIAL_CTS_HANDSHAKE = 1 << 3;
const SERIAL_DSR_HANDSHAKE = 1 << 4;
const SERIAL_DCD_HANDSHAKE = 1 << 5;
const SERIAL_DSR_SENSITIVITY = 1 << 6;
const SERIAL_AUTO_TRANSMIT = 1 << 0;
const SERIAL_AUTO_RECEIVE = 1 << 1;
const SERIAL_RTS_MASK = 0xc0;
const SERIAL_RTS_ACTIVE = 1 << 6;

// Part numbers as reported by the GET_PARTNUM vendor register. They select the
// baud generator's behaviour, nothing else this driver cares about.
export const CP210X_PARTNUM = {
  CP2101: 0x01,
  CP2102: 0x02,
  CP2103: 0x03,
  CP2104: 0x04,
  CP2105: 0x05,
  CP2108: 0x08,
  CP2102N_QFN28: 0x20,
  CP2102N_QFN24: 0x21,
  CP2102N_QFN20: 0x22,
  UNKNOWN: 0xff,
};

// How many single-packet bulk IN transfers to keep queued at once. See the
// CH340 driver for the measurements behind this: a read path with one transfer
// in flight leaves the endpoint unqueued for a full USB round trip, and the
// chip's RX FIFO overruns in that gap — silently, with `status: "ok"` and no
// error at any layer. This chip's 64-byte bulk IN endpoint gives twice the
// slack of the CH340's 32-byte one, which changes the margin, not the defect.
const READ_PIPELINE_DEPTH = 16;

export function isCp2102Device(device) {
  if (!device) {
    return false;
  }
  return Number(device.vendorId) === CP210X_VENDOR_ID;
}

// Rates the CP2101/2/3 baud generator actually produces, from AN205 Table 1:
// each entry is [rate, highest request that maps to it].
const AN205_TABLE = [
  [300, 300], [600, 600], [1200, 1200], [1800, 1800], [2400, 2400],
  [4000, 4000], [4800, 4803], [7200, 7207], [9600, 9612], [14400, 14428],
  [16000, 16062], [19200, 19250], [28800, 28912], [38400, 38601],
  [51200, 51558], [56000, 56280], [57600, 58053], [64000, 64111],
  [76800, 77608], [115200, 117028], [128000, 129347], [153600, 156868],
  [230400, 237832], [250000, 254234], [256000, 273066], [460800, 491520],
  [500000, 567138], [576000, 670254], [921600, Number.MAX_SAFE_INTEGER],
];

function an205Rate(baud) {
  const entry = AN205_TABLE.find(([, high]) => baud <= high);
  return entry ? entry[0] : AN205_TABLE[AN205_TABLE.length - 1][0];
}

// Parts from the CP2104 on derive the rate from a 48 MHz clock:
//   div = round(48e6 / (2 x prescale x request)), actual = 48e6 / (2 x prescale x div)
function actualRate(baud) {
  const prescale = baud <= 365 ? 4 : 1;
  const base = 2 * prescale * baud;
  // The kernel's DIV_ROUND_CLOSEST, in integer arithmetic.
  const div = Math.floor((48000000 + Math.floor(base / 2)) / base);
  return Math.floor(48000000 / (2 * prescale * div));
}

// Per-part line-speed limits, ported from cp210x_init_max_speed(). The CP2105
// is the one part whose two interfaces differ: ECI on interface 0, the slower
// SCI on interface 1.
export function cp2102SpeedLimits(partNumber, interfaceNumber = 0) {
  switch (partNumber) {
    case CP210X_PARTNUM.CP2101:
      return { minSpeed: 300, maxSpeed: 921600, useActualRate: false };
    case CP210X_PARTNUM.CP2102:
    case CP210X_PARTNUM.CP2103:
      return { minSpeed: 300, maxSpeed: 1000000, useActualRate: false };
    case CP210X_PARTNUM.CP2104:
      return { minSpeed: 300, maxSpeed: 2000000, useActualRate: true };
    case CP210X_PARTNUM.CP2108:
      return { minSpeed: 300, maxSpeed: 2000000, useActualRate: false };
    case CP210X_PARTNUM.CP2105:
      return interfaceNumber === 0
        ? { minSpeed: 300, maxSpeed: 2000000, useActualRate: true }
        : { minSpeed: 2400, maxSpeed: 921600, useActualRate: false };
    case CP210X_PARTNUM.CP2102N_QFN28:
    case CP210X_PARTNUM.CP2102N_QFN24:
    case CP210X_PARTNUM.CP2102N_QFN20:
      return { minSpeed: 300, maxSpeed: 3000000, useActualRate: true };
    default:
      return { minSpeed: 300, maxSpeed: 2000000, useActualRate: false };
  }
}

// The rate actually written to SET_BAUDRATE. The chip maps a request to a rate
// it can generate anyway; doing it host-side means the number reported back is
// the number on the wire, and it keeps a wild request from landing somewhere
// undefined (AN205: results above 1053257 baud are not specified).
export function cp2102QuantizeBaudRate(baudRate, {
  partNumber = CP210X_PARTNUM.UNKNOWN,
  interfaceNumber = 0,
} = {}) {
  const requested = Number(baudRate);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`Invalid CP2102 baud rate: ${baudRate}`);
  }
  const { minSpeed, maxSpeed, useActualRate } = cp2102SpeedLimits(partNumber, interfaceNumber);
  const baud = Math.min(Math.max(Math.trunc(requested), minSpeed), maxSpeed);
  if (useActualRate) {
    return actualRate(baud);
  }
  if (baud < 1000000) {
    return an205Rate(baud);
  }
  return baud;
}

export class Cp2102SerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.partNumber = CP210X_PARTNUM.UNKNOWN;
    this.baudRate = 0;
    this._interfaceNumber = 0;
    this._inEndpoint = 0;
    this._outEndpoint = 0;
    this._inPacketSize = 64;
    this._dtr = false;
    this._rts = false;
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

  // Vendor request to the interface, value carried entirely in wValue.
  async _controlOut(request, value, data) {
    const setup = {
      requestType: "vendor",
      recipient: "interface",
      request,
      value,
      index: this._interfaceNumber,
    };
    const result = data === undefined
      ? await this.device.controlTransferOut(setup)
      : await this.device.controlTransferOut(setup, data);
    if (result && result.status && result.status !== "ok") {
      throw new Error(
        `CP2102 control request 0x${request.toString(16)} failed: ${result.status}`,
      );
    }
  }

  async _controlIn(request, length, { recipient = "interface", value = 0 } = {}) {
    const result = await this.device.controlTransferIn({
      requestType: "vendor",
      recipient,
      request,
      value,
      index: this._interfaceNumber,
    }, length);
    if (result && result.status && result.status !== "ok") {
      throw new Error(
        `CP2102 control read 0x${request.toString(16)} failed: ${result.status}`,
      );
    }
    return result?.data || null;
  }

  // Part number, which selects the baud generator's behaviour. Counterfeit
  // parts answer this request oddly, so a failure downgrades to UNKNOWN (the
  // kernel's own fallback) rather than failing the open.
  async _readPartNumber() {
    try {
      const data = await this._controlIn(REQ_VENDOR_SPECIFIC, 1, {
        recipient: "device",
        value: VENDOR_GET_PARTNUM,
      });
      if (!data || data.byteLength < 1) {
        return CP210X_PARTNUM.UNKNOWN;
      }
      return data.getUint8(0);
    } catch {
      return CP210X_PARTNUM.UNKNOWN;
    }
  }

  async _setBaudRate(baudRate) {
    const rate = cp2102QuantizeBaudRate(baudRate, {
      partNumber: this.partNumber,
      interfaceNumber: this._interfaceNumber,
    });
    const data = new DataView(new ArrayBuffer(4));
    data.setUint32(0, rate, true);
    await this._controlOut(REQ_SET_BAUDRATE, 0, data);
    this.baudRate = rate;
  }

  // Disable every handshake the chip can do on its own: hardware flow control
  // would let the radio's control lines gate our transmit, and XON/XOFF would
  // eat 0x11/0x13 out of a clone image. DTR and RTS stay under setSignals().
  //
  // Read-modify-write, as the kernel does, so the reserved bits and the chip's
  // own Xon/Xoff limits survive; a chip that will not answer GET_FLOW gets a
  // block built from scratch instead.
  async _setFlowControl() {
    let block;
    try {
      const current = await this._controlIn(REQ_GET_FLOW, FLOW_CTL_SIZE);
      block = current && current.byteLength >= FLOW_CTL_SIZE
        ? new DataView(current.buffer.slice(
          current.byteOffset,
          current.byteOffset + FLOW_CTL_SIZE,
        ))
        : null;
    } catch {
      block = null;
    }
    if (!block) {
      block = new DataView(new ArrayBuffer(FLOW_CTL_SIZE));
      // The SiLabs defaults for the FIFO thresholds the chip only uses when
      // XON/XOFF is on; written so a constructed block is not all zeroes.
      block.setUint32(8, 0x80, true);
      block.setUint32(12, 0x80, true);
    }

    let controlHandshake = block.getUint32(0, true);
    let flowReplace = block.getUint32(4, true);

    controlHandshake &= ~(
      SERIAL_CTS_HANDSHAKE | SERIAL_DSR_HANDSHAKE
      | SERIAL_DCD_HANDSHAKE | SERIAL_DSR_SENSITIVITY | SERIAL_DTR_MASK
    );
    if (this._dtr) {
      controlHandshake |= SERIAL_DTR_ACTIVE;
    }
    flowReplace &= ~(SERIAL_RTS_MASK | SERIAL_AUTO_TRANSMIT | SERIAL_AUTO_RECEIVE);
    if (this._rts) {
      flowReplace |= SERIAL_RTS_ACTIVE;
    }

    block.setUint32(0, controlHandshake >>> 0, true);
    block.setUint32(4, flowReplace >>> 0, true);
    await this._controlOut(REQ_SET_FLOW, 0, block);
  }

  // SET_MHS carries a write mask, so only the lines named here change.
  async _writeModemControl({ dtr, rts }) {
    let control = 0;
    if (dtr !== undefined) {
      control |= CONTROL_WRITE_DTR;
      if (dtr) {
        control |= CONTROL_DTR;
      }
      this._dtr = Boolean(dtr);
    }
    if (rts !== undefined) {
      control |= CONTROL_WRITE_RTS;
      if (rts) {
        control |= CONTROL_RTS;
      }
      this._rts = Boolean(rts);
    }
    await this._controlOut(REQ_SET_MHS, control);
  }

  async open(options = {}) {
    const baudRate = Number(options.baudRate) || 9600;
    // close() latches _closed and the read loop exits as soon as it is set;
    // reopening the same port object needs it cleared or no byte ever arrives.
    this._closed = false;

    try {
      await this.device.open();
    } catch (error) {
      throw new Error(`CP2102: could not open USB device: ${error?.message || error}`);
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
        `CP2102: could not claim USB interface ${this._interfaceNumber} `
        + `(another driver may already control it): ${error?.message || error}`,
      );
    }

    // Select the bulk pair explicitly rather than by direction: parts in this
    // family that expose GPIO or a second UART carry other endpoint types on
    // the same interface.
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
        `CP2102: bulk IN/OUT endpoints not found on interface ${this._interfaceNumber}`,
      );
    }

    this.partNumber = await this._readPartNumber();
    // Enabling the interface also clears event-insertion mode, so whatever a
    // previous driver left the chip in, the bulk IN stream is raw payload.
    await this._controlOut(REQ_IFC_ENABLE, UART_ENABLE);
    await this._setBaudRate(baudRate);
    await this._controlOut(REQ_SET_LINE_CTL, LINE_CTL_8N1);
    // Start with both control lines deasserted and the shadow in sync, so the
    // first setSignals() call always reflects what the chip is actually doing.
    // The flow block carries DTR/RTS as well, so it is written first and
    // SET_MHS then leaves the two in agreement.
    this._dtr = false;
    this._rts = false;
    await this._setFlowControl();
    await this._writeModemControl({ dtr: false, rts: false });

    this._setupStreams();
  }

  // Web Serial-style signal control: only the provided keys change.
  async setSignals(signals = {}) {
    const dtr = signals.dataTerminalReady;
    const rts = signals.requestToSend;
    // A line the caller did not name, or named at the value it already holds,
    // is left out of the write mask entirely — so a no-op call costs nothing
    // and a single-line change cannot disturb the other one.
    const setsDtr = dtr !== undefined && Boolean(dtr) !== this._dtr;
    const setsRts = rts !== undefined && Boolean(rts) !== this._rts;
    if (!setsDtr && !setsRts) {
      return;
    }
    await this._writeModemControl({
      dtr: setsDtr ? Boolean(dtr) : undefined,
      rts: setsRts ? Boolean(rts) : undefined,
    });
  }

  // Input control lines, which the other three WebUSB drivers cannot report at
  // all — this family answers GET_MDMSTS with a single byte carrying both the
  // output lines it is driving and the input lines it sees.
  async getSignals() {
    const data = await this._controlIn(REQ_GET_MDMSTS, 1);
    if (!data || data.byteLength < 1) {
      throw new Error("CP2102: modem status request returned no data");
    }
    const status = data.getUint8(0);
    return {
      clearToSend: Boolean(status & CONTROL_CTS),
      dataSetReady: Boolean(status & CONTROL_DSR),
      dataCarrierDetect: Boolean(status & CONTROL_DCD),
      ringIndicator: Boolean(status & CONTROL_RING),
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
      // driver). With event mode off, CP210x bulk IN carries raw payload and
      // no header, so any non-empty packet is data.
      //
      // Every transfer asks for exactly one packet. A bulk IN transfer ends on
      // a short packet or on the full requested length; asking for more buys
      // nothing once the queue is deep, and on a chip that does not terminate a
      // multi-packet transfer it strands every exact-multiple reply — which is
      // the shape of a fixed-size CHIRP clone block.
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
              // Retire the pre-stall queue before clearing the halt.
              // clearHalt() cancels every transfer outstanding on the
              // interface, and Chromium surfaces a cancellation as a *rejected*
              // promise (AbortError), not as a result carrying a status — so
              // leaving those queued means the next shift awaits a cancelled
              // transfer, whose rejection errors the stream permanently. The
              // dropped promises already carry a no-op catch, so their
              // rejections stay handled. Nothing is awaited here: a device that
              // never retires its queued transfers must not wedge the read path.
              inFlight = [];
              await device.clearHalt("in", inEndpoint);
              continue;
            }
            if (result.status === "babble") {
              throw new Error("CP2102: babble on bulk IN endpoint (device sent more data than requested)");
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
    // the previous packet. Buffering a pipeline's worth lets pull keep cycling
    // transfers while the consumer is busy.
    }, new CountQueuingStrategy({ highWaterMark: READ_PIPELINE_DEPTH }));

    this.writable = new WritableStream({
      write: async (chunk) => {
        await device.transferOut(outEndpoint, chunk);
      },
    });
  }

  async close() {
    this._closed = true;
    // Clear both FIFOs before disabling the UART — the CP2108 occasionally
    // hangs without it — then disable the interface, which also takes the chip
    // out of event-insertion mode if anything ever turned it on.
    try {
      await this._controlOut(REQ_PURGE, PURGE_ALL);
    } catch {
      // Device may already be gone.
    }
    try {
      await this._controlOut(REQ_IFC_ENABLE, UART_DISABLE);
    } catch {
      // Device may already be gone.
    }
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

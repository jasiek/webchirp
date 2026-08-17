// Prolific PL2303 USB-UART driver implemented over WebUSB, exposing the same
// subset of the Web Serial `SerialPort` interface as the FTDI driver (open,
// readable, writable, setSignals, getInfo, close) so BrowserSerialBridge can
// use either interchangeably.
//
// Protocol references: the Linux kernel driver (drivers/usb/serial/pl2303.c)
// and usb-serial-for-android's ProlificSerialDriver, cross-checked against the
// MIT-licensed WebUSB ports descended from andreasgal/usbserial
// (tidepool-org/pl2303, Folleon/pl2303-webusb, emcee5601/pl2303). Note two
// deliberate divergences from those ports, matching the kernel instead:
// vendor writes use bmRequestType vendor|device (not class), and vendor reads
// use bRequest 0x01 on non-HXN chips (0x81 is HXN-only).

export const PROLIFIC_VENDOR_ID = 0x067b;

// Chip generations. Newer "HXN" silicon (PL2303GC/GB/GT/GL/GE/GS, ~2018+)
// uses a different vendor-request register map and must skip the legacy
// startup sequence entirely.
export const PL2303_TYPE_01 = "01"; // original PL2303 (type 0/1)
export const PL2303_TYPE_HX = "HX"; // HX/HXA/HXD/EA/RA/SA/TA-era classic
export const PL2303_TYPE_T = "T"; // TA/TB
export const PL2303_TYPE_HXN = "HXN"; // GC/GB/GT/GL/GE/GS

// How many single-packet bulk IN transfers to keep queued at once.
//
// With one transfer in flight the host has no IN request outstanding between
// one completing and the next being issued, and the chip's RX FIFO overruns in
// that gap — silently, with status "ok" and no error at any layer. This chip's
// 64-byte endpoint gives twice the slack of the CH340's 32-byte one, so it only
// shows up on sustained transfers: measured on a Pixel 10 (Chrome 151) against
// a PL2303HX, the loopback suite's 16 KB echo at 115200 lost bytes on 3 of 10
// runs with a single transfer outstanding, and on none once queued.
//
// Linux never had the problem: pl2303 sets no bulk_in_size and no read
// callback, so it inherits read_urbs[2] (include/linux/usb/serial.h) — both
// submitted at open and each resubmitted from its own completion callback.
// Depth 2 suffices when the resubmit runs in interrupt context; a JS resubmit
// crosses Chrome's IPC boundary and the event loop, hence the deeper queue.
const READ_PIPELINE_DEPTH = 16;

// Legacy (non-HXN) vendor requests.
const VENDOR_READ_REQUEST = 0x01;
const VENDOR_WRITE_REQUEST = 0x01;
// HXN vendor requests.
const VENDOR_READ_HXN_REQUEST = 0x81;
const VENDOR_WRITE_HXN_REQUEST = 0x80;
const RESET_HXN_REQUEST = 0x07;
const RESET_HXN_RX_PIPE = 0x01;
const RESET_HXN_TX_PIPE = 0x02;
const FLOWCONTROL_HXN_REGISTER = 0x0a;
const FLOWCONTROL_HXN_NONE = 0xff;

// CDC-style class requests on the interface (shared by all chip types).
const GET_LINE_REQUEST = 0x21;
const SET_LINE_REQUEST = 0x20;
const SET_CONTROL_REQUEST = 0x22;
const CONTROL_DTR = 0x01;
const CONTROL_RTS = 0x02;

// Baud rates the chips accept directly in the line-coding request.
const SUPPORTED_BAUD_RATES = [
  75, 150, 300, 600, 1200, 1800, 2400, 3600,
  4800, 7200, 9600, 14400, 19200, 28800, 38400,
  57600, 115200, 230400, 460800, 614400,
  921600, 1228800, 2457600, 3000000, 6000000,
];

export function isProlificDevice(device) {
  return Boolean(device) && Number(device.vendorId) === PROLIFIC_VENDOR_ID;
}

// Nearest directly-supported baud rate (all common radio bauds are exact).
export function pickPl2303BaudRate(baudRate) {
  const baud = Number(baudRate);
  if (!Number.isFinite(baud) || baud <= 0) {
    throw new Error(`Invalid PL2303 baud rate: ${baudRate}`);
  }
  return SUPPORTED_BAUD_RATES.reduce((best, candidate) =>
    Math.abs(candidate - baud) < Math.abs(best - baud) ? candidate : best,
  );
}

// Chip-generation detection ladder, following usb-serial-for-android's
// ProlificSerialDriver.setDeviceType(). `hxStatus` is the result of probing
// the legacy vendor-read register 0x8080 (HXN chips reject that request).
export function detectPl2303Type({ deviceClass, maxPacketSize0, usbVersion, deviceVersion, hxStatus }) {
  if (Number(deviceClass) === 0x02 || Number(maxPacketSize0) !== 64) {
    return PL2303_TYPE_01;
  }
  if (Number(deviceVersion) === 0x300 && Number(usbVersion) === 0x200) {
    return PL2303_TYPE_T; // TA
  }
  if (Number(deviceVersion) === 0x500) {
    return PL2303_TYPE_T; // TB
  }
  if (Number(usbVersion) === 0x200 && !hxStatus) {
    return PL2303_TYPE_HXN;
  }
  return PL2303_TYPE_HX;
}

export class Pl2303SerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.chipType = PL2303_TYPE_HX;
    this._interfaceNumber = 0;
    this._inEndpoint = 0;
    this._outEndpoint = 0;
    this._inPacketSize = 64;
    this._controlLines = 0;
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

  _isHxn() {
    return this.chipType === PL2303_TYPE_HXN;
  }

  async _vendorRead(value, index) {
    const result = await this.device.controlTransferIn({
      requestType: "vendor",
      recipient: "device",
      request: this._isHxn() ? VENDOR_READ_HXN_REQUEST : VENDOR_READ_REQUEST,
      value,
      index,
    }, 1);
    if (result && result.status && result.status !== "ok") {
      throw new Error(`PL2303 vendor read failed (value 0x${value.toString(16)}): ${result.status}`);
    }
    return result;
  }

  async _vendorWrite(value, index) {
    const result = await this.device.controlTransferOut({
      requestType: "vendor",
      recipient: "device",
      request: this._isHxn() ? VENDOR_WRITE_HXN_REQUEST : VENDOR_WRITE_REQUEST,
      value,
      index,
    });
    if (result && result.status && result.status !== "ok") {
      throw new Error(`PL2303 vendor write failed (value 0x${value.toString(16)}): ${result.status}`);
    }
  }

  async _classInterfaceOut(request, value, data) {
    const result = await this.device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request,
      value,
      index: this._interfaceNumber,
    }, data);
    if (result && result.status && result.status !== "ok") {
      throw new Error(`PL2303 class request 0x${request.toString(16)} failed: ${result.status}`);
    }
  }

  // Probe the legacy vendor-read register: succeeds on HX-family chips,
  // rejected by HXN silicon. Used only for chip-type detection.
  async _probeHxStatus() {
    try {
      await this.device.controlTransferIn({
        requestType: "vendor",
        recipient: "device",
        request: VENDOR_READ_REQUEST,
        value: 0x8080,
        index: 0,
      }, 1);
      return true;
    } catch {
      return false;
    }
  }

  // Read the raw device descriptor: WebUSB does not expose bMaxPacketSize0,
  // and bcdUSB/bcdDevice are needed as raw words for the detection ladder.
  async _readDeviceDescriptor() {
    try {
      const result = await this.device.controlTransferIn({
        requestType: "standard",
        recipient: "device",
        request: 0x06, // GET_DESCRIPTOR
        value: 0x0100, // DEVICE descriptor, index 0
        index: 0,
      }, 18);
      const bytes = result?.data;
      if (bytes && bytes.byteLength >= 14) {
        return {
          usbVersion: (bytes.getUint8(3) << 8) | bytes.getUint8(2),
          deviceClass: bytes.getUint8(4),
          maxPacketSize0: bytes.getUint8(7),
          deviceVersion: (bytes.getUint8(13) << 8) | bytes.getUint8(12),
        };
      }
    } catch {
      // Fall through to the WebUSB-attribute fallback below.
    }
    return {
      usbVersion: (Number(this.device.usbVersionMajor) << 8)
        | ((Number(this.device.usbVersionMinor) & 0x0f) << 4),
      deviceClass: Number(this.device.deviceClass),
      maxPacketSize0: 64,
      deviceVersion: (Number(this.device.deviceVersionMajor) << 8)
        | ((Number(this.device.deviceVersionMinor) & 0x0f) << 4),
    };
  }

  // The undocumented startup handshake every non-HXN driver performs
  // (kernel pl2303.c calls this sequence out as required chip init).
  async _legacyStartup() {
    await this._vendorRead(0x8484, 0);
    await this._vendorWrite(0x0404, 0);
    await this._vendorRead(0x8484, 0);
    await this._vendorRead(0x8383, 0);
    await this._vendorRead(0x8484, 0);
    await this._vendorWrite(0x0404, 1);
    await this._vendorRead(0x8484, 0);
    await this._vendorRead(0x8383, 0);
    await this._vendorWrite(0, 1);
    await this._vendorWrite(1, 0);
    await this._vendorWrite(2, this.chipType === PL2303_TYPE_01 ? 0x24 : 0x44);
  }

  async _purgeBuffers() {
    if (this._isHxn()) {
      await this._vendorWrite(RESET_HXN_REQUEST, RESET_HXN_RX_PIPE | RESET_HXN_TX_PIPE);
    } else {
      await this._vendorWrite(8, 0); // reset upstream data pipe
      await this._vendorWrite(9, 0); // reset downstream data pipe
    }
  }

  async _setFlowControlNone() {
    if (this._isHxn()) {
      await this._vendorWrite(FLOWCONTROL_HXN_REGISTER, FLOWCONTROL_HXN_NONE);
    } else {
      await this._vendorWrite(0, 0);
    }
  }

  // CDC-style line coding: LE32 baud, 1 stop bit, no parity, 8 data bits.
  async _setLineCoding(baudRate) {
    // Read current coding first, as every known driver does before setting.
    await this.device.controlTransferIn({
      requestType: "class",
      recipient: "interface",
      request: GET_LINE_REQUEST,
      value: 0,
      index: this._interfaceNumber,
    }, 7);
    const coding = new DataView(new ArrayBuffer(7));
    coding.setUint32(0, pickPl2303BaudRate(baudRate), true);
    coding.setUint8(4, 0); // 1 stop bit
    coding.setUint8(5, 0); // no parity
    coding.setUint8(6, 8); // 8 data bits
    await this._classInterfaceOut(SET_LINE_REQUEST, 0, coding.buffer);
  }

  async open(options = {}) {
    const baudRate = Number(options.baudRate) || 9600;
    // close() latches _closed and the read loop exits as soon as it is set;
    // reopening the same port object needs it cleared or no byte ever arrives.
    this._closed = false;

    try {
      await this.device.open();
    } catch (error) {
      throw new Error(`PL2303: could not open USB device: ${error?.message || error}`);
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
        `PL2303: could not claim USB interface ${this._interfaceNumber} `
        + `(another driver may already control it): ${error?.message || error}`,
      );
    }

    // The PL2303 exposes an interrupt IN endpoint (modem status) alongside
    // the bulk data pair — select bulk endpoints explicitly.
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
      throw new Error("PL2303: bulk IN/OUT endpoints not found on interface 0");
    }

    const descriptor = await this._readDeviceDescriptor();
    // Only probe the legacy register when the ladder actually needs it.
    const needsProbe =
      Number(descriptor.deviceClass) !== 0x02
      && Number(descriptor.maxPacketSize0) === 64
      && Number(descriptor.usbVersion) === 0x200
      && Number(descriptor.deviceVersion) !== 0x300
      && Number(descriptor.deviceVersion) !== 0x500;
    const hxStatus = needsProbe ? await this._probeHxStatus() : true;
    this.chipType = detectPl2303Type({ ...descriptor, hxStatus });

    if (!this._isHxn()) {
      await this._legacyStartup();
    }
    await this._purgeBuffers();
    await this._setFlowControlNone();
    await this._setLineCoding(baudRate);

    this._setupStreams();
  }

  // Web Serial-style signal control: only the provided keys change; the chip
  // takes an absolute DTR|RTS value, so unspecified lines keep cached state.
  async setSignals(signals = {}) {
    let lines = this._controlLines;
    if (signals.dataTerminalReady !== undefined) {
      lines = signals.dataTerminalReady ? lines | CONTROL_DTR : lines & ~CONTROL_DTR;
    }
    if (signals.requestToSend !== undefined) {
      lines = signals.requestToSend ? lines | CONTROL_RTS : lines & ~CONTROL_RTS;
    }
    if (lines === this._controlLines) {
      return;
    }
    await this._classInterfaceOut(SET_CONTROL_REQUEST, lines, undefined);
    this._controlLines = lines;
  }

  _setupStreams() {
    const device = this.device;
    const inEndpoint = this._inEndpoint;
    const outEndpoint = this._outEndpoint;
    const packetSize = this._inPacketSize;
    const isClosed = () => this._closed;

    // Bulk IN transfers queued on the endpoint, oldest first. Transfers on one
    // endpoint complete in the order they were issued, so draining this as a
    // FIFO keeps the byte order intact. See READ_PIPELINE_DEPTH for why more
    // than one has to be outstanding.
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
      // pull must not resolve until it has enqueued data (a pull that
      // resolves without enqueuing is never re-invoked — the deadlock we hit
      // in the FTDI driver). PL2303 bulk IN carries raw payload with no
      // status header, so any non-empty packet is data.
      //
      // Each transfer asks for exactly one packet. This chip does terminate a
      // multi-packet transfer properly, unlike the CH340 — but a request that
      // spans packets can only ever end on a short packet or an exact fill, and
      // there is nothing to gain from it once the queue is deep enough.
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
              // Never wait for the rest of the queue here: a device that does
              // not retire its queued transfers would wedge the read path for
              // good. Clearing the halt retires them anyway, and each comes
              // back stalled and is skipped on its own turn round this loop.
              await device.clearHalt("in", inEndpoint);
              continue;
            }
            if (result.status === "babble") {
              throw new Error("PL2303: babble on bulk IN endpoint (device sent more data than requested)");
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

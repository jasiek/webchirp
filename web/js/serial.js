import { createWebUsbSerial } from "./webusb-serial.js";

// Parse user-entered hex byte text into a Uint8Array for serial writes.
function parseHex(input) {
  const text = String(input || "").trim();
  if (!text) {
    return new Uint8Array(0);
  }
  const parts = text
    .replace(/[^0-9a-fA-F]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    const value = Number.parseInt(parts[i], 16);
    if (Number.isNaN(value) || value < 0 || value > 255) {
      throw new Error(`Invalid hex byte: ${parts[i]}`);
    }
    out[i] = value;
  }
  return out;
}

// Convert a byte array into uppercase space-delimited hex for display/logging.
function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

// Concatenate two Uint8Array buffers into one contiguous buffer.
function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hasNativeSerial() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

function hasWebUsb() {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

// Manage Web Serial lifecycle and provide buffered byte-oriented I/O helpers.
export class BrowserSerialBridge {
  constructor({ createWebUsbSerial: createWebUsbSerialImpl } = {}) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readBuffer = new Uint8Array(0);
    this.readWaiters = new Set();
    this.lastDeviceName = "";
    // Optional diagnostic sink (wired to the debug log by the app). The read
    // loop MUST report why it ended: a silently-dead read loop is
    // indistinguishable from "no data" and cost us a debugging session.
    this.onDebug = null;
    // The resolved Web Serial provider (native navigator.serial or the WebUSB
    // chip-aware provider) and which transport it represents, set on connect.
    this.serial = null;
    this.transport = "";
    // Which transport open() should use: "auto" (native preferred), "webserial",
    // or "webusb". Forcing "webusb" is needed where native Web Serial exists but
    // cannot drive the adapter (e.g. FTDI cables on Chrome for Android).
    this.preferredTransport = "auto";
    // Called when the browser reports that the adapter behind the open port has
    // gone away — unplugged, or powered down with the radio where the adapter
    // lives in the cable. The port is already torn down by the time it runs.
    this.onPortLost = null;
    this._portLostWatch = null;
    this._createWebUsbSerial = createWebUsbSerialImpl || createWebUsbSerial;
  }

  // Choose the transport open() will use. Resets any cached provider while
  // disconnected so the next connect re-resolves against the new preference.
  setPreferredTransport(transport) {
    this.preferredTransport =
      transport === "webusb" || transport === "webserial" ? transport : "auto";
    if (!this.port) {
      this.serial = null;
      this.transport = "";
    }
  }

  isSupported() {
    return hasNativeSerial() || hasWebUsb();
  }

  // Report what serial transport(s) this browser can offer.
  getCapability() {
    const native = hasNativeSerial();
    const webusb = hasWebUsb();
    return { supported: native || webusb, native, webusb };
  }

  // Resolve the serial provider: prefer native Web Serial, otherwise fall back
  // to the WebUSB chip-aware provider. Cached after the first call.
  async _ensureSerial() {
    if (this.serial) {
      return this.serial;
    }
    if (this.preferredTransport === "webusb") {
      if (!hasWebUsb()) {
        throw new Error("WebUSB is not supported in this browser.");
      }
      this.serial = this._createWebUsbSerial();
      this.transport = "webusb";
      return this.serial;
    }
    if (this.preferredTransport === "webserial") {
      if (!hasNativeSerial()) {
        throw new Error("Native Web Serial is not supported in this browser.");
      }
      this.serial = navigator.serial;
      this.transport = "webserial";
      return this.serial;
    }
    // Auto: prefer native Web Serial, fall back to the WebUSB chip-aware provider.
    if (hasNativeSerial()) {
      this.serial = navigator.serial;
      this.transport = "webserial";
      return this.serial;
    }
    if (hasWebUsb()) {
      this.serial = this._createWebUsbSerial();
      this.transport = "webusb";
      return this.serial;
    }
    throw new Error("Neither Web Serial nor WebUSB is supported in this browser.");
  }

  async open(baudRate) {
    // A live connection requires a writer, not just a port handle. A previous
    // attempt that failed mid-open can leave this.port set with no writer; treat
    // that as not-connected and tear it down before retrying.
    if (this.port && this.writer) {
      return {
        connected: true,
        message: "Already connected.",
        transport: this.transport,
      };
    }
    if (this.port) {
      await this._teardown();
    }

    const serial = await this._ensureSerial();
    try {
      this.port = await serial.requestPort({});
      await this.port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      });
      const identity = this._getPortIdentity(this.port);
      this.lastDeviceName = this._describePort(this.port);
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this._startReadLoop();
      this._watchForPortLoss();
      const viaWebUsb = this.transport === "webusb";
      return {
        connected: true,
        message: `Connected at ${baudRate} baud${viaWebUsb ? " (via WebUSB)" : ""}`,
        deviceName: this.lastDeviceName,
        usbVendorId: identity.usbVendorId,
        usbProductId: identity.usbProductId,
        transport: this.transport,
      };
    } catch (error) {
      // Never leave a half-open port behind; it would poison the next connect.
      await this._teardown();
      throw error;
    }
  }

  async close() {
    if (!this.port) {
      return { connected: false, message: "No port connected." };
    }
    await this._teardown();
    return { connected: false, message: "Disconnected." };
  }

  // Release reader/writer locks and close the port, clearing all session state.
  // Safe to call on a fully- or partially-open port.
  async _teardown() {
    this._unwatchPortLoss();
    try {
      await this.reader?.cancel();
    } catch {
      // Ignore cancellation errors.
    }
    try {
      this.reader?.releaseLock();
    } catch {
      // Ignore lock-release errors.
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // Ignore lock-release errors.
    }
    try {
      await this.port?.close();
    } catch {
      // Ignore close errors.
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readBuffer = new Uint8Array(0);
    this._resolveReadWaiters(false);
  }

  getPortInfo() {
    const identity = this.port ? this._getPortIdentity(this.port) : {};
    return {
      connected: Boolean(this.port),
      deviceName: this.port ? this._describePort(this.port) : this.lastDeviceName,
      usbVendorId: identity.usbVendorId,
      usbProductId: identity.usbProductId,
    };
  }

  async writeHex(hex) {
    if (!this.writer) {
      throw new Error("Port is not connected.");
    }
    const bytes = parseHex(hex);
    await this.writer.write(bytes);
    return { written: bytes.length, hex: bytesToHex(bytes) };
  }

  async writeBytes(bytesLike) {
    if (!this.writer) {
      throw new Error("Port is not connected.");
    }
    const bytes = Uint8Array.from(bytesLike || []);
    await this.writer.write(bytes);
    return { written: bytes.length };
  }

  async readHex(count, timeoutMs) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const wanted = Math.max(0, Number(count || 0));
    if (wanted === 0) {
      return { read: 0, hex: "", timedOut: false };
    }
    const timeout = Math.max(0, Number(timeoutMs || 0));
    const deadline = performance.now() + timeout;
    while (this.readBuffer.length < wanted) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        break;
      }
      const gotEvent = await this._waitForReadEvent(remaining);
      if (!gotEvent) {
        break;
      }
    }

    const available = Math.min(wanted, this.readBuffer.length);
    const out = this.readBuffer.slice(0, available);
    this.readBuffer = this.readBuffer.slice(available);
    return {
      read: out.length,
      hex: bytesToHex(out),
      timedOut: out.length < wanted,
    };
  }

  async readBytes(count, timeoutMs) {
    const result = await this.readHex(count, timeoutMs);
    const bytes = result.hex
      ? result.hex.split(/\s+/).filter(Boolean).map((part) => Number.parseInt(part, 16))
      : [];
    return bytes;
  }

  async prepareClone(wantsDtr, wantsRts, settleMs) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    this.readBuffer = new Uint8Array(0);
    try {
      await this.port.setSignals({
        dataTerminalReady: Boolean(wantsDtr),
        requestToSend: Boolean(wantsRts),
      });
    } catch {
      // Some adapters/browsers may not support control line changes.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(settleMs || 0))));
    return { prepared: true };
  }

  // Both transports report a device going away as a "disconnect" event on the
  // API object rather than on the port, so each event has to be matched back
  // against the adapter we hold open: a different device being unplugged must
  // not tear down a clone in progress.
  _watchForPortLoss() {
    this._unwatchPortLoss();
    const handler = (event) => {
      this._handleTransportDisconnect(event);
    };
    const targets = [];
    if (hasNativeSerial() && typeof navigator.serial?.addEventListener === "function") {
      targets.push(navigator.serial);
    }
    if (hasWebUsb() && typeof navigator.usb?.addEventListener === "function") {
      targets.push(navigator.usb);
    }
    for (const target of targets) {
      target.addEventListener("disconnect", handler);
    }
    this._portLostWatch = { handler, targets };
  }

  _unwatchPortLoss() {
    const watch = this._portLostWatch;
    if (!watch) {
      return;
    }
    this._portLostWatch = null;
    for (const target of watch.targets) {
      try {
        target.removeEventListener("disconnect", watch.handler);
      } catch {
        // Ignore listener-removal errors; the watch is gone either way.
      }
    }
  }

  async _handleTransportDisconnect(event) {
    if (!this.port || !this._isActivePortEvent(event)) {
      return;
    }
    const deviceName = this.lastDeviceName;
    this._debug(`Serial port disconnected: ${deviceName || "unknown device"}`);
    await this._teardown();
    try {
      this.onPortLost?.({ deviceName });
    } catch {
      // A broken notification sink must never take down the serial path.
    }
  }

  // Native Web Serial fires the event at the very SerialPort open() returned,
  // so object identity settles it. WebUSB reports the USBDevice instead, which
  // our adapter-specific ports hold onto — except the polyfilled CDC port,
  // which keeps it private and leaves the USB ids as the only handle we have.
  _isActivePortEvent(event) {
    const subject = event?.target || null;
    if (subject && subject === this.port) {
      return true;
    }
    if (event?.port && event.port === this.port) {
      return true;
    }
    const device = event?.device
      || (subject && typeof subject.vendorId === "number" ? subject : null);
    if (!device) {
      return false;
    }
    const active = this._activeUsbDevice();
    if (active) {
      return device === active;
    }
    const info = this.port?.getInfo?.() || {};
    return Number.isInteger(info.usbVendorId)
      && Number.isInteger(info.usbProductId)
      && info.usbVendorId === Number(device.vendorId)
      && info.usbProductId === Number(device.productId);
  }

  // The USBDevice behind a WebUSB-backed port, under whichever property the
  // port class keeps it in.
  _activeUsbDevice() {
    for (const key of ["device", "device_", "_device", "usbDevice"]) {
      const candidate = this.port?.[key];
      if (candidate && typeof candidate === "object" && "vendorId" in candidate) {
        return candidate;
      }
    }
    return null;
  }

  _debug(message) {
    try {
      this.onDebug?.(message);
    } catch {
      // A broken debug sink must never take down the serial path.
    }
  }

  async _startReadLoop() {
    let endReason = "port closed";
    while (this.port && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) {
          endReason = "stream ended (done)";
          break;
        }
        if (value && value.length > 0) {
          this.readBuffer = concatUint8(this.readBuffer, value);
          this._resolveReadWaiters(true);
        }
      } catch (error) {
        endReason = `read error: ${error?.message || error}`;
        break;
      }
    }
    // Surface loop death loudly; a disconnect is expected, an error is not.
    this._debug(`Serial read loop ended: ${endReason}`);
    this._resolveReadWaiters(false);
  }

  _waitForReadEvent(timeoutMs) {
    return new Promise((resolve) => {
      const waiter = {
        settle: (result) => {
          if (!this.readWaiters.delete(waiter)) {
            return;
          }
          clearTimeout(timerId);
          resolve(result);
        },
      };
      const timerId = setTimeout(() => waiter.settle(false), Math.max(0, timeoutMs));
      this.readWaiters.add(waiter);
    });
  }

  _resolveReadWaiters(result) {
    const waiters = Array.from(this.readWaiters);
    for (const waiter of waiters) {
      waiter.settle(result);
    }
  }

  _describePort(port) {
    const identity = this._getPortIdentity(port);
    const vid = identity.usbVendorId;
    const pid = identity.usbProductId;
    if (vid && pid) {
      return `USB VID:PID ${vid}:${pid}`;
    }
    if (vid) {
      return `USB VID ${vid}`;
    }
    return "Unknown (Web Serial API does not expose COM/tty path)";
  }

  _getPortIdentity(port) {
    const info = port?.getInfo?.() || {};
    const usbVendorId = Number.isInteger(info.usbVendorId)
      ? `0x${info.usbVendorId.toString(16).padStart(4, "0").toUpperCase()}`
      : null;
    const usbProductId = Number.isInteger(info.usbProductId)
      ? `0x${info.usbProductId.toString(16).padStart(4, "0").toUpperCase()}`
      : null;
    return { usbVendorId, usbProductId };
  }
}

// Build a serial RPC dispatcher used by runtime bridge messages.
export function createSerialRpcHandler({ serialBridge, logSerial, onProgress }) {
  async function handleOpen(payload = {}) {
    const res = await serialBridge.open(payload.baudRate);
    logSerial(res.message);
    return res;
  }

  async function handleClose() {
    const res = await serialBridge.close();
    logSerial(res.message);
    return res;
  }

  async function handleWriteHex(payload = {}) {
    const res = await serialBridge.writeHex(payload.hex);
    logSerial(`TX ${res.hex}`);
    return res;
  }

  async function handleReadHex(payload = {}) {
    const res = await serialBridge.readHex(payload.count, payload.timeoutMs);
    logSerial(`RX ${res.hex || "<none>"}${res.timedOut ? " (timeout)" : ""}`);
    return res;
  }

  async function handleWriteBytes(payload = {}) {
    return serialBridge.writeBytes(payload.bytes || []);
  }

  async function handleReadBytes(payload = {}) {
    return serialBridge.readBytes(payload.count, payload.timeoutMs);
  }

  async function handleLog(payload = {}) {
    logSerial(String(payload.message || ""));
    return { logged: true };
  }

  // CHIRP drivers report clone progress once per transferred block; forward
  // it to the UI (cur/max may be -1 when a driver reports no counts).
  async function handleProgress(payload = {}) {
    onProgress?.(Number(payload.cur), Number(payload.max), String(payload.msg || ""));
    return { reported: true };
  }

  async function handlePrepareClone(payload = {}) {
    const res = await serialBridge.prepareClone(
      payload.wantsDtr,
      payload.wantsRts,
      payload.settleMs,
    );
    logSerial(
      `Prepared clone session (DTR=${Boolean(payload.wantsDtr)} RTS=${Boolean(payload.wantsRts)})`,
    );
    return res;
  }

  async function handleResetBuffers() {
    serialBridge.readBuffer = new Uint8Array(0);
    return { reset: true };
  }

  async function handleGetPortInfo() {
    return serialBridge.getPortInfo();
  }

  const OP_HANDLERS = Object.freeze({
    open: handleOpen,
    close: handleClose,
    writeHex: handleWriteHex,
    readHex: handleReadHex,
    writeBytes: handleWriteBytes,
    readBytes: handleReadBytes,
    log: handleLog,
    progress: handleProgress,
    prepareClone: handlePrepareClone,
    resetBuffers: handleResetBuffers,
    getPortInfo: handleGetPortInfo,
  });

  return async function handleSerialRpc(msg) {
    const { op, payload } = msg;
    const handler = OP_HANDLERS[op];
    if (!handler) {
      throw new Error(`Unknown serial op: ${op}`);
    }
    return handler(payload || {});
  };
}

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
// What a port is opened with before any driver has asked for something else.
// A clone starts from these every time: framing a previous clone's driver set
// (tk280 wants even parity, tg_uv2p two stop bits) must not be inherited by the
// next radio, which would corrupt every byte it reads.
// The open() options that describe the character frame rather than its speed.
// Native Web Serial and the CDC polyfill honour all three; our four WebUSB chip
// drivers program 8N1 and read none of them, which is why they say so.
const FRAMING_OPTIONS = Object.freeze(["dataBits", "stopBits", "parity"]);

const DEFAULT_PORT_OPTIONS = Object.freeze({
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
});

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
    // The full option set this.port was opened with. A reconfigure has to hand
    // open() every option again, not just the changed one, so what the caller
    // did not touch has to be remembered rather than re-defaulted.
    this.portOptions = null;
    // The last DTR/RTS state we applied. Closing a port drops the control lines
    // back to the adapter's defaults, so a reconfigure has to put them back --
    // otherwise a rate change silently undoes the line state a driver set just
    // before it (thd72 does both, two lines apart).
    this.lastSignals = null;
    // The in-flight read loop, so a reopen can wait for the old one to die
    // before starting the next. Two loops sharing this.readBuffer would
    // interleave stale and fresh bytes.
    this._readLoop = null;
    this._createWebUsbSerial = createWebUsbSerialImpl || createWebUsbSerial;
  }

  // Choose the transport open() will use. Resets any cached provider while
  // disconnected so the next connect re-resolves against the new preference.
  // Derived rather than stored: portOptions is what the port was actually
  // opened with, and a second copy of the rate could drift from it.
  get baudRate() {
    return Number(this.portOptions?.baudRate) || 0;
  }

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
      // Reuse the port we already hold rather than reporting success blindly:
      // a second open() at a different rate used to be swallowed here, leaving
      // the clone to run at the first radio's rate (issue #76).
      const applied = await this.applyBaudRate(baudRate);
      return {
        connected: true,
        message: applied.changed
          ? `Reopened at ${applied.baudRate} baud`
          : "Already connected.",
        transport: this.transport,
      };
    }
    if (this.port) {
      await this._teardown();
    }

    const serial = await this._ensureSerial();
    try {
      this.port = await serial.requestPort({});
      const options = { ...DEFAULT_PORT_OPTIONS, baudRate };
      await this.port.open(options);
      this.portOptions = options;
      const identity = this._getPortIdentity(this.port);
      this.lastDeviceName = this._describePort(this.port);
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this._readLoop = this._startReadLoop();
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

  // Re-open the port we already hold at a different line rate. Each CHIRP
  // driver declares its own BAUD_RATE and the rate is fixed when the port
  // opens, so a session connected for a 9600-baud radio has to be re-rated
  // before cloning a 115200-baud one or the transfer times out on garbage
  // (issue #76). Reusing the same port handle keeps this off the browser's
  // port picker: no fresh user gesture, nothing to re-select.
  //
  // This is the clone-*start* entry point; reconfigure() is the mid-clone one.
  // They share the reopen but not the failure policy, and deliberately so:
  // nothing has been transferred yet here, so a port that cannot carry the
  // clone is better torn down than left open and offering Download.
  async applyBaudRate(baudRate) {
    const wanted = Number(baudRate);
    if (!Number.isFinite(wanted) || wanted <= 0) {
      return { changed: false, baudRate: this.baudRate, previousBaudRate: this.baudRate };
    }
    if (!this.port || !this.writer) {
      throw new Error("Port is not connected.");
    }
    // Back to the defaults, not to whatever the last clone's driver left
    // behind, and compared as a whole set so drifted framing is reset even when
    // the rate itself is unchanged.
    const target = { ...DEFAULT_PORT_OPTIONS, baudRate: wanted };
    const current = this.portOptions || {};
    if (Object.keys(target).every((key) => target[key] === current[key])) {
      return { changed: false, baudRate: this.baudRate, previousBaudRate: this.baudRate };
    }
    const previousBaudRate = this.baudRate;
    try {
      await this._reopenPort(target);
    } catch (error) {
      // Half-reopened is worse than disconnected: the UI would keep offering
      // Download against a port that can no longer carry it. Tear the session
      // down and report the loss on the same channel an unplug uses, so the
      // clone buttons go with it rather than pointing at a closed port.
      const deviceName = this.lastDeviceName;
      await this._teardown();
      try {
        this.onPortLost?.({ deviceName, reason: "baud-rate-change" });
      } catch {
        // A broken notification sink must never take down the serial path.
      }
      throw new Error(
        `Could not reopen the serial port at ${wanted} baud: ${error?.message || error}`,
      );
    }
    this._debug(`Serial port reopened at ${wanted} baud (was ${previousBaudRate || "unknown"}).`);
    return { changed: true, baudRate: wanted, previousBaudRate };
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
    await this._releaseStreams();
    try {
      await this.port?.close();
    } catch {
      // Ignore close errors.
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.portOptions = null;
    this.lastSignals = null;
    this._readLoop = null;
    this.readBuffer = new Uint8Array(0);
    this._resolveReadWaiters(false);
  }

  // Cancel the read loop and drop the reader/writer locks, leaving the port
  // handle alone. Teardown and a baud-rate reopen both need this half.
  async _releaseStreams() {
    try {
      await this.reader?.cancel();
    } catch {
      // Ignore cancellation errors.
    }
    try {
      // Cancelling settles the pending read, but the loop's own continuation is
      // still queued. A reopen that carries the read buffer across cannot have
      // the outgoing loop appending to it afterwards, so wait for it to finish.
      await this._readLoop;
    } catch {
      // The loop reports its own end; a rejection must not mask the caller.
    }
    this._readLoop = null;
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
    this.reader = null;
    this.writer = null;
  }

  getPortInfo() {
    const identity = this.port ? this._getPortIdentity(this.port) : {};
    return {
      connected: Boolean(this.port),
      baudRate: this.baudRate,
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

  async prepareClone(wantsDtr, wantsRts, settleMs, baudRate) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    // The driver's declared rate wins over whatever the port was connected
    // with: the radio selected at Connect time need not be the one being
    // cloned now (issue #76). Done first so the control lines and settle
    // delay below apply to the port the transfer will actually use.
    const rate = await this.applyBaudRate(baudRate);
    this.readBuffer = new Uint8Array(0);
    this.lastSignals = {
      dataTerminalReady: Boolean(wantsDtr),
      requestToSend: Boolean(wantsRts),
    };
    try {
      await this.port.setSignals(this.lastSignals);
    } catch {
      // Some adapters/browsers may not support control line changes.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(settleMs || 0))));
    return { prepared: true, baudRate: this.baudRate, baudRateChanged: rate.changed };
  }

  // Assert DTR/RTS on an already-open port. Separate from prepareClone()
  // because drivers also toggle the control lines *during* a clone -- thd72
  // raises RTS after the radio enters PROGRAM mode -- and those toggles must
  // reach the port rather than only being remembered in Python. A null line is
  // left as it is, so a driver changing one line does not clear the other.
  async setSignals(dataTerminalReady, requestToSend) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const signals = {};
    if (dataTerminalReady !== null && dataTerminalReady !== undefined) {
      signals.dataTerminalReady = Boolean(dataTerminalReady);
    }
    if (requestToSend !== null && requestToSend !== undefined) {
      signals.requestToSend = Boolean(requestToSend);
    }
    if (!Object.keys(signals).length) {
      return { applied: false, ...signals };
    }
    // Recorded as intent, before the attempt and whether or not it succeeds, so
    // it matches prepareClone() and so a later reopen restores what the driver
    // asked for. A port that could not honour it will not honour the restore
    // either, which is the same harmless no-op.
    this.lastSignals = { ...(this.lastSignals || {}), ...signals };
    await this.port.setSignals(signals);
    return { applied: true, ...signals };
  }

  // The mid-clone counterpart to applyBaudRate(): drivers change the port's
  // settings part-way through a transfer (thd72 jumps to 57600 after its
  // PROGRAM handshake), and by then the radio has already switched. Options the
  // caller leaves out keep their current value.
  async reconfigure(options = {}) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const current = this.portOptions || {};
    const next = { ...current };
    for (const [key, value] of Object.entries(options)) {
      if (value !== null && value !== undefined) {
        next[key] = value;
      }
    }
    const changed = Object.keys(next).filter((key) => next[key] !== current[key]);
    if (!changed.length) {
      // Drivers assign the rate they are already running at (often once per
      // block); a reopen per assignment would restart the chip mid-clone.
      return { reconfigured: false, options: next, changed };
    }

    // A transport that cannot carry the requested frame must say so rather than
    // reopen and report success: wrong parity or stop bits corrupts every byte,
    // and a clone that fails on garbage names nothing. Absence of the flag means
    // the port honours open()'s framing (native Web Serial, the CDC polyfill).
    const framing = changed.filter((key) => FRAMING_OPTIONS.includes(key));
    if (framing.length && this.port.supportsFraming === false) {
      throw new Error(
        `This serial adapter cannot change ${framing.join(", ")}: it runs at 8N1 only. `
        + "Connect through a native Web Serial port to clone this radio.",
      );
    }

    // Bytes buffered before the switch arrived at the old rate and are real
    // driver data -- pyserial reconfigures without flushing the input queue and
    // drivers are written against that -- so they survive the reopen.
    try {
      await this._reopenPort(next, { preserveBuffer: true });
    } catch (error) {
      // Unlike a clone-start re-rate, the session is worth saving here: the
      // port itself is fine, only the change failed, and a live port lets the
      // user retry without re-picking the device. Put it back as it was.
      try {
        await this._reopenPort(current, { preserveBuffer: true });
        await this._restoreSignals();
      } catch {
        await this._teardown();
      }
      throw new Error(
        `Could not reconfigure the port (${changed.join(", ")}): ${error?.message || error}`,
      );
    }
    await this._restoreSignals();
    return { reconfigured: true, options: next, changed };
  }

  // Close and reopen the port we already hold with a new option set, keeping
  // everything a reopen must survive: the port object, the pending read waiters
  // and the disconnect watch. Throws with the port left closed -- the caller
  // decides what that means, because the right answer differs between a
  // clone-start re-rate and a mid-clone change.
  async _reopenPort(nextOptions, { preserveBuffer = false } = {}) {
    const port = this.port;
    this._unwatchPortLoss();
    await this._releaseStreams();
    // Snapshotted only now, and installed below before the next loop starts.
    // Both halves matter: _releaseStreams() has cancelled the reader and waited
    // for the loop, so nothing can append after this line -- read any earlier
    // and a chunk landing during cancellation is dropped -- and installing it
    // before the new loop means a chunk the reopened stream delivers
    // immediately appends to these bytes instead of being overwritten by them.
    const pending = preserveBuffer ? this.readBuffer : new Uint8Array(0);
    try {
      await port.close();
    } catch {
      // Already closed (a failed reopen being put back), or refusing to; either
      // way it is open() below that decides whether this worked.
    }
    await port.open(nextOptions);
    this.portOptions = nextOptions;
    this.readBuffer = pending;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this._readLoop = this._startReadLoop();
    this._watchForPortLoss();
    if (pending.length) {
      this._debug(`Kept ${pending.length} buffered byte(s) across port reconfigure`);
    }
  }

  // Put back the control lines the close dropped to the adapter's defaults.
  // Only the mid-clone path needs this: at clone start prepareClone() asserts
  // them a moment later anyway.
  async _restoreSignals() {
    if (this.lastSignals) {
      try {
        await this.port.setSignals(this.lastSignals);
      } catch {
        // Same rule as setSignals(): control lines are advisory.
      }
    }
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
    // Pinned rather than re-read each pass: a baud-rate reopen installs a new
    // reader while this loop may still be unwinding, and an unpinned loop would
    // then read from the successor's stream.
    const reader = this.reader;
    let endReason = "port closed";
    while (this.port && this.reader === reader) {
      try {
        const { value, done } = await reader.read();
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

// Render a setSignals payload for the debug panel, naming only the lines the
// caller actually asked to change.
function describeSignals(payload = {}) {
  const parts = [];
  if (payload.dataTerminalReady !== null && payload.dataTerminalReady !== undefined) {
    parts.push(`DTR=${Boolean(payload.dataTerminalReady)}`);
  }
  if (payload.requestToSend !== null && payload.requestToSend !== undefined) {
    parts.push(`RTS=${Boolean(payload.requestToSend)}`);
  }
  return parts.length ? parts.join(" ") : "no lines";
}

// Name the port options a reconfigure actually changed, for the debug panel.
function describeOptions(options = {}, changed = []) {
  const keys = changed.length ? changed : Object.keys(options);
  return keys.map((key) => `${key}=${options[key]}`).join(" ") || "no change";
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
      payload.baudRate,
    );
    // The baud rate belongs in this line because it is the one clone parameter
    // that can differ from what the user chose at Connect time; a mismatch
    // shows up as timeouts, and the log is where that gets diagnosed.
    logSerial(
      `Prepared clone session (DTR=${Boolean(payload.wantsDtr)} RTS=${Boolean(payload.wantsRts)}`
      + ` baud=${res.baudRate || "unchanged"}${res.baudRateChanged ? ", reopened" : ""})`,
    );
    return res;
  }

  // Control-line changes are advisory: adapters and browsers that cannot set
  // DTR/RTS must not abort a clone that would otherwise work, so a failure is
  // reported to the debug panel instead of propagating into the driver.
  async function handleSetSignals(payload = {}) {
    try {
      const res = await serialBridge.setSignals(
        payload.dataTerminalReady,
        payload.requestToSend,
      );
      if (res.applied) {
        logSerial(`Set control lines (${describeSignals(payload)})`);
      }
      return res;
    } catch (err) {
      logSerial(
        `Control lines unchanged (${describeSignals(payload)}): ${err?.message || err}`,
      );
      return { applied: false, error: String(err?.message || err) };
    }
  }

  // A rate change is not advisory the way DTR/RTS is. By the time a driver
  // assigns it the radio has already switched, so a port left at the old rate
  // cannot complete the clone -- a silent timeout ten seconds later is a much
  // worse diagnostic than the failure itself. This one propagates.
  async function handleReconfigure(payload = {}) {
    const res = await serialBridge.reconfigure(payload.options || {});
    if (res.reconfigured) {
      logSerial(`Reopened port (${describeOptions(res.options, res.changed)})`);
    }
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
    setSignals: handleSetSignals,
    reconfigure: handleReconfigure,
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

// The serial bridge: the one object behind the serial_* functions CHIRP's
// Python calls (installed by web/js/serial-globals.ts), shared by the browser
// (web/js/serial.ts) and the node-serialport harness the CLI and the Pyodide
// suites use (tests/support/radio-harness.mjs).
//
// It owns everything that is about a clone rather than about a transport: the
// read buffer and its waiters, open and close, byte and hex I/O, in_waiting,
// control lines, the clone-start re-rate and the mid-clone reconfigure. The
// port it drives comes from a transport factory and is checked against the
// contract in web/js/serial-transport.ts; what a port cannot do is read from
// its declared capabilities, so nothing here knows which transport it holds.
//
// No DOM or navigator access, at module scope or anywhere else: the browser's
// chooser lives in the factory web/js/serial.ts passes in.
import {
  DEFAULT_PORT_OPTIONS,
  FRAMING_OPTIONS,
  assertSerialTransport,
} from "./serial-transport.ts";
import type {
  SerialDisconnectPayload,
  SerialOpenOptions,
  SerialSignals,
  SerialTransport,
} from "./serial-transport.ts";

/** Why the bridge gave up an open port, as onPortLost hears it. */
export interface PortLostInfo {
  /** How the port was named while open. */
  deviceName?: string;
  /** "disconnected", "baud-rate-change", ... */
  reason?: string;
}

/**
 * What open() reports: the message the UI shows, and the identity the issue
 * report and analytics record.
 */
export interface SerialConnectResult {
  connected: boolean;
  message: string;
  /** The port's transport name. */
  transport: string;
  deviceName?: string;
  /** "0x1A86"-style, or null. */
  usbVendorId?: string | null;
  usbProductId?: string | null;
}

/** What a clone-start re-rate did. */
export interface BaudRateChange {
  /** False when the port already ran at those settings. */
  changed: boolean;
  /** The rate now in effect. */
  baudRate: number;
  previousBaudRate: number;
}

// Parse hex byte text into a Uint8Array for serial writes.
/**
 * @param input Hex byte text; any non-hex character separates bytes.
 */
export function parseHex(input: unknown): Uint8Array {
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
export function bytesToHex(bytes: ArrayLike<number> | Iterable<number> | null | undefined): string {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

// The option names an options object carries, typed as option names:
// Object.keys() can only promise strings.
function optionKeys(options: Partial<SerialOpenOptions>): Array<keyof SerialOpenOptions> {
  return Object.keys(options) as Array<keyof SerialOpenOptions>;
}

// Concatenate two Uint8Array buffers into one contiguous buffer.
function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// How the connect message names the route a port took, where that is news
// to the user; native Web Serial and the CLI's tty need no qualifier.
const TRANSPORT_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  webusb: " (via WebUSB)",
  webbluetooth: " (via WebBluetooth)",
});

export class SerialBridge {
  _transportFactory: (() => Promise<SerialTransport>) | null;
  port: SerialTransport | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  readBuffer: Uint8Array;
  readWaiters: Set<{settle: (gotData: boolean) => void}>;
  lastDeviceName: string;
  transport: string;
  onDebug: ((message: string) => void) | null;
  onPortLost: ((info: PortLostInfo) => void) | null;
  _stopLossWatch: (() => void) | null;
  portOptions: SerialOpenOptions | null;
  lastSignals: SerialSignals | null;
  _readLoop: Promise<void> | null;

  // requestTransport is the transport factory: an async function returning a
  // port that satisfies web/js/serial-transport.ts, not yet opened. The
  // browser's shows a chooser; the harness's constructs a node-serialport
  // adapter. A subclass may override requestTransport() instead.
  constructor({ requestTransport }: { requestTransport?: () => Promise<SerialTransport> } = {}) {
    this._transportFactory = requestTransport || null;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readBuffer = new Uint8Array(0);
    this.readWaiters = new Set();
    this.lastDeviceName = "";
    // The transport name of the port last opened ("webserial", "webusb",
    // "webbluetooth", "node"); reported to the UI and analytics.
    this.transport = "";
    // Optional diagnostic sink (wired to the debug log by the app). The read
    // loop MUST report why it ended: a silently-dead read loop is
    // indistinguishable from "no data" and cost us a debugging session.
    this.onDebug = null;
    // Called when the port's transport reports that the adapter behind the
    // open port has gone away -- unplugged, or powered down with the radio
    // where the adapter lives in the cable -- and when a clone-start re-rate
    // leaves the port unusable. The port is already torn down by then.
    this.onPortLost = null;
    // The unsubscribe the port's onDisconnect() handed back.
    this._stopLossWatch = null;
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
  }

  // Derived rather than stored: portOptions is what the port was actually
  // opened with, and a second copy of the rate could drift from it.
  get baudRate() {
    return Number(this.portOptions?.baudRate) || 0;
  }

  // Produce the port open() will use. The default asks the factory given to
  // the constructor; the browser bridge overrides this with its chooser.
  async requestTransport(): Promise<SerialTransport> {
    if (!this._transportFactory) {
      throw new Error("No serial transport factory is configured.");
    }
    return this._transportFactory();
  }

  // Connect: reuse the held port (re-rated if need be) or take a new one from
  // the transport factory, open it with the default framing and start reading.
  /**
   * @param baudRate Falls back to 9600 when not a positive number.
   */
  async open(baudRate: number): Promise<SerialConnectResult> {
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

    const port = await this.requestTransport();
    try {
      // Checked before anything is held: a port that half-implements the
      // contract would fail later, mid-clone, naming nothing.
      assertSerialTransport(port);
      this.port = port;
      this.transport = port.transport;
      const rate = Number(baudRate) || 9600;
      const options = { ...DEFAULT_PORT_OPTIONS, baudRate: rate };
      await port.open(options);
      this.portOptions = options;
      const identity = this._getPortIdentity(port);
      this.lastDeviceName = this._describePort(port);
      this._takeStreams(port);
      this._watchForPortLoss(port);
      return {
        connected: true,
        message: `Connected at ${rate} baud${TRANSPORT_SUFFIX[this.transport] || ""}`,
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
  async applyBaudRate(baudRate: number): Promise<BaudRateChange> {
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
    const target: SerialOpenOptions = { ...DEFAULT_PORT_OPTIONS, baudRate: wanted };
    const current: Partial<SerialOpenOptions> = this.portOptions || {};
    if (optionKeys(target).every((key) => target[key] === current[key])) {
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
      this._reportPortLost({ deviceName, reason: "baud-rate-change" });
      throw new Error(
        `Could not reopen the serial port at ${wanted} baud: ${error?.message || error}`,
      );
    }
    this._debug(`Serial port reopened at ${wanted} baud (was ${previousBaudRate || "unknown"}).`);
    return { changed: true, baudRate: wanted, previousBaudRate };
  }

  // Disconnect, if anything is connected.
  async close(): Promise<{ connected: false; message: string }> {
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
  // handle alone. Teardown and a reopen both need this half.
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

  // The held port's state and identity, for the UI and issue reports.
  getPortInfo(): {
    connected: boolean;
    baudRate: number;
    deviceName: string;
    usbVendorId?: string | null;
    usbProductId?: string | null;
  } {
    const identity: { usbVendorId?: string | null; usbProductId?: string | null } = this.port ? this._getPortIdentity(this.port) : {};
    return {
      connected: Boolean(this.port),
      baudRate: this.baudRate,
      deviceName: this.port ? this._describePort(this.port) : this.lastDeviceName,
      usbVendorId: identity.usbVendorId,
      usbProductId: identity.usbProductId,
    };
  }

  // Write hex byte text; returns what was written, normalised.
  async writeHex(hex: string): Promise<{ written: number; hex: string }> {
    const bytes = parseHex(hex);
    await this.writeBytes(bytes);
    return { written: bytes.length, hex: bytesToHex(bytes) };
  }

  // Write raw bytes to the open port.
  async writeBytes(bytesLike: ArrayLike<number> | null | undefined): Promise<{ written: number }> {
    if (!this.writer) {
      throw new Error("Port is not connected.");
    }
    const bytes = Uint8Array.from(bytesLike || []);
    await this.writer.write(bytes);
    return { written: bytes.length };
  }

  // Take up to count bytes off the read buffer, waiting up to timeoutMs for
  // them to arrive. Returns the bytes as a plain array: what pyserial's read()
  // hands a driver is a short read, never an error, when the line goes quiet.
  async readBytes(count: number, timeoutMs: number): Promise<number[]> {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const wanted = Math.max(0, Number(count || 0));
    if (wanted === 0) {
      return [];
    }
    const deadline = performance.now() + Math.max(0, Number(timeoutMs || 0));
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
    return Array.from(out);
  }

  // readBytes() as hex text, saying whether the read came up short.
  async readHex(count: number, timeoutMs: number): Promise<{ read: number; hex: string; timedOut: boolean }> {
    const bytes = await this.readBytes(count, timeoutMs);
    return {
      read: bytes.length,
      hex: bytesToHex(bytes),
      timedOut: bytes.length < Math.max(0, Number(count || 0)),
    };
  }

  // Report how many received bytes are sitting in the bridge's buffer, for
  // drivers that gate their reads on pyserial's in_waiting / inWaiting().
  //
  // pyserial answers this from a local kernel buffer, so drivers treat it as
  // free and poll it in tight loops - anytone778uv's send_serial_command()
  // spins on it for up to 0.5 s per clone block. Here every peek is a full
  // JSPI round trip out of Pyodide, so an honest non-blocking snapshot would
  // turn one block read into thousands of them. When nothing is buffered we
  // park on the same read event readBytes() uses instead: it settles the
  // instant bytes land, so a busy line costs nothing, and an idle one costs
  // one round trip per waitMs rather than one per loop iteration.
  async inWaiting(waitMs: number): Promise<{ available: number }> {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const wait = Math.max(0, Number(waitMs || 0));
    if (this.readBuffer.length === 0 && wait > 0) {
      await this._waitForReadEvent(wait);
    }
    return { available: this.readBuffer.length };
  }

  // Drop every received byte not yet read: pyserial's reset_input_buffer(),
  // and the buffer-clear step of a clone's preparation. A transport that holds
  // bytes of its own below the stream (the OS queue behind node-serialport)
  // declares discardInput() and is told to drop those too.
  async resetBuffers(): Promise<{ reset: true }> {
    this.readBuffer = new Uint8Array(0);
    if (this.port && typeof this.port.discardInput === "function") {
      await this.port.discardInput();
    }
    return { reset: true };
  }

  // Get the open port ready for a clone: the driver's line rate, an empty
  // input buffer, the driver's DTR/RTS, then the settle delay the radio needs
  // before the first byte.
  /**
   * @param baudRate The driver's declared BAUD_RATE.
   */
  async prepareClone(
    wantsDtr: boolean,
    wantsRts: boolean,
    settleMs: number,
    baudRate: number,
  ): Promise<{ prepared: true; baudRate: number; baudRateChanged: boolean; settleMs: number }> {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    // The driver's declared rate wins over whatever the port was connected
    // with: the radio selected at Connect time need not be the one being
    // cloned now (issue #76). Done first so the control lines and settle
    // delay below apply to the port the transfer will actually use.
    const rate = await this.applyBaudRate(baudRate);
    await this.resetBuffers();
    this.lastSignals = {
      dataTerminalReady: Boolean(wantsDtr),
      requestToSend: Boolean(wantsRts),
    };
    // Control lines are advisory here: a transport that cannot set them says
    // so in its capabilities, and one that fails anyway must not stop a clone
    // that would otherwise work.
    if (this.port.capabilities.signals) {
      try {
        await this.port.setSignals(this.lastSignals);
      } catch {
        // Some adapters/browsers may not support control line changes.
      }
    }
    const settle = Math.max(0, Number(settleMs || 0));
    await new Promise((resolve) => setTimeout(resolve, settle));
    return {
      prepared: true,
      baudRate: this.baudRate,
      baudRateChanged: rate.changed,
      settleMs: settle,
    };
  }

  // Assert DTR/RTS on an already-open port. Separate from prepareClone()
  // because drivers also toggle the control lines *during* a clone -- thd72
  // raises RTS after the radio enters PROGRAM mode -- and those toggles must
  // reach the port rather than only being remembered in Python. A null line is
  // left as it is, so a driver changing one line does not clear the other.
  async setSignals(
    dataTerminalReady: boolean | null | undefined,
    requestToSend: boolean | null | undefined,
  ): Promise<{ applied: boolean } & SerialSignals> {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const signals: SerialSignals = {};
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
    if (!this.port.capabilities.signals) {
      throw new Error(`This serial adapter cannot set DTR/RTS (${this.lastDeviceName || this.transport}).`);
    }
    await this.port.setSignals(signals);
    return { applied: true, ...signals };
  }

  // The mid-clone counterpart to applyBaudRate(): drivers change the port's
  // settings part-way through a transfer (thd72 jumps to 57600 after its
  // PROGRAM handshake), and by then the radio has already switched. Options the
  // caller leaves out keep their current value.
  /**
   * @param options A null or absent option is left as it is.
   */
  async reconfigure(
    options: Partial<SerialOpenOptions> = {},
  ): Promise<{ reconfigured: boolean; options: SerialOpenOptions; changed: string[] }> {
    // open() records the options with the port, so an open port has both.
    if (!this.port || !this.portOptions) {
      throw new Error("Port is not connected.");
    }
    const current: SerialOpenOptions = this.portOptions;
    const next: SerialOpenOptions = { ...current };
    for (const key of optionKeys(options)) {
      const value = options[key];
      if (value !== null && value !== undefined) {
        // One key at a time, so the value is the type that key holds.
        (next as Record<keyof SerialOpenOptions, unknown>)[key] = value;
      }
    }
    const changed = optionKeys(next).filter((key) => next[key] !== current[key]);
    if (!changed.length) {
      // Drivers assign the rate they are already running at (often once per
      // block); a reopen per assignment would restart the chip mid-clone.
      return { reconfigured: false, options: next, changed };
    }

    // A transport that cannot carry the requested frame must say so rather than
    // reopen and report success: wrong parity or stop bits corrupts every byte,
    // and a clone that fails on garbage names nothing. Every transport declares
    // which it is in capabilities.framing.
    const framing = changed.filter((key) => FRAMING_OPTIONS.includes(key));
    if (framing.length && !this.port.capabilities.framing) {
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

  // Apply a new option set to the port we already hold, the way its
  // capabilities.reconfigure says it can: in place ("update": streams, reader
  // and pending bytes untouched) or by closing and reopening the same port
  // object ("reopen"), keeping everything a reopen must survive -- the port,
  // the pending read waiters and the loss subscription. Throws with the port
  // left closed on the reopen route; the caller decides what that means,
  // because the right answer differs between a clone-start re-rate and a
  // mid-clone change.
  async _reopenPort(
    nextOptions: SerialOpenOptions,
    { preserveBuffer = false }: { preserveBuffer?: boolean } = {},
  ) {
    const port = this.port;
    if (!port) {
      throw new Error("No serial port is open to reconfigure");
    }
    if (port.capabilities.reconfigure === "update") {
      // assertSerialTransport() refused a port without it at open; this names
      // the same broken contract should one slip through.
      if (!port.reconfigure) {
        throw new Error(`The ${port.transport} port declares in-place reconfigure but has no reconfigure()`);
      }
      await port.reconfigure(nextOptions);
      this.portOptions = nextOptions;
      if (!preserveBuffer) {
        this.readBuffer = new Uint8Array(0);
      }
      return;
    }
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
    this._takeStreams(port);
    if (pending.length) {
      this._debug(`Kept ${pending.length} buffered byte(s) across port reconfigure`);
    }
  }

  // Put back the control lines the close dropped to the adapter's defaults.
  // Only the mid-clone path needs this: at clone start prepareClone() asserts
  // them a moment later anyway.
  async _restoreSignals() {
    const port = this.port;
    // A port lost mid-change was torn down, which forgot the signals too:
    // there is nothing left to restore them on.
    if (!port || !this.lastSignals) {
      return;
    }
    if (port.capabilities.signals) {
      try {
        await port.setSignals(this.lastSignals);
      } catch {
        // Same rule as setSignals(): control lines are advisory.
      }
    }
  }

  // Subscribe to the port's loss report. Every transport delivers it the same
  // way -- once, as {transport, port} -- so there is no per-transport event to
  // decode here; the identity check only guards against a report from a port
  // this bridge has already let go of.
  /** @param port The port connect() has just installed. */
  _watchForPortLoss(port: SerialTransport) {
    this._unwatchPortLoss();
    this._stopLossWatch = port.onDisconnect((payload) => {
      if (payload?.port === port) {
        this._handleTransportDisconnect(payload);
      }
    });
  }

  _unwatchPortLoss() {
    const stop = this._stopLossWatch;
    this._stopLossWatch = null;
    try {
      stop?.();
    } catch {
      // The subscription is gone either way.
    }
  }

  // Close the lost port and tell the UI, which stops offering clone actions.
  async _handleTransportDisconnect(payload: SerialDisconnectPayload) {
    if (!this.port || payload?.port !== this.port) {
      return;
    }
    const deviceName = this.lastDeviceName;
    this._debug(`Serial port disconnected: ${deviceName || "unknown device"}`);
    await this._teardown();
    this._reportPortLost({ deviceName });
  }

  // Deliver a loss to onPortLost; a broken sink must never take down the
  // serial path.
  _reportPortLost(info: PortLostInfo) {
    try {
      this.onPortLost?.(info);
    } catch {
      // Ignore sink errors.
    }
  }

  _debug(message: string) {
    try {
      this.onDebug?.(message);
    } catch {
      // A broken debug sink must never take down the serial path.
    }
  }

  // Take the reader and writer of a port whose open() has just resolved and
  // start reading. Web Serial promises both streams once the port is open; a
  // transport that breaks that is named here instead of failing as a TypeError
  // on null halfway through connecting.
  _takeStreams(port: SerialTransport) {
    const { readable, writable } = port;
    if (!readable || !writable) {
      throw new Error(`The ${port.transport} port opened without its readable and writable streams`);
    }
    const reader = readable.getReader();
    this.reader = reader;
    this.writer = writable.getWriter();
    this._readLoop = this._startReadLoop(reader);
  }

  // The reader is pinned by the caller rather than re-read each pass: a reopen
  // installs a new reader while this loop may still be unwinding, and an
  // unpinned loop would then read from the successor's stream.
  async _startReadLoop(reader: ReadableStreamDefaultReader<Uint8Array>) {
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

  _waitForReadEvent(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter = {
        settle: (result: boolean) => {
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

  _resolveReadWaiters(result: boolean) {
    const waiters = Array.from(this.readWaiters);
    for (const waiter of waiters) {
      waiter.settle(result);
    }
  }

  // Name the port for the debug panel: its own displayName where it has one
  // (a Bluetooth profile, a tty path), otherwise its USB ids.
  _describePort(port: SerialTransport & { displayName?: string }): string {
    if (port.displayName) {
      return port.displayName;
    }
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

  _getPortIdentity(port: SerialTransport | null): { usbVendorId: string | null; usbProductId: string | null } {
    const info: { usbVendorId?: number; usbProductId?: number } = port?.getInfo?.() || {};
    const usbVendorId = typeof info.usbVendorId === "number" && Number.isInteger(info.usbVendorId)
      ? `0x${info.usbVendorId.toString(16).padStart(4, "0").toUpperCase()}`
      : null;
    const usbProductId = typeof info.usbProductId === "number" && Number.isInteger(info.usbProductId)
      ? `0x${info.usbProductId.toString(16).padStart(4, "0").toUpperCase()}`
      : null;
    return { usbVendorId, usbProductId };
  }
}

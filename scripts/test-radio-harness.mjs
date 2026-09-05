import fs from "node:fs/promises";
import path from "node:path";
import { loadPyodide } from "pyodide";
import { SerialPort } from "serialport";
import {
  createFilesystemPythonSource,
  installFetchChirpSourceGlobal,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

function decodeBase64ToBytes(base64Text) {
  return Uint8Array.from(Buffer.from(String(base64Text || ""), "base64"));
}

function encodeBytesToBase64(bytesLike) {
  return Buffer.from(Array.from(bytesLike || []).map((value) => Number(value) & 0xff)).toString(
    "base64",
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function hexToBytes(hex) {
  const text = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  if (!text.length) {
    return new Uint8Array(0);
  }
  if (text.length % 2 !== 0) {
    throw new Error(`Invalid hex byte string length: ${text.length}`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < text.length; i += 2) {
    out[i / 2] = Number.parseInt(text.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((v) => Number(v & 0xff).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function pathExists(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChirpPackageDir(inputDir) {
  const candidate = path.resolve(inputDir);
  const directInit = path.join(candidate, "__init__.py");
  const directDrivers = path.join(candidate, "drivers");
  if ((await pathExists(directInit)) && (await pathExists(directDrivers))) {
    return candidate;
  }

  const nested = path.join(candidate, "chirp");
  const nestedInit = path.join(nested, "__init__.py");
  const nestedDrivers = path.join(nested, "drivers");
  if ((await pathExists(nestedInit)) && (await pathExists(nestedDrivers))) {
    return nested;
  }

  throw new Error(
    `Invalid CHIRP source dir: ${candidate}. Expected dir containing __init__.py and drivers/`,
  );
}

async function createLocalPythonSource(repoRoot, chirpDirArg) {
  const chirpInputDir =
    chirpDirArg || process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp");
  const chirpPackageDir = await resolveChirpPackageDir(chirpInputDir);
  const runtimeBridgePath = path.join(repoRoot, "web/python/runtime_bridge.py");
  return createFilesystemPythonSource({
    chirpPackageDir,
    runtimeBridgePath,
    readText: (fullPath) => fs.readFile(fullPath, "utf8"),
    readDirNames: async (fullPath) => {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    joinPath: (...parts) => path.join(...parts),
  });
}

async function openSerialPort(port) {
  await new Promise((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function closeSerialPort(port) {
  await new Promise((resolve, reject) => {
    port.close((error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function writeSerialPort(port, data) {
  await new Promise((resolve, reject) => {
    port.write(data, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function drainSerialPort(port) {
  await new Promise((resolve, reject) => {
    port.drain((error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function setSerialPortLines(port, lines) {
  await new Promise((resolve, reject) => {
    port.set(lines, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function flushSerialPort(port) {
  await new Promise((resolve, reject) => {
    port.flush((error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function updateSerialPortBaudRate(port, baudRate) {
  await new Promise((resolve, reject) => {
    port.update({ baudRate }, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

// Mirrors DEFAULT_PORT_OPTIONS in web/js/serial.js, in node-serialport's
// spelling: a clone starts from these rather than inheriting the framing the
// previous clone's driver set.
const NODE_DEFAULT_PORT_OPTIONS = Object.freeze({
  dataBits: 8,
  stopBits: 1,
  parity: "none",
});

const NODE_FRAMING_OPTIONS = Object.freeze(["dataBits", "stopBits", "parity"]);

export class NodeSerialBridge {
  constructor(portPath) {
    this.portPath = String(portPath || "");
    this.port = null;
    // What the port is currently configured with. Derived from -- never kept
    // alongside -- so a mid-clone reconfigure and a clone-start re-rate cannot
    // disagree about the current rate and skip a reopen that was needed.
    this.portOptions = null;
    this.readBuffer = Buffer.alloc(0);
    this.onData = (chunk) => {
      if (!chunk || !chunk.length) {
        return;
      }
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.readBuffer = Buffer.concat([this.readBuffer, incoming]);
    };
  }

  ensureOpen() {
    if (!this.port || !this.port.isOpen) {
      throw new Error("Serial port is not connected");
    }
  }

  async open(baudRate) {
    if (this.port?.isOpen) {
      const applied = await this.applyBaudRate(baudRate);
      return {
        connected: true,
        message: applied.changed
          ? `Reopened ${this.portPath} @ ${applied.baudRate} bps`
          : `Already connected to ${this.portPath}`,
        deviceName: this.portPath,
      };
    }
    const baud = Math.max(1, Number(baudRate || 9600));
    this.port = new SerialPort({
      path: this.portPath,
      baudRate: baud,
      autoOpen: false,
    });
    this.portOptions = { ...NODE_DEFAULT_PORT_OPTIONS, baudRate: baud };
    this.readBuffer = Buffer.alloc(0);
    this.port.on("data", this.onData);
    await openSerialPort(this.port);
    return {
      connected: true,
      message: `Connected to ${this.portPath} @ ${baud} bps`,
      deviceName: this.portPath,
    };
  }

  get baudRate() {
    return Number(this.portOptions?.baudRate) || 0;
  }

  // Match the browser bridge: the driver about to clone decides the line rate,
  // not whatever the port happened to be opened with (issue #76). Framing goes
  // back to the defaults for the same reason it does there -- it is sticky once
  // a driver sets it, and the next radio must not inherit it.
  async applyBaudRate(baudRate) {
    const wanted = Number(baudRate);
    if (!Number.isFinite(wanted) || wanted <= 0) {
      return { changed: false, baudRate: this.baudRate };
    }
    this.ensureOpen();
    const target = { ...NODE_DEFAULT_PORT_OPTIONS, baudRate: wanted };
    const current = this.portOptions || {};
    if (Object.keys(target).every((key) => target[key] === current[key])) {
      return { changed: false, baudRate: this.baudRate };
    }
    await this._applySettings(target);
    this.readBuffer = Buffer.alloc(0);
    return { changed: true, baudRate: wanted };
  }

  async close() {
    if (!this.port) {
      return { connected: false, message: "Serial already disconnected." };
    }
    const current = this.port;
    this.port = null;
    this.portOptions = null;
    current.off("data", this.onData);
    if (current.isOpen) {
      await closeSerialPort(current);
    }
    this.readBuffer = Buffer.alloc(0);
    return { connected: false, message: `Disconnected from ${this.portPath}` };
  }

  async writeBytes(bytesLike) {
    this.ensureOpen();
    const bytes = Buffer.from(Array.from(bytesLike || []).map((v) => Number(v) & 0xff));
    await writeSerialPort(this.port, bytes);
    await drainSerialPort(this.port);
    return { written: bytes.length };
  }

  async writeHex(hex) {
    const bytes = hexToBytes(hex);
    await this.writeBytes(bytes);
    return { written: bytes.length, hex: bytesToHex(bytes) };
  }

  async readBytes(count, timeoutMs) {
    this.ensureOpen();
    const requested = Math.max(0, Number(count || 1));
    const timeout = Math.max(1, Number(timeoutMs || 1200));
    const deadline = Date.now() + timeout;
    while (this.readBuffer.length < requested && Date.now() < deadline) {
      await sleep(Math.min(10, deadline - Date.now()));
    }
    const available = Math.min(requested, this.readBuffer.length);
    const out = this.readBuffer.subarray(0, available);
    this.readBuffer = this.readBuffer.subarray(available);
    return Array.from(out);
  }

  // Same contract as the browser bridge: report the buffered count, and when
  // nothing is buffered wait up to waitMs for the first byte rather than
  // answering 0 straight away. Drivers poll this in tight loops, so a real
  // radio read over the agent CLI would otherwise spin through the Pyodide
  // round trip for the driver's whole deadline.
  async inWaiting(waitMs) {
    this.ensureOpen();
    const deadline = Date.now() + Math.max(0, Number(waitMs || 0));
    while (this.readBuffer.length === 0 && Date.now() < deadline) {
      await sleep(Math.min(5, deadline - Date.now()));
    }
    return { available: this.readBuffer.length };
  }

  async readHex(count, timeoutMs) {
    const bytes = await this.readBytes(count, timeoutMs);
    const requested = Math.max(0, Number(count || 1));
    return {
      read: bytes.length,
      hex: bytesToHex(bytes),
      timedOut: bytes.length < requested,
    };
  }

  async resetBuffers() {
    this.readBuffer = Buffer.alloc(0);
    if (this.port?.isOpen) {
      await flushSerialPort(this.port);
    }
    return { reset: true };
  }

  async prepareClone(wantsDtr, wantsRts, settleMs, baudRate) {
    this.ensureOpen();
    await this.applyBaudRate(baudRate);
    await this.resetBuffers();
    await setSerialPortLines(this.port, {
      dtr: Boolean(wantsDtr),
      rts: Boolean(wantsRts),
    });
    const settle = Math.max(0, Number(settleMs || 350));
    if (settle > 0) {
      await sleep(settle);
    }
    return { prepared: true, settleMs: settle, baudRate: this.baudRate };
  }

  // Mid-clone control-line change; a null line is left as it is.
  async setSignals(dataTerminalReady, requestToSend) {
    this.ensureOpen();
    const lines = {};
    if (dataTerminalReady !== null && dataTerminalReady !== undefined) {
      lines.dtr = Boolean(dataTerminalReady);
    }
    if (requestToSend !== null && requestToSend !== undefined) {
      lines.rts = Boolean(requestToSend);
    }
    if (!Object.keys(lines).length) {
      return { applied: false };
    }
    await setSerialPortLines(this.port, lines);
    return { applied: true, ...lines };
  }

  // Mid-clone port reconfiguration. node-serialport can change the settings on
  // an open handle, so this needs no close/reopen dance -- unlike Web Serial,
  // whose only route is closing the port and opening it again.
  async reconfigure(options = {}) {
    this.ensureOpen();
    const current = this.portOptions || {};
    const next = { ...current, ...options };
    const changed = Object.keys(next).filter((key) => next[key] !== current[key]);
    if (!changed.length) {
      return { reconfigured: false, options: next, changed };
    }
    await this._applySettings(next);
    return { reconfigured: true, options: next, changed };
  }

  // node-serialport's update() only carries the baud rate, so a framing change
  // needs the handle closed and reopened -- the same route Web Serial takes for
  // everything. Reported through portOptions only once it has actually landed,
  // so a failure cannot leave the record claiming settings the port never took.
  async _applySettings(nextOptions) {
    const current = this.portOptions || {};
    const framingChanged = NODE_FRAMING_OPTIONS.some(
      (key) => nextOptions[key] !== current[key],
    );
    if (!framingChanged) {
      await updateSerialPortBaudRate(this.port, Number(nextOptions.baudRate));
      this.portOptions = nextOptions;
      return;
    }
    const pending = this.readBuffer;
    this.port.off("data", this.onData);
    await closeSerialPort(this.port);
    this.port = new SerialPort({ ...nextOptions, path: this.portPath, autoOpen: false });
    this.port.on("data", this.onData);
    await openSerialPort(this.port);
    this.portOptions = nextOptions;
    this.readBuffer = pending;
  }
}

class StubSerialBridge {
  constructor() {
    // Recorded so tests can assert what the Python bridge asked for — the
    // driver's baud rate in particular, which nothing else observes.
    this.prepareCloneCalls = [];
    // Every setSignals() call, in order, so tests can assert that a driver's
    // control-line changes actually reached the transport (issue #77).
    this.signalCalls = [];
    // Every reconfigure() the pipe actually pushed, in order. The stub opens at
    // no particular rate, so it reports every call as a change.
    this.reconfigureCalls = [];
  }

  async open() {
    return { connected: true, message: "stub open" };
  }

  async close() {
    return { connected: false, message: "stub close" };
  }

  async writeHex() {
    return { written: 0, hex: "" };
  }

  async readHex() {
    return { read: 0, hex: "", timedOut: true };
  }

  async writeBytes() {
    return { written: 0 };
  }

  async readBytes() {
    return [];
  }

  async inWaiting() {
    return { available: 0 };
  }

  async resetBuffers() {
    return { reset: true };
  }

  async prepareClone(wantsDtr, wantsRts, settleMs, baudRate) {
    this.prepareCloneCalls.push({
      wantsDtr: Boolean(wantsDtr),
      wantsRts: Boolean(wantsRts),
      settleMs: Number(settleMs || 0),
      baudRate: Number(baudRate || 0),
    });
    return { prepared: true, settleMs: 0, baudRate: Number(baudRate || 0) };
  }

  async setSignals(dataTerminalReady, requestToSend) {
    this.signalCalls.push({ dataTerminalReady, requestToSend });
    return { applied: true };
  }

  async reconfigure(options = {}) {
    this.reconfigureCalls.push({ ...options });
    return { reconfigured: true, options, changed: Object.keys(options) };
  }
}

function installSerialGlobals(serialBridge, target = globalThis) {
  target.serial_open = (baudRate) => serialBridge.open(baudRate);
  target.serial_close = () => serialBridge.close();
  target.serial_write_hex = (hex) => serialBridge.writeHex(hex);
  target.serial_read_hex = (count, timeoutMs) => serialBridge.readHex(count, timeoutMs);
  target.serial_write_bytes = (bytes) => serialBridge.writeBytes(bytes);
  target.serial_read_bytes = (count, timeoutMs) => serialBridge.readBytes(count, timeoutMs);
  target.serial_in_waiting = (waitMs) => serialBridge.inWaiting(waitMs);
  target.serial_log = (message) => {
    console.log(`[SERIAL] ${String(message || "")}`);
    return { logged: true };
  };
  target.serial_progress = () => ({ reported: true });
  target.serial_prepare_clone = (wantsDtr, wantsRts, settleMs, baudRate) =>
    serialBridge.prepareClone(wantsDtr, wantsRts, settleMs, baudRate);
  target.serial_set_signals = (dtr, rts) => serialBridge.setSignals(dtr, rts);
  target.serial_reconfigure = (baudRate, dataBits, stopBits, parity) => {
    const options = {};
    if (baudRate !== null && baudRate !== undefined) {
      options.baudRate = Number(baudRate);
    }
    if (dataBits !== null && dataBits !== undefined) {
      options.dataBits = Number(dataBits);
    }
    if (stopBits !== null && stopBits !== undefined) {
      options.stopBits = Number(stopBits);
    }
    if (parity !== null && parity !== undefined) {
      options.parity = String(parity);
    }
    return serialBridge.reconfigure(options);
  };
  target.serial_reset_buffers = () => serialBridge.resetBuffers();
}

export class TestRadioHarness {
  // serialBridge lets a caller supply its own bridge object - a simulated
  // radio, say - in place of the stub or the real serial port. It only has to
  // answer the ops installSerialGlobals() forwards.
  constructor({
    repoRoot,
    chirpDir = "",
    portPath = "",
    serialMode = "stub",
    serialBridge = null,
  } = {}) {
    this.repoRoot = path.resolve(String(repoRoot || process.cwd()));
    this.chirpDir = String(chirpDir || "");
    this.portPath = String(portPath || "");
    this.serialMode = String(serialMode || "stub");
    this.pythonSource = null;
    this.pyodide = null;
    this.serialBridge = serialBridge;
  }

  async init() {
    if (this.pyodide) {
      return this;
    }
    this.pythonSource = await createLocalPythonSource(this.repoRoot, this.chirpDir);
    installFetchChirpSourceGlobal(this.pythonSource);

    if (!this.serialBridge) {
      this.serialBridge =
        this.serialMode === "node"
          ? new NodeSerialBridge(this.portPath)
          : new StubSerialBridge();
    }
    installSerialGlobals(this.serialBridge);

    this.pyodide = await loadPyodide();
    await seedPyodideRuntime(this.pyodide, this.pythonSource);
    return this;
  }

  async runPythonJson(python, vars = {}) {
    await this.init();
    for (const [key, value] of Object.entries(vars)) {
      this.pyodide.globals.set(key, value);
    }
    const jsonText = await this.pyodide.runPythonAsync(python);
    return JSON.parse(jsonText);
  }

  async getRadioInfo(moduleName, className) {
    return this.runPythonJson(
      `
ensure_radio_module(_sel_module)
_cls = _import_radio_class(_sel_module, _sel_class)
_baud = int(getattr(_cls, "BAUD_RATE", 0) or 9600)
json.dumps({
  "vendor": str(getattr(_cls, "VENDOR", "")),
  "model": str(getattr(_cls, "MODEL", "")),
  "baudRate": _baud,
})
      `,
      { _sel_module: moduleName, _sel_class: className },
    );
  }

  async connect({ moduleName, className, baudRate } = {}) {
    const radioInfo =
      moduleName && className ? await this.getRadioInfo(moduleName, className) : null;
    const effectiveBaud = Number.isFinite(Number(baudRate))
      ? Number(baudRate)
      : Number(radioInfo?.baudRate || 9600);
    return this.runPythonJson("json.dumps(await webserial_connect(_baud))", {
      _baud: effectiveBaud,
    });
  }

  async disconnect() {
    try {
      return await this.runPythonJson("json.dumps(await webserial_disconnect())");
    } catch (error) {
      try {
        await this.serialBridge?.close();
      } catch {
        // no-op
      }
      throw error;
    }
  }

  async readCodeplug(moduleName, className) {
    return this.runPythonJson(
      "json.dumps(await download_selected_radio(_sel_module, _sel_class))",
      { _sel_module: moduleName, _sel_class: className },
    );
  }

  async writeCodeplug(moduleName, className, rows, settingsGroups = []) {
    const codeplug =
      rows && typeof rows === "object" && !Array.isArray(rows) ? rows : null;
    const normalizedRows = codeplug ? codeplug.rows || [] : rows || [];
    const normalizedSettings = codeplug ? codeplug.settings || [] : settingsGroups || [];
    return this.runPythonJson(
      "json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json), json.loads(_settings_json)))",
      {
        _sel_module: moduleName,
        _sel_class: className,
        _rows_json: JSON.stringify(normalizedRows),
        _settings_json: JSON.stringify(normalizedSettings),
      },
    );
  }

  async readCodeplugBinary(moduleName, className) {
    const result = await this.runPythonJson(
      "json.dumps(get_cached_image_base64(_sel_module, _sel_class))",
      { _sel_module: moduleName, _sel_class: className },
    );
    return {
      ...result,
      image: decodeBase64ToBytes(result.imageBase64),
    };
  }

  async exportCodeplugBinary(moduleName, className, rows, settingsGroups = []) {
    const codeplug =
      rows && typeof rows === "object" && !Array.isArray(rows) ? rows : null;
    const normalizedRows = codeplug ? codeplug.rows || [] : rows || [];
    const normalizedSettings = codeplug ? codeplug.settings || [] : settingsGroups || [];
    const result = await this.runPythonJson(
      "json.dumps(export_image_base64(_sel_module, _sel_class, json.loads(_rows_json), json.loads(_settings_json)))",
      {
        _sel_module: moduleName,
        _sel_class: className,
        _rows_json: JSON.stringify(normalizedRows),
        _settings_json: JSON.stringify(normalizedSettings),
      },
    );
    return {
      ...result,
      image: decodeBase64ToBytes(result.imageBase64),
    };
  }

  async loadCodeplugBinary(imageBytes) {
    const result = await this.runPythonJson(
      "json.dumps(load_image_base64(_image_b64))",
      {
        _image_b64: encodeBytesToBase64(imageBytes),
      },
    );
    return {
      ...result,
      image: Uint8Array.from(imageBytes || []),
    };
  }

  async writeCodeplugBinary(moduleName, className, imageBytes) {
    const loaded = await this.loadCodeplugBinary(imageBytes);
    if (String(loaded.module || "") !== String(moduleName || "")) {
      throw new Error(
        `Binary image driver mismatch: expected module ${moduleName}, got ${loaded.module || "<unknown>"}`,
      );
    }
    if (String(loaded.className || "") !== String(className || "")) {
      throw new Error(
        `Binary image driver mismatch: expected class ${className}, got ${loaded.className || "<unknown>"}`,
      );
    }
    return this.writeCodeplug(moduleName, className, loaded);
  }
}

export async function createTestRadioHarness(options = {}) {
  const harness = new TestRadioHarness(options);
  return harness.init();
}

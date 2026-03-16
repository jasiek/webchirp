import fs from "node:fs/promises";
import path from "node:path";
import { loadPyodide } from "pyodide";
import { SerialPort } from "serialport";
import {
  createFilesystemPythonSource,
  installFetchChirpSourceGlobal,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

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

class NodeSerialBridge {
  constructor(portPath) {
    this.portPath = String(portPath || "");
    this.port = null;
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
      return {
        connected: true,
        message: `Already connected to ${this.portPath}`,
        deviceName: this.portPath,
      };
    }
    const baud = Math.max(1, Number(baudRate || 9600));
    this.port = new SerialPort({
      path: this.portPath,
      baudRate: baud,
      autoOpen: false,
    });
    this.readBuffer = Buffer.alloc(0);
    this.port.on("data", this.onData);
    await openSerialPort(this.port);
    return {
      connected: true,
      message: `Connected to ${this.portPath} @ ${baud} bps`,
      deviceName: this.portPath,
    };
  }

  async close() {
    if (!this.port) {
      return { connected: false, message: "Serial already disconnected." };
    }
    const current = this.port;
    this.port = null;
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

  async prepareClone(wantsDtr, wantsRts, settleMs) {
    this.ensureOpen();
    await this.resetBuffers();
    await setSerialPortLines(this.port, {
      dtr: Boolean(wantsDtr),
      rts: Boolean(wantsRts),
    });
    const settle = Math.max(0, Number(settleMs || 350));
    if (settle > 0) {
      await sleep(settle);
    }
    return { prepared: true, settleMs: settle };
  }
}

class StubSerialBridge {
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

  async resetBuffers() {
    return { reset: true };
  }

  async prepareClone() {
    return { prepared: true, settleMs: 0 };
  }
}

function installSerialGlobals(serialBridge, target = globalThis) {
  target.serial_open = (baudRate) => serialBridge.open(baudRate);
  target.serial_close = () => serialBridge.close();
  target.serial_write_hex = (hex) => serialBridge.writeHex(hex);
  target.serial_read_hex = (count, timeoutMs) => serialBridge.readHex(count, timeoutMs);
  target.serial_write_bytes = (bytes) => serialBridge.writeBytes(bytes);
  target.serial_read_bytes = (count, timeoutMs) => serialBridge.readBytes(count, timeoutMs);
  target.serial_log = (message) => {
    console.log(`[SERIAL] ${String(message || "")}`);
    return { logged: true };
  };
  target.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
    serialBridge.prepareClone(wantsDtr, wantsRts, settleMs);
  target.serial_reset_buffers = () => serialBridge.resetBuffers();
}

export class TestRadioHarness {
  constructor({ repoRoot, chirpDir = "", portPath = "", serialMode = "stub" } = {}) {
    this.repoRoot = path.resolve(String(repoRoot || process.cwd()));
    this.chirpDir = String(chirpDir || "");
    this.portPath = String(portPath || "");
    this.serialMode = String(serialMode || "stub");
    this.pythonSource = null;
    this.pyodide = null;
    this.serialBridge = null;
  }

  async init() {
    if (this.pyodide) {
      return this;
    }
    this.pythonSource = await createLocalPythonSource(this.repoRoot, this.chirpDir);
    installFetchChirpSourceGlobal(this.pythonSource);

    this.serialBridge =
      this.serialMode === "node"
        ? new NodeSerialBridge(this.portPath)
        : new StubSerialBridge();
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
}

export async function createTestRadioHarness(options = {}) {
  const harness = new TestRadioHarness(options);
  return harness.init();
}

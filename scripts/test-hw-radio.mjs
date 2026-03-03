import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { SerialPort } from "serialport";
import {
  createFilesystemPythonSource,
  installFetchChirpSourceGlobal,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

const DEFAULT_REBOOT_DELAY_MS = 5000;

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

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || "");
    if (!raw.startsWith("--")) {
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    if (key === "help") {
      out.help = "1";
      continue;
    }
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = "1";
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  npm run test:hw -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R",
    "",
    "Options:",
    "  --port PATH            Required serial path (for example /dev/ttyUSB0 or COM3)",
    "  --module NAME          Required CHIRP driver module short name (for example uv5r)",
    "  --class NAME           Required CHIRP driver class name (for example BaofengUV5R)",
    "  --baud N               Optional serial baud override (default: driver BAUD_RATE or 9600)",
    "  --chirp-dir PATH       Optional CHIRP source tree root (default: ./chirp or WEBCHIRP_CHIRP_DIR)",
    "  --serial-timeout-s N   Optional serial read timeout seconds (sets WEBCHIRP_SERIAL_TIMEOUT_S)",
    "  --reboot-delay-ms N    Wait after download before upload (default: 5000)",
  ].join("\n");
}

async function pathExists(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveChirpPackageDir(inputDir) {
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

function installNodeSerialGlobals(serialBridge) {
  globalThis.serial_open = (baudRate) => serialBridge.open(baudRate);
  globalThis.serial_close = () => serialBridge.close();
  globalThis.serial_write_hex = (hex) => serialBridge.writeHex(hex);
  globalThis.serial_read_hex = (count, timeoutMs) => serialBridge.readHex(count, timeoutMs);
  globalThis.serial_write_bytes = (bytes) => serialBridge.writeBytes(bytes);
  globalThis.serial_read_bytes = (count, timeoutMs) => serialBridge.readBytes(count, timeoutMs);
  globalThis.serial_log = (message) => {
    console.log(`[SERIAL] ${String(message || "")}`);
    return { logged: true };
  };
  globalThis.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
    serialBridge.prepareClone(wantsDtr, wantsRts, settleMs);
  globalThis.serial_reset_buffers = () => serialBridge.resetBuffers();
}

async function runPythonJson(pyodide, python, vars = {}) {
  for (const [key, value] of Object.entries(vars)) {
    pyodide.globals.set(key, value);
  }
  const jsonText = await pyodide.runPythonAsync(python);
  return JSON.parse(jsonText);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const portPath = String(args.port || "");
  const moduleName = String(args.module || "");
  const className = String(args.class || args["class-name"] || "");
  if (!portPath || !moduleName || !className) {
    console.error(usage());
    throw new Error("--port, --module, and --class are required");
  }

  if (args["serial-timeout-s"]) {
    process.env.WEBCHIRP_SERIAL_TIMEOUT_S = String(args["serial-timeout-s"]);
  }
  const rebootDelayOverride = Number(args["reboot-delay-ms"]);
  const rebootDelayMs = Number.isFinite(rebootDelayOverride)
    ? Math.max(0, rebootDelayOverride)
    : DEFAULT_REBOOT_DELAY_MS;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pythonSource = await createLocalPythonSource(repoRoot, String(args["chirp-dir"] || ""));
  installFetchChirpSourceGlobal(pythonSource);

  const serialBridge = new NodeSerialBridge(portPath);
  installNodeSerialGlobals(serialBridge);

  const pyodide = await loadPyodide();
  await seedPyodideRuntime(pyodide, pythonSource);

  try {
    const radioInfo = await runPythonJson(
      pyodide,
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

    const baudOverride = args.baud ? Number(args.baud) : NaN;
    const baudRate = Number.isFinite(baudOverride) ? baudOverride : Number(radioInfo.baudRate || 9600);
    console.log(
      `Running live read->write test on ${radioInfo.vendor} ${radioInfo.model} (${moduleName}.${className}) via ${portPath} @ ${baudRate} bps`,
    );

    const connectResult = await runPythonJson(
      pyodide,
      "json.dumps(await webserial_connect(_baud))",
      { _baud: baudRate },
    );
    if (!connectResult.connected) {
      throw new Error(`Serial connect failed: ${JSON.stringify(connectResult)}`);
    }

    const downloaded = await runPythonJson(
      pyodide,
      "json.dumps(await download_selected_radio(_sel_module, _sel_class))",
      { _sel_module: moduleName, _sel_class: className },
    );

    const rows = Array.isArray(downloaded.rows) ? downloaded.rows : [];
    console.log(`Download complete: ${rows.length} channel row(s) read.`);
    if (rebootDelayMs > 0) {
      console.log(`Waiting ${rebootDelayMs} ms for radio reboot before upload...`);
      await sleep(rebootDelayMs);
    }

    const uploaded = await runPythonJson(
      pyodide,
      "json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json)))",
      {
        _sel_module: moduleName,
        _sel_class: className,
        _rows_json: JSON.stringify(rows),
      },
    );

    if (!uploaded.uploaded) {
      throw new Error(`Upload failed: ${JSON.stringify(uploaded)}`);
    }

    console.log("Upload complete: wrote the downloaded codeplug back to radio.");
  } finally {
    try {
      await runPythonJson(pyodide, "json.dumps(await webserial_disconnect())");
    } catch (error) {
      console.error(`Disconnect warning: ${error?.message || String(error)}`);
      try {
        await serialBridge.close();
      } catch {
        // no-op
      }
    }
  }
}

main().catch((error) => {
  const detail = (error && error.stack) || error?.message || String(error);
  console.error(detail);
  process.exitCode = 1;
});

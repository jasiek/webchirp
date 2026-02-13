import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const CHIRP_FILES = [
  ["/chirp/__init__.py", "chirp/__init__.py"],
  ["/chirp/errors.py", "chirp/errors.py"],
  ["/chirp/util.py", "chirp/util.py"],
  ["/chirp/memmap.py", "chirp/memmap.py"],
  ["/chirp/chirp_common.py", "chirp/chirp_common.py"],
  ["/chirp/directory.py", "chirp/directory.py"],
  ["/chirp/pyPEG.py", "chirp/pyPEG.py"],
  ["/chirp/bitwise_grammar.py", "chirp/bitwise_grammar.py"],
  ["/chirp/bitwise.py", "chirp/bitwise.py"],
  ["/chirp/settings.py", "chirp/settings.py"],
  ["/chirp/drivers/generic_csv.py", "chirp/drivers/generic_csv.py"],
  ["/chirp/drivers/h777.py", "chirp/drivers/h777.py"],
];

function usage() {
  console.log(`Usage:
  node scripts/smoke-radio-clone.mjs --module <mod> --class <Class> --port <serial-port> [--baud <n>] [--max-diff-bytes <n>]

Example:
  node scripts/smoke-radio-clone.mjs --module h777 --class H777Radio --port /dev/tty.usbserial-0001 --max-diff-bytes 0`);
}

function parseArgs(argv) {
  const out = {
    module: "",
    className: "",
    port: "",
    baud: 9600,
    maxDiffBytes: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--module") {
      out.module = String(v || "");
      i += 1;
      continue;
    }
    if (k === "--class") {
      out.className = String(v || "");
      i += 1;
      continue;
    }
    if (k === "--port") {
      out.port = String(v || "");
      i += 1;
      continue;
    }
    if (k === "--baud") {
      out.baud = Number(v || 9600);
      i += 1;
      continue;
    }
    if (k === "--max-diff-bytes") {
      out.maxDiffBytes = Number(v || 0);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${k}`);
  }
  if (!out.module || !out.className || !out.port) {
    throw new Error("Missing required arguments: --module --class --port");
  }
  return out;
}

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

function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

class NodeSerialBridge {
  constructor(serialPortCtor, portPath) {
    this.SerialPort = serialPortCtor;
    this.portPath = portPath;
    this.port = null;
    this.readBuffer = new Uint8Array(0);
  }

  async open(baudRate) {
    if (this.port?.isOpen) {
      return { connected: true, message: "Already connected." };
    }
    this.port = new this.SerialPort({
      path: this.portPath,
      baudRate: Number(baudRate || 9600),
      autoOpen: false,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
    });
    this.port.on("data", (chunk) => {
      this.readBuffer = concatUint8(this.readBuffer, Uint8Array.from(chunk));
    });
    await new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
    return { connected: true, message: `Connected ${this.portPath} @ ${baudRate}` };
  }

  async close() {
    if (!this.port) {
      return { connected: false, message: "No port connected." };
    }
    const p = this.port;
    this.port = null;
    this.readBuffer = new Uint8Array(0);
    if (!p.isOpen) {
      return { connected: false, message: "Disconnected." };
    }
    await new Promise((resolve, reject) => {
      p.close((err) => (err ? reject(err) : resolve()));
    });
    return { connected: false, message: "Disconnected." };
  }

  async writeHex(hex) {
    const bytes = parseHex(hex);
    return this.writeBytes(bytes).then(() => ({ written: bytes.length, hex: bytesToHex(bytes) }));
  }

  async writeBytes(bytesLike) {
    if (!this.port?.isOpen) {
      throw new Error("Port is not connected.");
    }
    const bytes = Uint8Array.from(bytesLike || []);
    await new Promise((resolve, reject) => {
      this.port.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      this.port.drain((err) => (err ? reject(err) : resolve()));
    });
    return { written: bytes.length };
  }

  async readHex(count, timeoutMs) {
    const wanted = Math.max(0, Number(count || 0));
    const timeout = Math.max(1, Number(timeoutMs || 1200));
    const start = Date.now();
    while (this.readBuffer.length < wanted && Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 10));
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
    const res = await this.readHex(count, timeoutMs);
    if (!res.hex) {
      return [];
    }
    return res.hex
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 16));
  }

  async prepareClone(wantsDtr, wantsRts, settleMs) {
    if (!this.port?.isOpen) {
      throw new Error("Port is not connected.");
    }
    this.readBuffer = new Uint8Array(0);
    await new Promise((resolve, reject) => {
      this.port.set(
        {
          dtr: Boolean(wantsDtr),
          rts: Boolean(wantsRts),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(settleMs || 0))));
    return { prepared: true };
  }

  resetBuffers() {
    this.readBuffer = new Uint8Array(0);
    return { reset: true };
  }
}

function mkdirp(pyodide, p) {
  const parts = p.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      pyodide.FS.mkdir(current);
    } catch {
      // Exists.
    }
  }
}

function resolveChirpSourcePath(relPath) {
  const normalized = path.posix.normalize(relPath);
  if (!normalized.startsWith("/chirp/")) {
    throw new Error(`Unsupported CHIRP source path: ${relPath}`);
  }
  const suffix = normalized.slice("/chirp/".length);
  return path.join(repoRoot, "chirp", "chirp", suffix);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  const options = parseArgs(argv);

  const [{ loadPyodide }, { SerialPort }] = await Promise.all([
    import("pyodide"),
    import("serialport"),
  ]);
  const serialBridge = new NodeSerialBridge(SerialPort, options.port);

  globalThis.serial_open = (baudRate) => serialBridge.open(Number(baudRate || options.baud));
  globalThis.serial_close = () => serialBridge.close();
  globalThis.serial_write_hex = (hex) => serialBridge.writeHex(String(hex || ""));
  globalThis.serial_read_hex = (count, timeoutMs) =>
    serialBridge.readHex(Number(count || 1), Number(timeoutMs || 1200));
  globalThis.serial_write_bytes = (bytes) => serialBridge.writeBytes(Array.from(bytes || []));
  globalThis.serial_read_bytes = (count, timeoutMs) =>
    serialBridge.readBytes(Number(count || 1), Number(timeoutMs || 1200));
  globalThis.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
    serialBridge.prepareClone(Boolean(wantsDtr), Boolean(wantsRts), Number(settleMs || 350));
  globalThis.serial_reset_buffers = () => serialBridge.resetBuffers();
  globalThis.serial_log = (message) => {
    console.log(`SERIAL ${String(message || "")}`);
    return { logged: true };
  };
  globalThis.fetch_chirp_source = async (relPath) => {
    const sourcePath = resolveChirpSourcePath(String(relPath || ""));
    return await readFile(sourcePath, "utf8");
  };

  const pyodide = await loadPyodide();
  mkdirp(pyodide, "/webchirp_runtime/chirp/drivers");

  for (const [src, dest] of CHIRP_FILES) {
    const sourcePath = resolveChirpSourcePath(src);
    const text = await readFile(sourcePath, "utf8");
    pyodide.FS.writeFile(`/webchirp_runtime/${dest}`, text, { encoding: "utf8" });
  }

  const runtimePath = path.join(repoRoot, "web", "python", "runtime_bridge.py");
  const runtimePython = await readFile(runtimePath, "utf8");
  await pyodide.runPythonAsync(runtimePython);

  try {
    pyodide.globals.set("_sel_module", options.module);
    pyodide.globals.set("_sel_class", options.className);
    pyodide.globals.set("_driver_key", `${options.module}.${options.className}`);

    const firstJson = await pyodide.runPythonAsync(
      "import json; json.dumps(await download_selected_radio(_sel_module, _sel_class))",
    );
    const first = JSON.parse(firstJson);
    pyodide.globals.set("_rows_json", JSON.stringify(first.rows || []));
    await pyodide.runPythonAsync(
      "_smoke_before = bytes(LAST_IMAGE_BY_DRIVER.get(_driver_key, b''))",
    );
    await pyodide.runPythonAsync(
      "import json; json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json)))",
    );
    await pyodide.runPythonAsync(
      "import json; json.dumps(await download_selected_radio(_sel_module, _sel_class))",
    );

    const verifyJson = await pyodide.runPythonAsync(
      `import json
before = bytes(_smoke_before)
after = bytes(LAST_IMAGE_BY_DRIVER.get(_driver_key, b""))
diff = sum(1 for a, b in zip(before, after) if a != b)
json.dumps({"beforeSize": len(before), "afterSize": len(after), "diffBytes": diff})`,
    );
    const verify = JSON.parse(verifyJson);
    const ok =
      verify.beforeSize === verify.afterSize && verify.diffBytes <= Number(options.maxDiffBytes || 0);
    const result = {
      ok,
      module: options.module,
      className: options.className,
      port: options.port,
      baud: options.baud,
      rows: Array.isArray(first.rows) ? first.rows.length : 0,
      beforeSize: verify.beforeSize,
      afterSize: verify.afterSize,
      diffBytes: verify.diffBytes,
      maxDiffBytes: Number(options.maxDiffBytes || 0),
    };
    console.log(JSON.stringify(result));
    if (!ok) {
      throw new Error(
        `Verification failed: before=${verify.beforeSize} after=${verify.afterSize} diff=${verify.diffBytes}`,
      );
    }
  } finally {
    await serialBridge.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});

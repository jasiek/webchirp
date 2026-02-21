import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { SerialPort } from "serialport";

const CORE_CHIRP_FILES = [
  ["chirp/__init__.py", "chirp/__init__.py"],
  ["chirp/errors.py", "chirp/errors.py"],
  ["chirp/util.py", "chirp/util.py"],
  ["chirp/memmap.py", "chirp/memmap.py"],
  ["chirp/chirp_common.py", "chirp/chirp_common.py"],
  ["chirp/directory.py", "chirp/directory.py"],
  ["chirp/pyPEG.py", "chirp/pyPEG.py"],
  ["chirp/bitwise_grammar.py", "chirp/bitwise_grammar.py"],
  ["chirp/bitwise.py", "chirp/bitwise.py"],
  ["chirp/settings.py", "chirp/settings.py"],
  ["chirp/drivers/generic_csv.py", "chirp/drivers/generic_csv.py"],
  ["chirp/drivers/h777.py", "chirp/drivers/h777.py"],
];

const PMR446_FREQS = [
  "446.006250",
  "446.018750",
  "446.031250",
  "446.043750",
  "446.056250",
  "446.068750",
  "446.081250",
  "446.093750",
  "446.106250",
  "446.118750",
  "446.131250",
  "446.143750",
  "446.156250",
  "446.168750",
  "446.181250",
  "446.193750",
];

function parseArgs(argv) {
  const out = {
    module: "uv5r",
    className: "BaofengUV5R",
    port: process.env.WEBCHIRP_PORT || "",
    baudRate: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--module") {
      out.module = argv[i + 1] || out.module;
      i += 1;
    } else if (token === "--class") {
      out.className = argv[i + 1] || out.className;
      i += 1;
    } else if (token === "--port") {
      out.port = argv[i + 1] || "";
      i += 1;
    } else if (token === "--baud") {
      out.baudRate = Number(argv[i + 1] || "0") || null;
      i += 1;
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return out;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/test-hw-radio.mjs [--module uv5r] [--class BaofengUV5R] [--port /dev/tty.usbserial*] [--baud 9600]",
      "",
      "Environment fallback:",
      "  WEBCHIRP_PORT=/dev/tty...  Serial path to use when --port is omitted",
    ].join("\n"),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function parseHex(text) {
  const parts = String(text || "")
    .trim()
    .replace(/[^0-9a-fA-F]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    out[i] = Number.parseInt(parts[i], 16) & 0xff;
  }
  return out;
}

function makePmrRows() {
  return PMR446_FREQS.map((freq, index) => ({
    Location: String(index + 1),
    Name: `PMR${String(index + 1).padStart(2, "0")}`,
    Frequency: freq,
    Duplex: "",
    Offset: "0.000000",
    Tone: "",
    rToneFreq: "88.5",
    cToneFreq: "88.5",
    DtcsCode: "023",
    DtcsPolarity: "NN",
    Mode: "NFM",
    TStep: "12.50",
    Skip: "",
    Power: "Low",
    Comment: "webchirp-hw-test",
  }));
}

function canonicalizeRows(rows) {
  const keys = [
    "Location",
    "Name",
    "Frequency",
    "Duplex",
    "Offset",
    "Tone",
    "rToneFreq",
    "cToneFreq",
    "DtcsCode",
    "DtcsPolarity",
    "Mode",
    "TStep",
    "Skip",
    "Power",
    "Comment",
  ];
  return [...rows]
    .map((row) => {
      const out = {};
      for (const key of keys) {
        out[key] = String(row[key] ?? "");
      }
      return out;
    })
    .sort((a, b) => Number(a.Location) - Number(b.Location));
}

function assertRowsEqual(expected, actual) {
  const exp = canonicalizeRows(expected);
  const got = canonicalizeRows(actual);
  if (exp.length !== got.length) {
    throw new Error(`Row count mismatch: expected ${exp.length}, got ${got.length}`);
  }
  for (let i = 0; i < exp.length; i += 1) {
    const left = exp[i];
    const right = got[i];
    for (const key of Object.keys(left)) {
      if (left[key] !== right[key]) {
        throw new Error(
          `Row mismatch at index ${i} field ${key}: expected ${JSON.stringify(left[key])}, got ${JSON.stringify(right[key])}`,
        );
      }
    }
  }
}

class NodeSerialBridge {
  constructor(portPath) {
    this.portPath = portPath;
    this.port = null;
    this.readBuffer = Buffer.alloc(0);
    this.onData = (chunk) => {
      this.readBuffer = Buffer.concat([this.readBuffer, Buffer.from(chunk)]);
    };
  }

  async open(baudRate) {
    if (this.port?.isOpen) {
      return { connected: true, message: "Already connected." };
    }
    const selectedPath = this.portPath || (await this.autoDetectPortPath());
    this.portPath = selectedPath;
    this.port = new SerialPort({
      path: selectedPath,
      baudRate: Number(baudRate),
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      autoOpen: false,
    });
    this.port.on("data", this.onData);
    this.port.on("error", (err) => {
      console.error(`[serial:error] ${err?.message || String(err)}`);
    });
    await new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
    return {
      connected: true,
      message: `Connected to ${selectedPath} at ${baudRate} baud`,
      deviceName: selectedPath,
    };
  }

  async close() {
    if (!this.port) {
      return { connected: false, message: "No port connected." };
    }
    const openPort = this.port;
    this.port = null;
    this.readBuffer = Buffer.alloc(0);
    openPort.off("data", this.onData);
    if (openPort.isOpen) {
      await new Promise((resolve, reject) => {
        openPort.close((err) => (err ? reject(err) : resolve()));
      });
    }
    return { connected: false, message: "Disconnected." };
  }

  async writeBytes(bytesLike) {
    if (!this.port?.isOpen) {
      throw new Error("Port is not connected.");
    }
    const data = Buffer.from(bytesLike || []);
    await new Promise((resolve, reject) => {
      this.port.write(data, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      this.port.drain((err) => (err ? reject(err) : resolve()));
    });
    return { written: data.length };
  }

  async writeHex(text) {
    const bytes = parseHex(text);
    await this.writeBytes(bytes);
    return { written: bytes.length, hex: bytesToHex(bytes) };
  }

  async readBytes(count, timeoutMs) {
    const need = Math.max(0, Number(count || 0));
    const deadline = Date.now() + Math.max(1, Number(timeoutMs || 1000));
    while (this.readBuffer.length < need && Date.now() < deadline) {
      await sleep(10);
    }
    const available = Math.min(need, this.readBuffer.length);
    const out = this.readBuffer.subarray(0, available);
    this.readBuffer = this.readBuffer.subarray(available);
    return Array.from(out.values());
  }

  async readHex(count, timeoutMs) {
    const bytes = await this.readBytes(count, timeoutMs);
    return {
      read: bytes.length,
      hex: bytesToHex(bytes),
      timedOut: bytes.length < Number(count || 0),
    };
  }

  async prepareClone(wantsDtr, wantsRts, settleMs) {
    if (!this.port?.isOpen) {
      throw new Error("Port is not connected.");
    }
    this.readBuffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      this.port.flush((err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      this.port.set(
        {
          dtr: Boolean(wantsDtr),
          rts: Boolean(wantsRts),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    await sleep(Math.max(0, Number(settleMs || 0)));
    return { prepared: true };
  }

  async resetBuffers() {
    if (!this.port?.isOpen) {
      this.readBuffer = Buffer.alloc(0);
      return { reset: true };
    }
    this.readBuffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      this.port.flush((err) => (err ? reject(err) : resolve()));
    });
    return { reset: true };
  }

  async autoDetectPortPath() {
    const ports = await SerialPort.list();
    if (!ports.length) {
      throw new Error("No serial ports detected. Provide --port.");
    }
    if (ports.length > 1) {
      const names = ports.map((p) => p.path).join(", ");
      throw new Error(
        `Multiple serial ports detected (${names}). Provide --port to select one.`,
      );
    }
    return ports[0].path;
  }
}

async function mkdirpFs(pyodide, dir) {
  const parts = dir.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      pyodide.FS.mkdir(current);
    } catch {
      // already exists
    }
  }
}

async function bootstrapRuntime(pyodide, repoRoot) {
  await mkdirpFs(pyodide, "/webchirp_runtime/chirp/drivers");
  for (const [src, dest] of CORE_CHIRP_FILES) {
    const fullPath = path.join(repoRoot, "chirp", src);
    const text = await fs.readFile(fullPath, "utf8");
    pyodide.FS.writeFile(`/webchirp_runtime/${dest}`, text, { encoding: "utf8" });
  }
  const runtimePath = path.join(repoRoot, "web/python/runtime_bridge.py");
  const runtimePython = await fs.readFile(runtimePath, "utf8");
  await pyodide.runPythonAsync(runtimePython);
}

async function callJson(pyodide, python, vars = {}) {
  for (const [key, value] of Object.entries(vars)) {
    pyodide.globals.set(key, value);
  }
  const jsonText = await pyodide.runPythonAsync(python);
  return JSON.parse(jsonText);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serial = new NodeSerialBridge(args.port);
  const pyodide = await loadPyodide();

  globalThis.serial_open = (baudRate) => serial.open(Number(baudRate || 9600));
  globalThis.serial_close = () => serial.close();
  globalThis.serial_write_hex = (hex) => serial.writeHex(String(hex || ""));
  globalThis.serial_read_hex = (count, timeoutMs) =>
    serial.readHex(Number(count || 1), Number(timeoutMs || 1200));
  globalThis.serial_write_bytes = (bytes) => serial.writeBytes(Array.from(bytes || []));
  globalThis.serial_read_bytes = (count, timeoutMs) =>
    serial.readBytes(Number(count || 1), Number(timeoutMs || 1200));
  globalThis.serial_log = (message) => {
    console.log(`[py] ${String(message || "")}`);
    return { logged: true };
  };
  globalThis.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
    serial.prepareClone(Boolean(wantsDtr), Boolean(wantsRts), Number(settleMs || 350));
  globalThis.serial_reset_buffers = () => serial.resetBuffers();
  globalThis.fetch_chirp_source = async (sourcePath) => {
    const rel = String(sourcePath || "").replace(/^\/chirp\//, "");
    const fullPath = path.join(repoRoot, "chirp/chirp", rel);
    return await fs.readFile(fullPath, "utf8");
  };

  await bootstrapRuntime(pyodide, repoRoot);

  const selVars = { _sel_module: args.module, _sel_class: args.className };
  pyodide.globals.set("_sel_module", args.module);
  await pyodide.runPythonAsync("ensure_radio_module(_sel_module)");

  const baudRate = args.baudRate
    ? Number(args.baudRate)
    : Number(
        await callJson(
          pyodide,
          "json.dumps(int(getattr(getattr(__import__(f'chirp.drivers.{_sel_module}', fromlist=[_sel_class]), _sel_class), 'BAUD_RATE', 9600) or 9600))",
          selVars,
        ),
      );

  console.log(`Using radio ${args.module}.${args.className} at ${baudRate} baud`);

  const tempDir = await fs.mkdtemp(path.join(process.cwd(), "webchirp-hw-"));
  const backupPath = path.join(tempDir, "backup.img");
  console.log(`Backup image path: ${backupPath}`);

  let backupSaved = false;
  let failure = null;
  try {
    await serial.open(baudRate);

    console.log("Step 1/4: reading original codeplug");
    await callJson(
      pyodide,
      "json.dumps(await download_selected_radio(_sel_module, _sel_class))",
      selVars,
    );
    const backup = await callJson(
      pyodide,
      "json.dumps(get_cached_image_base64(_sel_module, _sel_class))",
      selVars,
    );
    await fs.writeFile(backupPath, Buffer.from(backup.imageBase64, "base64"));
    backupSaved = true;

    console.log("Step 2/4: erasing all channels");
    await callJson(
      pyodide,
      "json.dumps(await upload_selected_radio(_sel_module, _sel_class, []))",
      selVars,
    );

    console.log("Step 3/4: writing synthetic PMR codeplug");
    const syntheticRows = makePmrRows();
    await callJson(
      pyodide,
      "json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json)))",
      {
        ...selVars,
        _rows_json: JSON.stringify(syntheticRows),
      },
    );

    console.log("Step 4/4: reading back and comparing");
    const readback = await callJson(
      pyodide,
      "json.dumps(await download_selected_radio(_sel_module, _sel_class))",
      selVars,
    );
    assertRowsEqual(syntheticRows, readback.rows || []);
    console.log("Hardware test passed: readback matches synthetic PMR rows.");
  } catch (error) {
    failure = error;
    console.error(`Hardware test failed: ${error?.stack || error}`);
  } finally {
    if (backupSaved) {
      try {
        console.log("Restoring saved codeplug");
        const backupRaw = await fs.readFile(backupPath);
        await callJson(
          pyodide,
          "json.dumps(upload_image_base64(_sel_module, _sel_class, _image_b64))",
          {
            ...selVars,
            _image_b64: backupRaw.toString("base64"),
          },
        );
        console.log("Restore complete");
      } catch (restoreError) {
        console.error(`Restore failed: ${restoreError?.stack || restoreError}`);
        if (!failure) {
          failure = restoreError;
        }
      }
    } else {
      console.error("Restore skipped: backup image was not captured.");
    }
    await serial.close().catch(() => {});
  }

  if (failure) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

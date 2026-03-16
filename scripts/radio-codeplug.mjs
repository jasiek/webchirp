import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || "");
    if (!raw.startsWith("--")) {
      positionals.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      flags[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    if (key === "help") {
      flags.help = "1";
      continue;
    }
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      flags[key] = String(next);
      i += 1;
      continue;
    }
    flags[key] = "1";
  }
  return { positionals, flags };
}

function usage() {
  return [
    "Usage:",
    "  npm run radio:read -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R --format json --output /tmp/uv5r.json",
    "  npm run radio:write -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R --format json --input /tmp/uv5r.json",
    "",
    "Subcommands:",
    "  read                Download from radio and write JSON, CSV, or IMG output",
    "  write               Upload from JSON, CSV, or IMG input",
    "",
    "Required flags:",
    "  --port PATH         Serial path (for example /dev/ttyUSB0 or COM3)",
    "  --module NAME       CHIRP driver module short name (for example uv5r)",
    "  --class NAME        CHIRP driver class name (for example BaofengUV5R)",
    "",
    "Read flags:",
    "  --format FMT        json | csv | img (default: json)",
    "  --output PATH       Output file path",
    "",
    "Write flags:",
    "  --format FMT        json | csv | img (default: json)",
    "  --input PATH        Input file path",
    "",
    "Optional flags:",
    "  --baud N            Override driver default baud",
    "  --chirp-dir PATH    CHIRP source tree root (default: ./chirp or WEBCHIRP_CHIRP_DIR)",
    "  --serial-timeout-s N  Set WEBCHIRP_SERIAL_TIMEOUT_S for runtime reads",
  ].join("\n");
}

function assertFormat(value) {
  const format = String(value || "json").trim().toLowerCase();
  if (!["json", "csv", "img"].includes(format)) {
    throw new Error(`Unsupported format: ${value}`);
  }
  return format;
}

async function readUtf8(fullPath) {
  return fs.readFile(fullPath, "utf8");
}

async function writeUtf8(fullPath, text) {
  await fs.writeFile(fullPath, text, "utf8");
}

async function writeBinary(fullPath, bytes) {
  await fs.writeFile(fullPath, Buffer.from(bytes));
}

function normalizeJsonCodeplug(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object with rows/settings or imageBase64");
  }
  return parsed;
}

async function parseCsvToRows(harness, csvText) {
  return harness.runPythonJson(
    `
_parsed = parse_csv(_csv_text)
json.dumps({
  "rows": _parsed.get("rows") or [],
  "headers": _parsed.get("headers") or [],
  "errors": _parsed.get("errors") or [],
})
    `,
    { _csv_text: String(csvText || "") },
  );
}

async function runReadCommand(harness, { moduleName, className, format, outputPath }) {
  const codeplug = await harness.readCodeplug(moduleName, className);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (format === "json") {
    const binary = await harness.exportCodeplugBinary(moduleName, className, codeplug);
    const payload = {
      ...codeplug,
      imageBase64: binary.imageBase64,
      imageSize: binary.size,
    };
    await writeUtf8(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (format === "csv") {
    await writeUtf8(outputPath, `${String(codeplug.csvText || "")}`);
    return;
  }

  const binary = await harness.exportCodeplugBinary(moduleName, className, codeplug);
  await writeBinary(outputPath, binary.image);
}

async function runWriteCommand(harness, { moduleName, className, format, inputPath }) {
  if (format === "json") {
    const parsed = normalizeJsonCodeplug(JSON.parse(await readUtf8(inputPath)));
    if (parsed.imageBase64) {
      const imageBytes = Uint8Array.from(Buffer.from(String(parsed.imageBase64), "base64"));
      await harness.writeCodeplugBinary(moduleName, className, imageBytes);
      return;
    }
    await harness.writeCodeplug(moduleName, className, parsed);
    return;
  }

  if (format === "csv") {
    const parsed = await parseCsvToRows(harness, await readUtf8(inputPath));
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new Error(`CSV parse errors: ${parsed.errors.join("; ")}`);
    }
    await harness.writeCodeplug(moduleName, className, parsed.rows || []);
    return;
  }

  const imageBytes = await fs.readFile(inputPath);
  await harness.writeCodeplugBinary(moduleName, className, imageBytes);
}

async function main() {
  const { positionals, flags } = parseArgs();
  const command = String(positionals[0] || "");
  if (flags.help || !command) {
    console.log(usage());
    return;
  }
  if (!["read", "write"].includes(command)) {
    throw new Error(`Unknown subcommand: ${command}`);
  }

  const portPath = String(flags.port || "");
  const moduleName = String(flags.module || "");
  const className = String(flags.class || flags["class-name"] || "");
  if (!portPath || !moduleName || !className) {
    throw new Error("--port, --module, and --class are required");
  }

  if (flags["serial-timeout-s"]) {
    process.env.WEBCHIRP_SERIAL_TIMEOUT_S = String(flags["serial-timeout-s"]);
  }

  const format = assertFormat(flags.format || "json");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const harness = await createTestRadioHarness({
    repoRoot,
    chirpDir: String(flags["chirp-dir"] || ""),
    portPath,
    serialMode: "node",
  });

  const baudOverride = flags.baud ? Number(flags.baud) : NaN;
  const radioInfo = await harness.getRadioInfo(moduleName, className);
  const baudRate = Number.isFinite(baudOverride) ? baudOverride : Number(radioInfo.baudRate || 9600);

  try {
    const connectResult = await harness.connect({ moduleName, className, baudRate });
    if (!connectResult.connected) {
      throw new Error(`Serial connect failed: ${JSON.stringify(connectResult)}`);
    }

    if (command === "read") {
      const outputText = String(flags.output || "");
      if (!outputText) {
        throw new Error("--output is required for read");
      }
      const outputPath = path.resolve(outputText);
      await runReadCommand(harness, { moduleName, className, format, outputPath });
      console.log(`Read ${moduleName}.${className} codeplug to ${outputPath} as ${format}.`);
      return;
    }

    const inputText = String(flags.input || "");
    if (!inputText) {
      throw new Error("--input is required for write");
    }
    const inputPath = path.resolve(inputText);
    await runWriteCommand(harness, { moduleName, className, format, inputPath });
    console.log(`Wrote ${moduleName}.${className} codeplug from ${inputPath} as ${format}.`);
  } finally {
    try {
      await harness.disconnect();
    } catch (error) {
      console.error(`Disconnect warning: ${error?.message || String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error((error && error.stack) || error?.message || String(error));
  process.exitCode = 1;
});

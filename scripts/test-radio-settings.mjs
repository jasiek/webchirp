import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import {
  createFilesystemPythonSource,
  installFetchChirpSourceGlobal,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

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
    "  npm run test:settings -- --module baofeng_uv17Pro --class UV17Pro",
    "  npm run test:settings -- --module baofeng_uv17Pro --class UV17Pro --image chirp/tests/images/Baofeng_UV-17Pro.img",
    "",
    "Options:",
    "  --module NAME          Required CHIRP driver module short name",
    "  --class NAME           Required CHIRP driver class name",
    "  --image PATH           Optional CHIRP .img file to preload through load_image_base64()",
    "  --chirp-dir PATH       Optional CHIRP source tree root (default: ./chirp or WEBCHIRP_CHIRP_DIR)",
    "  --expect-error         Treat get_radio_settings() failure as the expected outcome",
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

async function readImageBase64(imagePath) {
  const raw = await fs.readFile(imagePath);
  return Buffer.from(raw).toString("base64");
}

async function runPythonJson(pyodide, python, vars = {}) {
  for (const [key, value] of Object.entries(vars)) {
    pyodide.globals.set(key, value);
  }
  const jsonText = await pyodide.runPythonAsync(python);
  return JSON.parse(jsonText);
}

function installNoopSerialGlobals() {
  globalThis.serial_open = async () => ({ connected: false, message: "serial unavailable" });
  globalThis.serial_close = async () => ({ connected: false, message: "serial unavailable" });
  globalThis.serial_write_hex = async () => ({ written: 0, hex: "" });
  globalThis.serial_read_hex = async () => ({ read: 0, hex: "", timedOut: true });
  globalThis.serial_write_bytes = async () => ({ written: 0 });
  globalThis.serial_read_bytes = async () => [];
  globalThis.serial_log = (message) => {
    console.log(`[SERIAL] ${String(message || "")}`);
    return { logged: true };
  };
  globalThis.serial_prepare_clone = async () => ({ prepared: false, settleMs: 0 });
  globalThis.serial_reset_buffers = async () => ({ reset: true });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const moduleName = String(args.module || "");
  const className = String(args.class || args["class-name"] || "");
  if (!moduleName || !className) {
    console.error(usage());
    throw new Error("--module and --class are required");
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pythonSource = await createLocalPythonSource(repoRoot, String(args["chirp-dir"] || ""));
  installFetchChirpSourceGlobal(pythonSource);
  installNoopSerialGlobals();

  const pyodide = await loadPyodide();
  await seedPyodideRuntime(pyodide, pythonSource);

  const imageArg = String(args.image || "");
  const imagePath = imageArg ? path.resolve(repoRoot, imageArg) : "";
  const expectError = Boolean(args["expect-error"]);

  const radioInfo = await runPythonJson(
    pyodide,
    `
ensure_radio_module(_sel_module)
_cls = _import_radio_class(_sel_module, _sel_class)
json.dumps({
  "vendor": str(getattr(_cls, "VENDOR", "")),
  "model": str(getattr(_cls, "MODEL", "")),
  "variant": str(getattr(_cls, "VARIANT", "")),
  "memsize": int(getattr(_cls, "_memsize", 0) or 0),
})
    `,
    { _sel_module: moduleName, _sel_class: className },
  );

  console.log(
    `Running get_radio_settings() repro for ${radioInfo.vendor} ${radioInfo.model} (${moduleName}.${className})`,
  );
  console.log(`Memory size hint: ${radioInfo.memsize || 0} bytes`);

  if (imagePath) {
    const imageBase64 = await readImageBase64(imagePath);
    const loaded = await runPythonJson(pyodide, "json.dumps(load_image_base64(_image_b64))", {
      _image_b64: imageBase64,
    });
    console.log(
      `Loaded image ${path.relative(repoRoot, imagePath)} as ${loaded.vendor} ${loaded.model} (${loaded.module}.${loaded.className})`,
    );
  } else {
    console.log("No image preloaded; using the same best-effort instantiation path as the browser.");
  }

  try {
    const result = await runPythonJson(
      pyodide,
      "json.dumps(get_radio_settings(_sel_module, _sel_class))",
      { _sel_module: moduleName, _sel_class: className },
    );
    const groups = Array.isArray(result?.groups) ? result.groups : [];
    console.log(`get_radio_settings() succeeded: supported=${Boolean(result?.supported)} groups=${groups.length}`);
    if (expectError) {
      throw new Error("Expected get_radio_settings() to fail, but it succeeded");
    }
  } catch (error) {
    const detail = (error && error.stack) || error?.message || String(error);
    console.error(detail);
    if (!expectError) {
      throw error;
    }
    console.log("Observed expected get_radio_settings() failure.");
  }
}

main().catch((error) => {
  const detail = (error && error.stack) || error?.message || String(error);
  console.error(detail);
  process.exitCode = 1;
});

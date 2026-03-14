import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import {
  createFilesystemPythonSource,
  installFetchChirpSourceGlobal,
  listDriverModules,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

function installJsBridgeStubs() {
  globalThis.serial_open = async () => ({ connected: true, message: "stub open" });
  globalThis.serial_close = async () => ({ connected: false, message: "stub close" });
  globalThis.serial_write_hex = async () => ({ written: 0, hex: "" });
  globalThis.serial_read_hex = async () => ({ read: 0, hex: "", timedOut: true });
  globalThis.serial_write_bytes = async () => ({ written: 0 });
  globalThis.serial_read_bytes = async () => [];
  globalThis.serial_log = () => ({ logged: true });
  globalThis.serial_prepare_clone = async () => ({ prepared: true, settleMs: 0 });
  globalThis.serial_reset_buffers = async () => ({ reset: true });
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

function parseFlagValue(flagName, argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === flagName && argv[i + 1]) {
      return String(argv[i + 1]);
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1);
    }
  }
  return "";
}

async function createLocalPythonSource(repoRoot) {
  const chirpInputDir =
    parseFlagValue("--chirp-dir") || process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp");
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

async function runPythonJson(pyodide, python, vars = {}) {
  for (const [key, value] of Object.entries(vars)) {
    pyodide.globals.set(key, value);
  }
  const jsonText = await pyodide.runPythonAsync(python);
  return JSON.parse(jsonText);
}

function normalizeRadioLabel(radio) {
  return [
    radio.vendor || "",
    radio.model || "",
    radio.variant || "",
    `(${radio.module}.${radio.className})`,
  ]
    .filter(Boolean)
    .join(" ");
}

test("all registered radios finish initial runtime loading", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const radioFilter = (
    process.env.WEBCHIRP_RADIO_FILTER ||
    parseFlagValue("--radio")
  ).trim().toLowerCase();

  installJsBridgeStubs();
  const pythonSource = await createLocalPythonSource(repoRoot);
  installFetchChirpSourceGlobal(pythonSource);

  const pyodide = await loadPyodide();
  await seedPyodideRuntime(pyodide, pythonSource);

  const moduleNames = await listDriverModules(pythonSource);
  const radios = await runPythonJson(
    pyodide,
    "json.dumps(list_registered_radios(_radio_catalog_modules))",
    { _radio_catalog_modules: moduleNames },
  );

  radios.sort((a, b) => {
    const av = `${a.vendor}\u0000${a.model}\u0000${a.variant}\u0000${a.module}\u0000${a.className}`;
    const bv = `${b.vendor}\u0000${b.model}\u0000${b.variant}\u0000${b.module}\u0000${b.className}`;
    return av.localeCompare(bv);
  });

  const selectedRadios = radioFilter
    ? radios.filter((radio) =>
        normalizeRadioLabel(radio).toLowerCase().includes(radioFilter),
      )
    : radios;

  assert.ok(selectedRadios.length > 0, `No radios matched filter: ${radioFilter || "<all>"}`);

  for (const radio of selectedRadios) {
    const label = normalizeRadioLabel(radio);
    await t.test(label, async () => {
      const result = await runPythonJson(
        pyodide,
        `
ensure_radio_module(_sel_module)
_meta = get_radio_column_metadata(_sel_module, _sel_class)
_settings = get_radio_settings(_sel_module, _sel_class)
json.dumps({
    "headerCount": len(_meta.get("headers") or []),
    "columnCount": len(_meta.get("columns") or {}),
    "settingsSupported": bool(_settings.get("supported")),
    "settingsGroupCount": len(_settings.get("groups") or []),
})
        `,
        {
          _sel_module: radio.module,
          _sel_class: radio.className,
        },
      );

      assert.ok(result.headerCount > 0, `${label}: expected metadata headers`);
      assert.ok(result.columnCount > 0, `${label}: expected metadata columns`);
      if (result.settingsSupported) {
        assert.ok(result.settingsGroupCount > 0, `${label}: settings claimed support but returned no groups`);
      }
    });
  }
});

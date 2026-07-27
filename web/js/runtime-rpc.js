import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs";
import { createCallQueue } from "./call-queue.mjs";
import { findCatalogRadioForImageMetadata } from "./image-metadata.mjs";
import {
  createBrowserCdnPythonSource,
  DEFAULT_CHIRP_REVISION,
  installFetchChirpSourceGlobal,
  listDriverModules,
  seedPyodideRuntime,
} from "./python-sources.mjs";

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const CHIRP_REVISION = DEFAULT_CHIRP_REVISION;

const pythonSource = createBrowserCdnPythonSource({
  chirpRevision: CHIRP_REVISION,
  runtimeBridgePath: "./python/runtime_bridge.py",
});

let pyodide;
let bootstrapPromise;
let radioCatalogCache = null;
// Which path filled radioCatalogCache: "static" (prebuilt file) or "sources"
// (every driver imported in Pyodide). Reported to callers because the fallback
// is otherwise silent, and it costs a user the whole Pyodide boot before the
// dropdowns can appear.
let radioCatalogSource = "";
let handleSerialRpc = null;
let bootstrapFailed = false;
let debugLog = null;

// All Pyodide-backed methods must run one at a time; see call-queue.mjs.
const enqueueRuntimeCall = createCallQueue();

// Dispatch serial operations to the app's browser-serial bridge handler.
async function serialRpc(op, payload = {}) {
  if (!handleSerialRpc) {
    throw new Error("Serial RPC handler is not configured");
  }
  return handleSerialRpc({ op, payload });
}

function installSerialBridgeGlobals() {
  globalThis.serial_open = (baudRate) => serialRpc("open", { baudRate: Number(baudRate) });
  globalThis.serial_close = () => serialRpc("close", {});
  globalThis.serial_write_hex = (hex) => serialRpc("writeHex", { hex: String(hex || "") });
  globalThis.serial_read_hex = (count, timeoutMs) =>
    serialRpc("readHex", {
      count: Number(count || 1),
      timeoutMs: Number(timeoutMs || 1200),
    });
  globalThis.serial_write_bytes = (bytes) =>
    serialRpc("writeBytes", {
      bytes: Array.from(bytes || []),
    });
  globalThis.serial_read_bytes = (count, timeoutMs) =>
    serialRpc("readBytes", {
      count: Number(count || 1),
      timeoutMs: Number(timeoutMs || 1200),
    });
  globalThis.serial_log = (message) =>
    serialRpc("log", {
      message: String(message || ""),
    });
  globalThis.serial_progress = (cur, max, msg) =>
    serialRpc("progress", {
      cur: Number(cur),
      max: Number(max),
      msg: String(msg || ""),
    });
  globalThis.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
    serialRpc("prepareClone", {
      wantsDtr: Boolean(wantsDtr),
      wantsRts: Boolean(wantsRts),
      settleMs: Number(settleMs || 350),
    });
  globalThis.serial_reset_buffers = () => serialRpc("resetBuffers", {});
  installFetchChirpSourceGlobal(pythonSource);
}

// Trigger runtime import of the selected driver; Python import hook fetches missing files.
async function ensureSelectedRadioModules(moduleShortName) {
  await ensurePyodide();
  pyodide.globals.set("_sel_module_short", moduleShortName);
  await pyodide.runPythonAsync("ensure_radio_module(_sel_module_short)");
}

function sortRadioCatalog(radios) {
  return radios.slice().sort((a, b) => {
    const av = `${a.vendor} ${a.model}`;
    const bv = `${b.vendor} ${b.model}`;
    return av.localeCompare(bv);
  });
}

// Prefer a prebuilt static catalog so dropdowns can populate without booting
// Pyodide or importing every driver. Returns null if it is missing/unusable
// or was generated from a different CHIRP revision than this runtime, so
// callers fall back to live enumeration.
async function loadRadioCatalogFromStatic() {
  try {
    const url = new URL("../radio-catalog.json", import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (data?.chirpRevision !== CHIRP_REVISION) {
      if (debugLog) {
        debugLog(
          `CATALOG SKIP static catalog is for chirp ${data?.chirpRevision || "unknown"}, `
          + `runtime is pinned to ${CHIRP_REVISION}; falling back to live enumeration`,
        );
      }
      return null;
    }
    const radios = data?.radios;
    if (!Array.isArray(radios) || radios.length === 0) {
      return null;
    }
    return radios;
  } catch {
    return null;
  }
}

// Build the radio catalog by importing every driver in Pyodide (slow first run).
async function loadRadioCatalogFromSources() {
  const modules = await listDriverModules(pythonSource);

  await ensurePyodide();
  pyodide.globals.set("_radio_catalog_modules", modules);
  const radiosJson = await pyodide.runPythonAsync(
    "json.dumps(list_registered_radios(_radio_catalog_modules))",
  );
  const allRadios = JSON.parse(radiosJson);

  allRadios.sort((a, b) => {
    const av = `${a.vendor}\u0000${a.model}`;
    const bv = `${b.vendor}\u0000${b.model}`;
    return av.localeCompare(bv);
  });

  radioCatalogCache = allRadios;
  radioCatalogSource = "sources";
  return radioCatalogCache;
}

// Resolve the radio catalog, preferring the prebuilt static file so the
// dropdowns appear without waiting on Pyodide + per-driver imports.
async function loadRadioCatalog() {
  if (radioCatalogCache) {
    return radioCatalogCache;
  }
  const fromStatic = await loadRadioCatalogFromStatic();
  if (fromStatic) {
    radioCatalogCache = sortRadioCatalog(fromStatic);
    radioCatalogSource = "static";
    return radioCatalogCache;
  }
  return loadRadioCatalogFromSources();
}

// Lazily initialize Pyodide, preload core CHIRP files, and load runtime bridge.
async function ensurePyodide() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      installSerialBridgeGlobals();
      pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      await seedPyodideRuntime(pyodide, pythonSource);
    })();
  }

  return bootstrapPromise;
}

async function requirePyodide() {
  await ensurePyodide();
}

function setSelectedRadioGlobals(payload = {}) {
  pyodide.globals.set("_sel_module", payload.module || "");
  pyodide.globals.set("_sel_class", payload.className || "");
}

function setRowsJsonGlobal(rows) {
  pyodide.globals.set("_rows_json", JSON.stringify(rows));
}

function setSettingsJsonGlobal(groups) {
  pyodide.globals.set("_settings_json", JSON.stringify(groups));
}

async function runPythonJson(pythonCode) {
  const resultJson = await pyodide.runPythonAsync(pythonCode);
  return JSON.parse(resultJson);
}

async function handleGetRuntimeInfo() {
  return pythonSource.getRuntimeInfo();
}

async function handleListRadios() {
  const radios = await loadRadioCatalog();
  return { radios, source: radioCatalogSource };
}

async function handleParseCsv(payload = {}) {
  await requirePyodide();
  pyodide.globals.set("_csv_input", payload.csvText);
  return runPythonJson("json.dumps(parse_csv(_csv_input))");
}

async function handleNormalizeRows(payload = {}) {
  await requirePyodide();
  setRowsJsonGlobal(payload.rows);
  setSelectedRadioGlobals(payload);
  return pyodide.runPythonAsync(
    "normalize_rows(json.loads(_rows_json), _sel_module, _sel_class)",
  );
}

async function handleValidateRowsForUpload(payload = {}) {
  await requirePyodide();
  setRowsJsonGlobal(payload.rows);
  setSelectedRadioGlobals(payload);
  return runPythonJson(
    "json.dumps(validate_rows_for_upload(json.loads(_rows_json), _sel_module, _sel_class))",
  );
}

async function handleExportImage(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  setRowsJsonGlobal(payload.rows);
  setSettingsJsonGlobal(payload.settings || []);
  setSelectedRadioGlobals(payload);
  return runPythonJson(
    "json.dumps(export_image_base64(_sel_module, _sel_class, json.loads(_rows_json), json.loads(_settings_json)))",
  );
}

async function handleLoadImage(payload = {}) {
  await requirePyodide();
  pyodide.globals.set("_image_b64", payload.imageBase64 || "");
  // CHIRP image detection only searches drivers that are already imported, so
  // read the metadata trailer first and import the matching driver module.
  const metadata = await runPythonJson(
    "json.dumps(read_image_metadata_base64(_image_b64))",
  );
  if (metadata?.hasMetadata) {
    const radios = await loadRadioCatalog();
    const match = findCatalogRadioForImageMetadata(radios, metadata);
    if (match) {
      await ensureSelectedRadioModules(match.module);
    } else if (debugLog) {
      debugLog(
        `IMAGE METADATA no catalog match for ${metadata.vendor} ${metadata.model} `
        + `(class ${metadata.rclass || "unknown"})`,
      );
    }
  }
  return runPythonJson("json.dumps(load_image_base64(_image_b64))");
}

async function handleSerialConnect(payload = {}) {
  await requirePyodide();
  pyodide.globals.set("_baud", payload.baudRate || 9600);
  return runPythonJson("json.dumps(await webserial_connect(_baud))");
}

async function handleSerialDisconnect() {
  await requirePyodide();
  return runPythonJson("json.dumps(await webserial_disconnect())");
}

async function handleSerialTxRx(payload = {}) {
  await requirePyodide();
  pyodide.globals.set("_tx_hex", payload.txHex || "");
  pyodide.globals.set("_rx_bytes", payload.rxBytes || 32);
  pyodide.globals.set("_timeout_ms", payload.timeoutMs || 1200);
  return runPythonJson(
    "json.dumps(await webserial_txrx_hex(_tx_hex, _rx_bytes, _timeout_ms))",
  );
}

async function handleDownloadSelectedRadio(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  setSelectedRadioGlobals(payload);
  return runPythonJson(
    "json.dumps(await download_selected_radio(_sel_module, _sel_class))",
  );
}

async function handleUploadSelectedRadio(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  setSelectedRadioGlobals(payload);
  setRowsJsonGlobal(payload.rows || []);
  setSettingsJsonGlobal(payload.settings || []);
  return runPythonJson(
    "json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json), json.loads(_settings_json)))",
  );
}

async function handleGetRadioMetadata(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  setSelectedRadioGlobals(payload);
  return runPythonJson(
    "json.dumps(get_radio_column_metadata(_sel_module, _sel_class))",
  );
}

async function handleGetRadioSettings(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  setSelectedRadioGlobals(payload);
  return runPythonJson(
    "json.dumps(get_radio_settings(_sel_module, _sel_class))",
  );
}

async function handleValidateRadioSettings(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  setSelectedRadioGlobals(payload);
  setSettingsJsonGlobal(payload.settings || []);
  return runPythonJson(
    "json.dumps(validate_radio_settings(_sel_module, _sel_class, json.loads(_settings_json)))",
  );
}

const RUNTIME_METHODS = Object.freeze({
  getRuntimeInfo: handleGetRuntimeInfo,
  listRadios: handleListRadios,
  parseCsv: handleParseCsv,
  normalizeRows: handleNormalizeRows,
  validateRowsForUpload: handleValidateRowsForUpload,
  exportImage: handleExportImage,
  loadImage: handleLoadImage,
  serialConnect: handleSerialConnect,
  serialDisconnect: handleSerialDisconnect,
  serialTxRx: handleSerialTxRx,
  downloadSelectedRadio: handleDownloadSelectedRadio,
  uploadSelectedRadio: handleUploadSelectedRadio,
  getRadioMetadata: handleGetRadioMetadata,
  getRadioSettings: handleGetRadioSettings,
  validateRadioSettings: handleValidateRadioSettings,
});

// getRuntimeInfo never enters Pyodide, and error reporting relies on it even
// while a queued call is stuck; every other method must wait its turn.
const UNQUEUED_METHODS = new Set(["getRuntimeInfo"]);

export function createRuntimeRpcClient({
  handleSerialRpc: nextHandleSerialRpc,
  logDebug,
  onRuntimeCrash,
}) {
  handleSerialRpc = nextHandleSerialRpc;
  debugLog = logDebug || null;

  function wrapRuntimeMethod(name, handler) {
    return async function invokeRuntimeMethod(payload = {}) {
      try {
        if (UNQUEUED_METHODS.has(name)) {
          return await handler(payload);
        }
        return await enqueueRuntimeCall(() => handler(payload));
      } catch (error) {
        const detailedError =
          (typeof error?.stack === "string" && error.stack) ||
          error?.message ||
          String(error);

        if (!bootstrapFailed && !pyodide && onRuntimeCrash) {
          bootstrapFailed = true;
          onRuntimeCrash(detailedError);
        }
        if (logDebug) {
          logDebug(`RUNTIME ERROR ${detailedError}`);
        }
        throw new Error(detailedError);
      }
    };
  }

  const runtimeApi = {};
  for (const [name, handler] of Object.entries(RUNTIME_METHODS)) {
    runtimeApi[name] = wrapRuntimeMethod(name, handler);
  }

  return Object.freeze(runtimeApi);
}

import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs";
import {
  createBrowserCdnPythonSource,
  installFetchChirpSourceGlobal,
  listDriverModules,
  seedPyodideRuntime,
} from "./python-sources.mjs";

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const CHIRP_REVISION = "1467519e792e8ebcc9a33dc40df0b2e273ce9a53";

const pythonSource = createBrowserCdnPythonSource({
  chirpRevision: CHIRP_REVISION,
  runtimeBridgePath: "./python/runtime_bridge.py",
});

let pyodide;
let bootstrapPromise;
let radioCatalogCache = null;
let handleSerialRpc = null;
let bootstrapFailed = false;

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

// Build and cache the radio catalog from CHIRP's runtime registration directory.
async function loadRadioCatalogFromSources() {
  if (radioCatalogCache) {
    return radioCatalogCache;
  }
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
  return radioCatalogCache;
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

async function runPythonJson(pythonCode) {
  const resultJson = await pyodide.runPythonAsync(pythonCode);
  return JSON.parse(resultJson);
}

async function handleGetRuntimeInfo() {
  return pythonSource.getRuntimeInfo();
}

async function handleListRadios() {
  const radios = await loadRadioCatalogFromSources();
  return { radios };
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
  setSelectedRadioGlobals(payload);
  return runPythonJson(
    "json.dumps(export_image_base64(_sel_module, _sel_class, json.loads(_rows_json)))",
  );
}

async function handleLoadImage(payload = {}) {
  await requirePyodide();
  pyodide.globals.set("_image_b64", payload.imageBase64 || "");
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
  return runPythonJson(
    "json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json)))",
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

const CALL_HANDLERS = Object.freeze({
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
});

// Dispatch a runtime RPC method to the appropriate named handler.
async function handleCall(method, payload) {
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    throw new Error(`Unknown method: ${method}`);
  }
  return handler(payload || {});
}

export function createRuntimeRpcClient({
  handleSerialRpc: nextHandleSerialRpc,
  logDebug,
  onRuntimeCrash,
}) {
  handleSerialRpc = nextHandleSerialRpc;

  async function callWorker(method, payload = {}) {
    try {
      return await handleCall(method, payload);
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
  }

  return {
    callWorker,
  };
}

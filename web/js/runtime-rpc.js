import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs";
import { createCallQueue } from "./call-queue.mjs";
import {
  PORT_SELECTION_CANCELLED_MESSAGE,
  createPortSelectionCancelledError,
  isPortSelectionCancelled,
} from "./serial-errors.js";
import {
  findCatalogRadioForImageMetadata,
  loadImageWithDriverFallback,
} from "./image-metadata.mjs";
import {
  createBootstrapCrashReporter,
  markBootstrapFailure,
} from "./runtime-bootstrap.mjs";
import { createSelectedDriverRuntime } from "./selected-driver-runtime.mjs";
import { rpcDispatcherFor } from "./rpc-dispatch.mjs";
import {
  CHIRP_BUNDLE_DIR,
  createBrowserPythonSource,
  DEFAULT_CHIRP_REVISION,
  driverSetFromSearch,
  listDriverModules,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
  seedPyodideRuntime,
} from "./python-sources.mjs";

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const CHIRP_REVISION = DEFAULT_CHIRP_REVISION;
const DRIVER_SET = driverSetFromSearch(globalThis.location?.search);

// Where the browser fetches each runtime Python file from, keyed the way
// RUNTIME_PYTHON_FILES (web/js/python-sources.mjs) names them. The literals
// live in this .js file because scripts/build-dist.mjs rewrites references to
// their hashed names in .js files and copies .mjs files verbatim; the provider
// refuses to construct if a listed file has no URL here, and
// tests/build/build-dist.mjs checks the pairing statically.
const RUNTIME_PYTHON_URLS = Object.freeze({
  "runtime_bridge.py": "./python/runtime_bridge.py",
  "webchirp_bridge/__init__.py": "./python/webchirp_bridge/__init__.py",
  "webchirp_bridge/channel_extra.py": "./python/webchirp_bridge/channel_extra.py",
  "webchirp_bridge/channel_rows.py": "./python/webchirp_bridge/channel_rows.py",
  "webchirp_bridge/chirp_loader.py": "./python/webchirp_bridge/chirp_loader.py",
  "webchirp_bridge/clone.py": "./python/webchirp_bridge/clone.py",
  "webchirp_bridge/column_metadata.py": "./python/webchirp_bridge/column_metadata.py",
  "webchirp_bridge/driver_cache.py": "./python/webchirp_bridge/driver_cache.py",
  "webchirp_bridge/images.py": "./python/webchirp_bridge/images.py",
  "webchirp_bridge/jsbridge.py": "./python/webchirp_bridge/jsbridge.py",
  "webchirp_bridge/power_levels.py": "./python/webchirp_bridge/power_levels.py",
  "webchirp_bridge/radio_memories.py": "./python/webchirp_bridge/radio_memories.py",
  "webchirp_bridge/radio_settings.py": "./python/webchirp_bridge/radio_settings.py",
  "webchirp_bridge/row_validation.py": "./python/webchirp_bridge/row_validation.py",
  "webchirp_bridge/rpc.py": "./python/webchirp_bridge/rpc.py",
  "webchirp_bridge/runtime_errors.py": "./python/webchirp_bridge/runtime_errors.py",
  "webchirp_bridge/serial_pipe.py": "./python/webchirp_bridge/serial_pipe.py",
  "extra_drivers/quansheng/f4hwn_v4_3.py": "./python/extra_drivers/quansheng/f4hwn_v4_3.py",
  "extra_drivers/quansheng/f4hwn_v5_9_0.py": "./python/extra_drivers/quansheng/f4hwn_v5_9_0.py",
  "extra_drivers/quansheng/f4hwn_v6.py": "./python/extra_drivers/quansheng/f4hwn_v6.py",
});

// The CHIRP archive and its manifest live beside the app under web/chirp/
// (scripts/build-chirp-bundle.mjs), named by the pin rather than hashed, so
// the directory is resolved from this module's own URL the way the static
// catalog is below and needs no entry in the URL table above.
const pythonSource = createBrowserPythonSource({
  chirpRevision: CHIRP_REVISION,
  driverSet: DRIVER_SET,
  runtimeFileUrls: RUNTIME_PYTHON_URLS,
  chirpBundleBaseUrl: new URL(`../${CHIRP_BUNDLE_DIR}/`, import.meta.url),
});

let pyodide;
let radioCatalogCache = null;
// Which path filled radioCatalogCache: "static" (prebuilt file) or "sources"
// (every driver imported in Pyodide). Reported to callers because the fallback
// is otherwise silent, and it costs a user the whole Pyodide boot before the
// dropdowns can appear.
let radioCatalogSource = "";
let allDriverModulesPromise = null;
let handleSerialRpc = null;
let debugLog = null;
let beginProgress = null;

// One debug line per driver would bury every other diagnostic in the panel, and
// none per driver leaves a stalled sweep looking identical to a working one.
// Narrate every Nth module instead; the progress strip carries the rest.
const DRIVER_LOG_INTERVAL = 25;

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
  globalThis.serial_in_waiting = (waitMs) =>
    serialRpc("inWaiting", {
      waitMs: Number(waitMs || 0),
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
  globalThis.serial_prepare_clone = (wantsDtr, wantsRts, settleMs, baudRate) =>
    serialRpc("prepareClone", {
      wantsDtr: Boolean(wantsDtr),
      wantsRts: Boolean(wantsRts),
      settleMs: Number(settleMs || 350),
      // 0 means "the driver declares no rate"; the bridge then keeps whatever
      // the port was opened with.
      baudRate: Number(baudRate || 0),
    });
  // Mid-clone control-line changes from CHIRP drivers. Each line is passed
  // through as null when the pipe has no opinion on it yet, so setting one
  // line never implicitly clears the other.
  globalThis.serial_set_signals = (dtr, rts) =>
    serialRpc("setSignals", {
      dataTerminalReady: dtr === null || dtr === undefined ? null : Boolean(dtr),
      requestToSend: rts === null || rts === undefined ? null : Boolean(rts),
    });
  // Mid-clone port reconfiguration (baud rate and framing). Only the fields
  // the pipe actually holds a value for are sent; the rest keep what the port
  // was opened with.
  globalThis.serial_reconfigure = (baudRate, dataBits, stopBits, parity) => {
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
    return serialRpc("reconfigure", { options });
  };
  globalThis.serial_reset_buffers = () => serialRpc("resetBuffers", {});
}

// Import the selected driver from the mounted CHIRP tree before any radio-bound call.
async function ensureSelectedRadioModules(moduleShortName) {
  if (!moduleShortName) {
    await ensurePyodide();
    return;
  }
  pyodide = await runtimeBootstrap.select(moduleShortName);
  await rpc("ensure_radio_module", { module_short_name: moduleShortName });
}

// Import every driver module once per session. Only the metadata-less image
// path needs this: it is the one case where nothing identifies the driver up
// front, so detection has to try them all. Importing ~190 modules takes seconds
// of main-thread time, so this is deliberately not done eagerly.
async function ensureAllDriverModules() {
  if (DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    throw new Error("Select the matching firmware release before opening an image.");
  }
  if (!allDriverModulesPromise) {
    allDriverModulesPromise = (async () => {
      const modules = await listDriverModules(pythonSource);
      await ensurePyodide();

      // Every driver module is executed on the main thread, so this is by far
      // the longest operation the app runs. Report it: an unannounced multi-
      // second freeze is indistinguishable from a hang.
      const progress = beginProgress
        ? beginProgress("Identifying radio: loading CHIRP drivers", modules.length)
        : null;
      if (debugLog) {
        debugLog(
          `DRIVERS image identifies no driver; importing all ${modules.length} `
          + "driver modules so match_model can run",
        );
      }

      const reportProgress = (done, total, moduleShort) => {
        progress?.update(done);
        if (debugLog && (done % DRIVER_LOG_INTERVAL === 0 || done === total)) {
          debugLog(`DRIVERS ${done}/${total} imported (latest ${moduleShort})`);
        }
      };

      try {
        const result = await rpc("import_all_driver_modules", {
          module_short_names: modules,
          callback: reportProgress,
        });
        if (debugLog) {
          const failed = Object.entries(result.failed || {});
          debugLog(
            `DRIVERS imported ${result.imported}/${modules.length} modules, `
            + `${result.registered} radio classes registered`,
          );
          for (const [moduleName, error] of failed) {
            debugLog(`DRIVERS SKIP ${moduleName}: ${error}`);
          }
        }
        return result;
      } finally {
        // The strip must come down on the failure path too, or a failed sweep
        // leaves a frozen bar on screen for the rest of the session.
        progress?.end();
      }
    })().catch((error) => {
      // Let a later load retry rather than caching the failure for the session.
      allDriverModulesPromise = null;
      throw error;
    });
  }
  return allDriverModulesPromise;
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
    const catalogFile = DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET
      ? "../radio-catalog-quansheng-unofficial.json"
      : "../radio-catalog.json";
    const url = new URL(catalogFile, import.meta.url);
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
    if (data?.driverSet !== DRIVER_SET) {
      debugLog?.(
        `CATALOG SKIP static catalog is for drivers ${data?.driverSet || "unknown"}, `
        + `runtime requested ${DRIVER_SET}; falling back to live enumeration`,
      );
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
  const allRadios = await rpc("list_registered_radios", { module_short_names: modules });

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
  if (DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    throw new Error("The unofficial driver catalog is unavailable. Reload the page to retry.");
  }
  return loadRadioCatalogFromSources();
}

// Lazily initialize Pyodide, mount the CHIRP archive, and load the runtime bridge.
// The handle is returned rather than assigned mid-sequence so that nothing can
// observe a runtime that loaded but failed to seed.
const runtimeBootstrap = createSelectedDriverRuntime({
  isolated: DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET,
  async loadRuntime() {
    installSerialBridgeGlobals();
    const loaded = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    await seedPyodideRuntime(loaded, pythonSource);
    return loaded;
  },
});

async function ensurePyodide() {
  pyodide = await runtimeBootstrap.ensure();
  return pyodide;
}

async function requirePyodide() {
  await ensurePyodide();
}

// Call one Python runtime method on the current interpreter. Resolved per
// call rather than held, because ensureSelectedRadioModules() can swap the
// interpreter under the isolated driver set; the dispatcher is memoized per
// interpreter in web/js/rpc-dispatch.mjs.
function rpc(name, params = {}) {
  return rpcDispatcherFor(pyodide).call(name, params);
}

// The selected driver as every radio-bound method names it, under the Python
// parameter names, so the UI's {module, className} payload maps in one place.
function selectedRadioParams(payload = {}) {
  return {
    module_name: payload.module || "",
    class_name: payload.className || "",
  };
}

async function handleGetRuntimeInfo() {
  return pythonSource.getRuntimeInfo();
}

async function handleListRadios() {
  const radios = await loadRadioCatalog();
  return { radios, source: radioCatalogSource };
}

// The schema the grid runs on before a radio is selected: CHIRP's generic CSV
// driver reporting its own RadioFeatures, headers and columns alike. See
// get_default_schema (web/python/webchirp_bridge/column_metadata.py).
async function handleGetDefaultSchema() {
  await requirePyodide();
  return rpc("get_default_schema");
}

async function handleParseCsv(payload = {}) {
  await requirePyodide();
  return rpc("parse_csv", { csv_text: String(payload.csvText ?? "") });
}

async function handleNormalizeRows(payload = {}) {
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("normalize_rows", {
    rows: payload.rows || [],
    ...selectedRadioParams(payload),
  });
}

async function handleValidateRowsForUpload(payload = {}) {
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("validate_rows_for_upload", {
    rows: payload.rows || [],
    ...selectedRadioParams(payload),
  });
}

async function handleExportImage(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("export_image_base64", {
    ...selectedRadioParams(payload),
    rows: payload.rows || [],
    settings_groups: payload.settings || [],
  });
}

async function handleLoadImage(payload = {}) {
  if (DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    const selected = (await loadRadioCatalog()).find((radio) =>
      radio.module === payload.module && radio.className === payload.className);
    if (!selected) {
      throw new Error("Select the matching firmware release before opening an image.");
    }
    await ensureSelectedRadioModules(selected.module);
    // Native CHIRP metadata detection now sees only the selected release.
    return rpc("load_image_base64", { image_b64: payload.imageBase64 || "" });
  }
  await requirePyodide();
  const image_b64 = payload.imageBase64 || "";
  // CHIRP image detection only searches drivers that are already imported, so
  // read the metadata trailer first and import the matching driver module.
  const metadata = await rpc("read_image_metadata_base64", { image_b64 });
  let resolvedDriver = null;
  if (metadata?.hasMetadata) {
    const radios = await loadRadioCatalog();
    const match = findCatalogRadioForImageMetadata(radios, metadata);
    if (match && match.isLiveRadio) {
      // Image metadata is matched on the stored rclass name first, which can
      // land on a live-mode driver that shares a class name with the clone-mode
      // one (Kenwood TS-480). A live radio never owns a clone image, so treat
      // this as unresolved and let match_model pick the real driver.
      if (debugLog) {
        debugLog(
          `IMAGE METADATA ignoring live-mode driver ${match.module}.${match.className} `
          + `for clone image ${metadata.vendor} ${metadata.model}`,
        );
      }
    } else if (match) {
      await ensureSelectedRadioModules(match.module);
      resolvedDriver = match;
    } else if (debugLog) {
      debugLog(
        `IMAGE METADATA no catalog match for ${metadata.vendor} ${metadata.model} `
        + `(class ${metadata.rclass || "unknown"})`,
      );
    }
  }
  if (!resolvedDriver && debugLog) {
    // Nothing identified the driver: either the image predates the metadata
    // trailer, or its metadata names a model the catalog does not list. Either
    // way the only route left is match_model against every driver, which can
    // only match drivers that have been imported.
    debugLog(
      `IMAGE ${metadata?.hasMetadata ? "metadata unmatched" : "metadata absent"}; `
      + "importing all drivers for detection",
    );
  }
  return loadImageWithDriverFallback({
    resolvedDriver,
    loadImage: () => rpc("load_image_base64", { image_b64 }),
    importAllDrivers: () => ensureAllDriverModules(),
    log: debugLog,
  });
}

async function handleSerialConnect(payload = {}) {
  await requirePyodide();
  return rpc("webserial_connect", { baudrate: payload.baudRate || 9600 });
}

async function handleSerialDisconnect() {
  await requirePyodide();
  return rpc("webserial_disconnect");
}

async function handleSerialTxRx(payload = {}) {
  await requirePyodide();
  return rpc("webserial_txrx_hex", {
    tx_hex: payload.txHex || "",
    rx_bytes: payload.rxBytes || 32,
    timeout_ms: payload.timeoutMs || 1200,
  });
}

async function handleDownloadSelectedRadio(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("download_selected_radio", selectedRadioParams(payload));
}

async function handleUploadSelectedRadio(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("upload_selected_radio", {
    ...selectedRadioParams(payload),
    rows: payload.rows || [],
    settings_groups: payload.settings || [],
  });
}

async function handleGetRadioMetadata(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("get_radio_column_metadata", selectedRadioParams(payload));
}

// The driver's own per-channel extra settings for one memory slot, typed the
// way the radio-wide settings are, so the extras modal can render real controls
// instead of guessing from the bare values a row carries.
async function handleGetChannelExtra(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("get_channel_extra", {
    ...selectedRadioParams(payload),
    location: String(payload.location ?? ""),
  });
}

async function handleGetRadioSettings(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("get_radio_settings", selectedRadioParams(payload));
}

async function handleValidateRadioSettings(payload = {}) {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  return rpc("validate_radio_settings", {
    ...selectedRadioParams(payload),
    settings_groups: payload.settings || [],
  });
}

// The runtime API the app calls, by the names web/app.js and the UI modules
// use. Most map onto one RPC method; listRadios, loadImage and getRuntimeInfo
// compose several or none. The Python-facing names are in RPC_METHODS
// (web/js/rpc-dispatch.mjs).
export const RUNTIME_METHODS = Object.freeze({
  getRuntimeInfo: handleGetRuntimeInfo,
  listRadios: handleListRadios,
  getDefaultSchema: handleGetDefaultSchema,
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
  getChannelExtra: handleGetChannelExtra,
  getRadioSettings: handleGetRadioSettings,
  validateRadioSettings: handleValidateRadioSettings,
});

// getRuntimeInfo never enters Pyodide, and error reporting relies on it even
// while a queued call is stuck; every other method must wait its turn.
const UNQUEUED_METHODS = new Set(["getRuntimeInfo"]);

export function createRuntimeRpcClient({
  handleSerialRpc: nextHandleSerialRpc,
  logDebug,
  onProgress,
  onRuntimeCrash,
}) {
  handleSerialRpc = nextHandleSerialRpc;
  debugLog = logDebug || null;
  beginProgress = onProgress || null;

  // Null when the host wants no crash reporting, so the failure then falls
  // through to the ordinary action funnel rather than going unreported.
  const reportBootstrapCrash = onRuntimeCrash
    ? createBootstrapCrashReporter(onRuntimeCrash)
    : null;

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

        // A dismissed port chooser reaches here as a Python traceback like any
        // other failure, but it is not one: the user closed a dialog. Report it
        // as one quiet line and hand the caller the sentence rather than the
        // traceback, so the UI can say what happened instead of showing a stack
        // nobody can act on. The name is restored because `new Error` below
        // would otherwise drop it on the way out of the runtime.
        if (isPortSelectionCancelled(error)) {
          if (logDebug) {
            logDebug(`RUNTIME ${PORT_SELECTION_CANCELLED_MESSAGE}`);
          }
          throw createPortSelectionCancelledError();
        }

        // Only the bootstrap itself is a runtime crash. This used to test the
        // unset pyodide handle, which stood in for "bootstrap failed" but in
        // fact meant "not assigned yet" -- so a failed driver-index fetch
        // (plain HTTP, no Pyodide involved) was reported as a crash, and a
        // failure seeding the bridge was not reported at all.
        const reportedAsCrash = reportBootstrapCrash
          ? reportBootstrapCrash(error, detailedError)
          : false;

        // The crash line already carries the same detail, so a second RUNTIME
        // line would only print the traceback twice.
        if (logDebug && !reportedAsCrash) {
          logDebug(`RUNTIME ERROR ${detailedError}`, { isError: true });
        }

        // Carry the classification onto the error leaving the runtime. Without
        // it the action-level funnel sees an ordinary failure and files a
        // second Sentry event for the crash just reported above.
        const outgoing = new Error(detailedError);
        throw reportedAsCrash ? markBootstrapFailure(outgoing) : outgoing;
      }
    };
  }

  const runtimeApi = {};
  for (const [name, handler] of Object.entries(RUNTIME_METHODS)) {
    runtimeApi[name] = wrapRuntimeMethod(name, handler);
  }

  return Object.freeze(runtimeApi);
}

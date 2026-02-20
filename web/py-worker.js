/* global importScripts, loadPyodide */

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js";
const CHIRP_REVISION = "1467519e792e8ebcc9a33dc40df0b2e273ce9a53";
const CHIRP_CDN_BASE = `https://cdn.jsdelivr.net/gh/kk7ds/chirp@${CHIRP_REVISION}`;
const CHIRP_FILE_INDEX_URL =
  `https://data.jsdelivr.com/v1/package/gh/kk7ds/chirp@${CHIRP_REVISION}/flat`;

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

let pyodide;
let bootstrapPromise;
let radioCatalogCache = null;
let rpcId = 0;
const rpcPending = new Map();

// Send a serial operation request to the main thread and await its result.
function serialRpc(op, payload = {}) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    self.postMessage({ type: "serial-rpc", id, op, payload });
  });
}

// Create nested directories in the Pyodide virtual filesystem.
function mkdirp(path) {
  const parts = path.split("/").filter(Boolean);
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

// Fetch local app assets (used for project-owned runtime files).
async function fetchLocalText(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status}`);
  }
  return await res.text();
}

// Fetch CHIRP source content from jsDelivr (or pass through full URLs).
async function fetchText(path) {
  const url = path.startsWith("http") ? path : `${CHIRP_CDN_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return await res.text();
}

function getChirpRevision() {
  return CHIRP_REVISION;
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
  const indexRes = await fetch(CHIRP_FILE_INDEX_URL);
  if (!indexRes.ok) {
    throw new Error(`Failed to fetch ${CHIRP_FILE_INDEX_URL}: ${indexRes.status}`);
  }
  const indexJson = await indexRes.json();
  const modules = Array.from(
    new Set(
      (indexJson.files || [])
        .map((f) => f.name || "")
        .filter((name) => /^\/chirp\/drivers\/[A-Za-z0-9_]+\.py$/.test(name))
        .map((name) => name.split("/").pop().replace(/\.py$/, ""))
        .filter((name) => !name.startsWith("__")),
    ),
  );

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
      importScripts(PYODIDE_URL);
      pyodide = await loadPyodide();

      mkdirp("/webchirp_runtime/chirp/drivers");

      await Promise.all(
        CHIRP_FILES.map(async ([src, dest]) => {
          const text = await fetchText(src);
          pyodide.FS.writeFile(`/webchirp_runtime/${dest}`, text, {
            encoding: "utf8",
          });
        }),
      );
      const runtimePython = await fetchLocalText("/web/python/runtime_bridge.py");
      await pyodide.runPythonAsync(runtimePython);
    })();
  }

  return bootstrapPromise;
}

// Dispatch a worker RPC method to the appropriate Pyodide/runtime operation.
async function handleCall(method, payload) {
  if (method === "getRuntimeInfo") {
    return {
      chirpRevision: getChirpRevision(),
      chirpCdnBase: CHIRP_CDN_BASE,
    };
  }

  if (method === "listRadios") {
    const radios = await loadRadioCatalogFromSources();
    return { radios };
  }

  await ensurePyodide();

  if (method === "parseCsv") {
    pyodide.globals.set("_csv_input", payload.csvText);
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(parse_csv(_csv_input))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "normalizeRows") {
    pyodide.globals.set("_rows_json", JSON.stringify(payload.rows));
    const result = await pyodide.runPythonAsync(
      "normalize_rows(json.loads(_rows_json))",
    );
    return result;
  }

  if (method === "serialConnect") {
    pyodide.globals.set("_baud", payload.baudRate || 9600);
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await webserial_connect(_baud))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "serialDisconnect") {
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await webserial_disconnect())",
    );
    return JSON.parse(resultJson);
  }

  if (method === "serialTxRx") {
    pyodide.globals.set("_tx_hex", payload.txHex || "");
    pyodide.globals.set("_rx_bytes", payload.rxBytes || 32);
    pyodide.globals.set("_timeout_ms", payload.timeoutMs || 1200);
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await webserial_txrx_hex(_tx_hex, _rx_bytes, _timeout_ms))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "downloadSelectedRadio") {
    await ensureSelectedRadioModules(payload.module || "");
    pyodide.globals.set("_sel_module", payload.module || "");
    pyodide.globals.set("_sel_class", payload.className || "");
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await download_selected_radio(_sel_module, _sel_class))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "uploadSelectedRadio") {
    await ensureSelectedRadioModules(payload.module || "");
    pyodide.globals.set("_sel_module", payload.module || "");
    pyodide.globals.set("_sel_class", payload.className || "");
    pyodide.globals.set("_rows_json", JSON.stringify(payload.rows || []));
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await upload_selected_radio(_sel_module, _sel_class, json.loads(_rows_json)))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "getRadioMetadata") {
    await ensureSelectedRadioModules(payload.module || "");
    pyodide.globals.set("_sel_module", payload.module || "");
    pyodide.globals.set("_sel_class", payload.className || "");
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(get_radio_column_metadata(_sel_module, _sel_class))",
    );
    return JSON.parse(resultJson);
  }

  throw new Error(`Unknown method: ${method}`);
}

// Worker message loop: handles serial RPC responses and API method calls.
self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === "serial-rpc-result") {
    const pending = rpcPending.get(msg.id);
    if (!pending) {
      return;
    }
    rpcPending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.data);
    } else {
      pending.reject(new Error(msg.error || "serial rpc failed"));
    }
    return;
  }

  const { id, method, payload } = msg;
  if (!id || !method) {
    return;
  }

  try {
    const data = await handleCall(method, payload || {});
    self.postMessage({ id, ok: true, data });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error?.message || String(error),
    });
  }
};

// Expose serial open callback to Python runtime via js module bridge.
self.serial_open = (baudRate) => serialRpc("open", { baudRate: Number(baudRate) });
// Expose serial close callback to Python runtime via js module bridge.
self.serial_close = () => serialRpc("close", {});
// Expose hex write callback to Python runtime via js module bridge.
self.serial_write_hex = (hex) => serialRpc("writeHex", { hex: String(hex || "") });
// Expose hex read callback to Python runtime via js module bridge.
self.serial_read_hex = (count, timeoutMs) =>
  serialRpc("readHex", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  });
// Expose raw byte write callback to Python runtime via js module bridge.
self.serial_write_bytes = (bytes) =>
  serialRpc("writeBytes", {
    bytes: Array.from(bytes || []),
  });
// Expose raw byte read callback to Python runtime via js module bridge.
self.serial_read_bytes = (count, timeoutMs) =>
  serialRpc("readBytes", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  });
// Expose log callback so Python status/debug lines can be rendered in UI.
self.serial_log = (message) =>
  serialRpc("log", {
    message: String(message || ""),
  });
// Expose pre-clone session prep callback (line control + settle timing).
self.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
  serialRpc("prepareClone", {
    wantsDtr: Boolean(wantsDtr),
    wantsRts: Boolean(wantsRts),
    settleMs: Number(settleMs || 350),
  });
// Expose buffer reset callback for pyserial compatibility methods.
self.serial_reset_buffers = () => serialRpc("resetBuffers", {});
// Expose CHIRP source fetch callback used by Python import hook for lazy module loading.
self.fetch_chirp_source = (path) => fetchText(String(path || ""));

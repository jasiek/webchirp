/* global importScripts, loadPyodide */

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js";
const CHIRP_CDN_BASE = "https://cdn.jsdelivr.net/gh/kk7ds/chirp@master";
const CHIRP_FILE_INDEX_URL =
  "https://data.jsdelivr.com/v1/package/gh/kk7ds/chirp@master/flat";

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
const loadedChirpModules = new Set([
  "chirp.__init__",
  "chirp.errors",
  "chirp.util",
  "chirp.memmap",
  "chirp.chirp_common",
  "chirp.directory",
  "chirp.pyPEG",
  "chirp.bitwise_grammar",
  "chirp.bitwise",
  "chirp.settings",
  "chirp.drivers.generic_csv",
  "chirp.drivers.h777",
]);
let rpcId = 0;
const rpcPending = new Map();

function serialRpc(op, payload = {}) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    self.postMessage({ type: "serial-rpc", id, op, payload });
  });
}

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

async function fetchLocalText(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status}`);
  }
  return await res.text();
}

async function fetchText(path) {
  const url = path.startsWith("http") ? path : `${CHIRP_CDN_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return await res.text();
}

function parseChirpImports(sourceText) {
  const deps = new Set();
  const lines = sourceText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    let m = trimmed.match(/^from\s+chirp\.drivers\.([A-Za-z0-9_]+)\s+import\s+/);
    if (m) {
      deps.add(`chirp.drivers.${m[1]}`);
      continue;
    }
    m = trimmed.match(/^from\s+chirp\.drivers\s+import\s+(.+)$/);
    if (m) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          deps.add(`chirp.drivers.${name}`);
        }
      }
      continue;
    }
    m = trimmed.match(/^from\s+chirp\s+import\s+(.+)$/);
    if (m) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          deps.add(`chirp.${name}`);
        }
      }
      continue;
    }
    m = trimmed.match(/^import\s+(.+)$/);
    if (m) {
      for (const part of m[1].split(",")) {
        const item = part.trim().split(/\s+/)[0];
        if (item === "chirp" || item.startsWith("chirp.")) {
          deps.add(item === "chirp" ? "chirp.__init__" : item);
        }
      }
    }
  }
  return [...deps];
}

function moduleToSourcePath(moduleName) {
  if (moduleName === "chirp" || moduleName === "chirp.__init__") {
    return "/chirp/__init__.py";
  }
  if (moduleName === "chirp.drivers") {
    return "/chirp/drivers/__init__.py";
  }
  return `/${moduleName.replace(/\./g, "/")}.py`;
}

function moduleToRuntimePath(moduleName) {
  if (moduleName === "chirp" || moduleName === "chirp.__init__") {
    return "/webchirp_runtime/chirp/__init__.py";
  }
  if (moduleName === "chirp.drivers") {
    return "/webchirp_runtime/chirp/drivers/__init__.py";
  }
  return `/webchirp_runtime/${moduleName.replace(/\./g, "/")}.py`;
}

async function ensureChirpModuleLoaded(moduleName) {
  if (loadedChirpModules.has(moduleName)) {
    return;
  }
  const sourcePath = moduleToSourcePath(moduleName);
  const runtimePath = moduleToRuntimePath(moduleName);
  const source = await fetchText(sourcePath);
  const dir = runtimePath.split("/").slice(0, -1).join("/");
  mkdirp(dir);
  pyodide.FS.writeFile(runtimePath, source, { encoding: "utf8" });
  loadedChirpModules.add(moduleName);

  const deps = parseChirpImports(source);
  for (const dep of deps) {
    if (!dep.startsWith("chirp.wxui") && !dep.startsWith("chirp.cli")) {
      try {
        await ensureChirpModuleLoaded(dep);
      } catch {
        // Best effort dependency loading; import-time errors are surfaced later.
      }
    }
  }
}

async function ensureSelectedRadioModules(moduleShortName) {
  await ensurePyodide();
  await ensureChirpModuleLoaded(`chirp.drivers.${moduleShortName}`);
}

function parseDriverFileForRadios(moduleName, text) {
  const radios = [];
  const marker = "@directory.register";
  let idx = 0;
  while (true) {
    const start = text.indexOf(marker, idx);
    if (start === -1) {
      break;
    }
    const next = text.indexOf(marker, start + marker.length);
    const block = text.slice(start, next === -1 ? text.length : next);
    idx = next === -1 ? text.length : next;

    const classMatch = block.match(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const vendorMatch = block.match(/^\s*VENDOR\s*=\s*["']([^"']+)["']/m);
    const modelMatch = block.match(/^\s*MODEL\s*=\s*["']([^"']+)["']/m);
    const baudMatch = block.match(/^\s*BAUD_RATE\s*=\s*([0-9]+)/m);
    if (!classMatch || !vendorMatch || !modelMatch) {
      continue;
    }

    radios.push({
      key: `${moduleName}:${classMatch[1]}`,
      module: moduleName,
      className: classMatch[1],
      vendor: vendorMatch[1],
      model: modelMatch[1],
      baudRate: baudMatch ? Number(baudMatch[1]) : null,
    });
  }
  return radios;
}

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

  const allRadios = [];
  await Promise.all(
    modules.map(async (moduleName) => {
      try {
        const text = await fetchText(`/chirp/drivers/${moduleName}.py`);
        allRadios.push(...parseDriverFileForRadios(moduleName, text));
      } catch {
        // Ignore module parse failures.
      }
    }),
  );

  allRadios.sort((a, b) => {
    const av = `${a.vendor}\u0000${a.model}`;
    const bv = `${b.vendor}\u0000${b.model}`;
    return av.localeCompare(bv);
  });

  radioCatalogCache = allRadios;
  return radioCatalogCache;
}

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

async function handleCall(method, payload) {
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

self.serial_open = (baudRate) => serialRpc("open", { baudRate: Number(baudRate) });
self.serial_close = () => serialRpc("close", {});
self.serial_write_hex = (hex) => serialRpc("writeHex", { hex: String(hex || "") });
self.serial_read_hex = (count, timeoutMs) =>
  serialRpc("readHex", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  });
self.serial_write_bytes = (bytes) =>
  serialRpc("writeBytes", {
    bytes: Array.from(bytes || []),
  });
self.serial_read_bytes = (count, timeoutMs) =>
  serialRpc("readBytes", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  });
self.serial_log = (message) =>
  serialRpc("log", {
    message: String(message || ""),
  });
self.serial_prepare_clone = (wantsDtr, wantsRts, settleMs) =>
  serialRpc("prepareClone", {
    wantsDtr: Boolean(wantsDtr),
    wantsRts: Boolean(wantsRts),
    settleMs: Number(settleMs || 350),
  });
self.serial_reset_buffers = () => serialRpc("resetBuffers", {});

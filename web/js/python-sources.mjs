// Single source of truth for the CHIRP revision the app runs against. The
// chirp/ submodule and the committed web/radio-catalog.json must match this
// revision; scripts/build-catalog.mjs enforces it at catalog build time and
// the runtime rejects a mismatched static catalog.
export const DEFAULT_CHIRP_REVISION = "33a76a6364ea8847f9ab64ce51460cf260a820f2";

const CORE_CHIRP_RELATIVE_FILES = [
  "chirp/__init__.py",
  "chirp/errors.py",
  "chirp/util.py",
  "chirp/memmap.py",
  "chirp/chirp_common.py",
  "chirp/directory.py",
  // CSV export runs memories through import_logic the way CHIRP's own export
  // does, so it has to be seeded before runtime_bridge.py imports it — the
  // lazy CDN finder is installed further down that same module.
  "chirp/import_logic.py",
  "chirp/pyPEG.py",
  "chirp/bitwise_grammar.py",
  "chirp/bitwise.py",
  "chirp/settings.py",
  "chirp/drivers/generic_csv.py",
  "chirp/drivers/h777.py",
];

// Every file of the Python runtime, by its path under web/python/ -- which is
// also where it lands under /webchirp_runtime in the Pyodide filesystem, so
// the webchirp_bridge package imports by exactly these names. The entry point
// is executed rather than written: it is the one file whose names land in
// Pyodide's globals. Where the browser fetches each file from is the caller's
// business (RUNTIME_PYTHON_URLS in web/js/runtime-rpc.js): scripts/build-dist.mjs
// rewrites asset references to their hashed names in .js files only and copies
// this .mjs file verbatim, so a URL literal written here would 404 in a deploy.
export const RUNTIME_BRIDGE_ENTRY = "runtime_bridge.py";
export const RUNTIME_PYTHON_FILES = Object.freeze([
  RUNTIME_BRIDGE_ENTRY,
  "webchirp_bridge/__init__.py",
  "webchirp_bridge/channel_extra.py",
  "webchirp_bridge/channel_rows.py",
  "webchirp_bridge/chirp_loader.py",
  "webchirp_bridge/clone.py",
  "webchirp_bridge/column_metadata.py",
  "webchirp_bridge/driver_cache.py",
  "webchirp_bridge/images.py",
  "webchirp_bridge/jsbridge.py",
  "webchirp_bridge/power_levels.py",
  "webchirp_bridge/radio_memories.py",
  "webchirp_bridge/radio_settings.py",
  "webchirp_bridge/row_validation.py",
  "webchirp_bridge/runtime_errors.py",
  "webchirp_bridge/serial_pipe.py",
]);

function assertMethod(obj, name) {
  if (!obj || typeof obj[name] !== "function") {
    throw new Error(`Python source provider is missing method: ${name}`);
  }
}

function normalizeSourcePath(sourcePath) {
  const raw = String(sourcePath || "");
  const noLeadingSlash = raw.replace(/^\/+/, "");
  if (!noLeadingSlash) {
    throw new Error("Invalid CHIRP source path: empty");
  }
  if (!noLeadingSlash.startsWith("chirp/")) {
    throw new Error(`Invalid CHIRP source path: ${raw}`);
  }
  if (noLeadingSlash.includes("..")) {
    throw new Error(`Invalid CHIRP source path traversal: ${raw}`);
  }
  return noLeadingSlash;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return await res.text();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return await res.json();
}

function parseDriverModuleNames(indexJson) {
  return Array.from(
    new Set(
      (indexJson?.files || [])
        .map((f) => f?.name || "")
        .filter((name) => /^\/chirp\/drivers\/[A-Za-z0-9_]+\.py$/.test(name))
        .map((name) => name.split("/").pop().replace(/\.py$/, ""))
        .filter((name) => !name.startsWith("__")),
    ),
  );
}

export function createBrowserCdnPythonSource({
  chirpRevision = DEFAULT_CHIRP_REVISION,
  runtimeFileUrls,
  fetchTextImpl = fetchText,
  fetchJsonImpl = fetchJson,
} = {}) {
  // Checked up front rather than at fetch time so a module added to
  // RUNTIME_PYTHON_FILES without a URL fails the first boot loudly, not the
  // first user who reaches the code that imports it.
  for (const relPath of RUNTIME_PYTHON_FILES) {
    if (typeof runtimeFileUrls?.[relPath] !== "string") {
      throw new Error(`createBrowserCdnPythonSource: no URL for runtime Python file ${relPath}`);
    }
  }
  const chirpCdnBase = `https://cdn.jsdelivr.net/gh/kk7ds/chirp@${chirpRevision}`;
  const chirpFileIndexUrl =
    `https://data.jsdelivr.com/v1/package/gh/kk7ds/chirp@${chirpRevision}/flat`;

  return {
    async fetchChirpSource(sourcePath) {
      const relPath = normalizeSourcePath(sourcePath);
      return fetchTextImpl(`${chirpCdnBase}/${relPath}`);
    },
    async fetchRuntimeFile(relPath) {
      return fetchTextImpl(runtimeFileUrls[relPath]);
    },
    async listDriverModules() {
      const indexJson = await fetchJsonImpl(chirpFileIndexUrl);
      return parseDriverModuleNames(indexJson);
    },
    getRuntimeInfo() {
      return {
        chirpRevision,
        chirpCdnBase,
        chirpSourceKind: "cdn",
      };
    },
  };
}

export function createFilesystemPythonSource({
  chirpPackageDir,
  runtimePythonDir,
  readText,
  readDirNames,
  joinPath,
} = {}) {
  if (!chirpPackageDir) {
    throw new Error("createFilesystemPythonSource requires chirpPackageDir");
  }
  if (!runtimePythonDir) {
    throw new Error("createFilesystemPythonSource requires runtimePythonDir");
  }
  if (typeof readText !== "function") {
    throw new Error("createFilesystemPythonSource requires readText(path) function");
  }
  if (typeof readDirNames !== "function") {
    throw new Error("createFilesystemPythonSource requires readDirNames(path) function");
  }
  if (typeof joinPath !== "function") {
    throw new Error("createFilesystemPythonSource requires joinPath(...parts) function");
  }

  return {
    async fetchChirpSource(sourcePath) {
      const relPath = normalizeSourcePath(sourcePath);
      return readText(joinPath(chirpPackageDir, relPath.replace(/^chirp\//, "")));
    },
    async fetchRuntimeFile(relPath) {
      return readText(joinPath(runtimePythonDir, ...relPath.split("/")));
    },
    async listDriverModules() {
      const names = await readDirNames(joinPath(chirpPackageDir, "drivers"));
      return names
        .filter((name) => /^[A-Za-z0-9_]+\.py$/.test(name))
        .map((name) => name.replace(/\.py$/, ""))
        .filter((name) => !name.startsWith("__"))
        .sort();
    },
    getRuntimeInfo() {
      return {
        chirpRevision: "local",
        chirpCdnBase: "",
        chirpSourceKind: "filesystem",
        chirpPackageDir: String(chirpPackageDir),
      };
    },
  };
}

function ensureProvider(sourceProvider) {
  assertMethod(sourceProvider, "fetchChirpSource");
  assertMethod(sourceProvider, "fetchRuntimeFile");
  assertMethod(sourceProvider, "listDriverModules");
}

async function mkdirp(pyodide, dir) {
  const parts = String(dir || "").split("/").filter(Boolean);
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

export function installFetchChirpSourceGlobal(sourceProvider, target = globalThis) {
  ensureProvider(sourceProvider);
  target.fetch_chirp_source = (sourcePath) => sourceProvider.fetchChirpSource(sourcePath);
}

export async function seedPyodideRuntime(pyodide, sourceProvider) {
  ensureProvider(sourceProvider);
  await mkdirp(pyodide, "/webchirp_runtime/chirp/drivers");

  await Promise.all(
    CORE_CHIRP_RELATIVE_FILES.map(async (relativePath) => {
      const sourcePath = `/${relativePath}`;
      const text = await sourceProvider.fetchChirpSource(sourcePath);
      pyodide.FS.writeFile(`/webchirp_runtime/${relativePath}`, text, {
        encoding: "utf8",
      });
    }),
  );

  // The package modules go into the filesystem alongside chirp/, where the
  // entry point's sys.path entry finds them; the entry point itself is run.
  await Promise.all(
    RUNTIME_PYTHON_FILES.filter((relPath) => relPath !== RUNTIME_BRIDGE_ENTRY)
      .map(async (relPath) => {
        const text = await sourceProvider.fetchRuntimeFile(relPath);
        const target = `/webchirp_runtime/${relPath}`;
        await mkdirp(pyodide, target.slice(0, target.lastIndexOf("/")));
        pyodide.FS.writeFile(target, text, { encoding: "utf8" });
      }),
  );

  const runtimePython = await sourceProvider.fetchRuntimeFile(RUNTIME_BRIDGE_ENTRY);
  await pyodide.runPythonAsync(runtimePython);
}

export async function listDriverModules(sourceProvider) {
  ensureProvider(sourceProvider);
  return sourceProvider.listDriverModules();
}

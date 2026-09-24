// Single source of truth for the CHIRP revision the app runs against. The
// chirp/ submodule and the committed web/radio-catalog.json must match this
// revision; scripts/build-catalog.mjs enforces it at catalog build time and
// the runtime rejects a mismatched static catalog.
export const DEFAULT_CHIRP_REVISION = "4acbeb8a40ec247e0a0e89ff78d52eaa1b128def";
export const DEFAULT_DRIVER_SET = "chirp";
export const QUANSHENG_UNOFFICIAL_DRIVER_SET = "quansheng-unofficial";
export const DRIVER_SETS = Object.freeze([
  DEFAULT_DRIVER_SET,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
]);

// Third-party drivers shipped by WebCHIRP in addition to the pinned upstream
// CHIRP tree. Keep their release hashes here so tests can prove that the local
// sources are the exact published assets. The v4.3.2 release ships a driver
// that identifies itself as v4.3.0; preserve those published bytes unchanged.
export const QUANSHENG_UNOFFICIAL_DRIVERS = Object.freeze([
  {
    module: "f4hwn_v4_3",
    relPath: "extra_drivers/quansheng/f4hwn_v4_3.py",
    releases: ["v4.3.2"],
    sha256: "024ff9d263d7aeb8be03414754c99dd696ee20cf322e6e20c6a72f0287cf42a1",
  },
  {
    module: "f4hwn_v5_9_0",
    relPath: "extra_drivers/quansheng/f4hwn_v5_9_0.py",
    releases: ["v5.9.0"],
    sha256: "09d23891a6dc44478cb3e8fd16e1f00fdf33673b4e2faffae765ad812b3a0ff2",
  },
  {
    module: "f4hwn_v6",
    relPath: "extra_drivers/quansheng/f4hwn_v6.py",
    releases: ["v6.0.0"],
    sha256: "c1c560ae081a40ea7aee0cd1e71b47641e63d64aea8886412c1041bda14f5156",
  },
]);
export const EXTRA_DRIVER_RELATIVE_FILES = Object.freeze(
  QUANSHENG_UNOFFICIAL_DRIVERS.map((driver) => driver.relPath),
);
export const QUANSHENG_UNOFFICIAL_DRIVER_MODULES = Object.freeze(
  QUANSHENG_UNOFFICIAL_DRIVERS.map((driver) => driver.module),
);

const QUANSHENG_SOURCE_BY_CHIRP_PATH = new Map(
  QUANSHENG_UNOFFICIAL_DRIVERS.map((driver) => [
    `chirp/drivers/${driver.module}.py`,
    driver.relPath,
  ]),
);

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

// Resolve a URL value to one of the two supported driver collections.
export function normalizeDriverSet(value) {
  return DRIVER_SETS.includes(String(value || "")) ? String(value) : DEFAULT_DRIVER_SET;
}

// Read the driver collection from a query string, defaulting to upstream CHIRP.
export function driverSetFromSearch(search) {
  return normalizeDriverSet(new URLSearchParams(String(search || "")).get("drivers"));
}

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
  driverSet = DEFAULT_DRIVER_SET,
  runtimeFileUrls,
  fetchTextImpl = fetchText,
  fetchJsonImpl = fetchJson,
} = {}) {
  const selectedDriverSet = normalizeDriverSet(driverSet);
  // Checked up front rather than at fetch time so a declared local Python
  // source without a URL fails construction loudly, not the first user who
  // reaches the code that imports it.
  for (const relPath of [
    ...RUNTIME_PYTHON_FILES,
    ...EXTRA_DRIVER_RELATIVE_FILES,
  ]) {
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
      const extraSourcePath = QUANSHENG_SOURCE_BY_CHIRP_PATH.get(relPath);
      if (extraSourcePath && selectedDriverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
        return fetchTextImpl(runtimeFileUrls[extraSourcePath]);
      }
      return fetchTextImpl(`${chirpCdnBase}/${relPath}`);
    },
    async fetchRuntimeFile(relPath) {
      return fetchTextImpl(runtimeFileUrls[relPath]);
    },
    async listDriverModules() {
      if (selectedDriverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
        return [...QUANSHENG_UNOFFICIAL_DRIVER_MODULES];
      }
      const indexJson = await fetchJsonImpl(chirpFileIndexUrl);
      return parseDriverModuleNames(indexJson).sort();
    },
    getRuntimeInfo() {
      return {
        chirpRevision,
        chirpCdnBase,
        chirpSourceKind: "cdn",
        driverSet: selectedDriverSet,
      };
    },
  };
}

export function createFilesystemPythonSource({
  chirpPackageDir,
  runtimePythonDir,
  driverSet = DEFAULT_DRIVER_SET,
  readText,
  readDirNames,
  joinPath,
} = {}) {
  const selectedDriverSet = normalizeDriverSet(driverSet);
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
      const extraSourcePath = QUANSHENG_SOURCE_BY_CHIRP_PATH.get(relPath);
      if (extraSourcePath && selectedDriverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
        return readText(joinPath(runtimePythonDir, ...extraSourcePath.split("/")));
      }
      return readText(joinPath(chirpPackageDir, relPath.replace(/^chirp\//, "")));
    },
    async fetchRuntimeFile(relPath) {
      return readText(joinPath(runtimePythonDir, ...relPath.split("/")));
    },
    async listDriverModules() {
      if (selectedDriverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
        return [...QUANSHENG_UNOFFICIAL_DRIVER_MODULES];
      }
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
        driverSet: selectedDriverSet,
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

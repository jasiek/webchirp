const DEFAULT_CHIRP_REVISION = "1467519e792e8ebcc9a33dc40df0b2e273ce9a53";

const CORE_CHIRP_RELATIVE_FILES = [
  "chirp/__init__.py",
  "chirp/errors.py",
  "chirp/util.py",
  "chirp/memmap.py",
  "chirp/chirp_common.py",
  "chirp/directory.py",
  "chirp/pyPEG.py",
  "chirp/bitwise_grammar.py",
  "chirp/bitwise.py",
  "chirp/settings.py",
  "chirp/drivers/generic_csv.py",
  "chirp/drivers/h777.py",
];

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
  runtimeBridgePath = "./python/runtime_bridge.py",
  fetchTextImpl = fetchText,
  fetchJsonImpl = fetchJson,
} = {}) {
  const chirpCdnBase = `https://cdn.jsdelivr.net/gh/kk7ds/chirp@${chirpRevision}`;
  const chirpFileIndexUrl =
    `https://data.jsdelivr.com/v1/package/gh/kk7ds/chirp@${chirpRevision}/flat`;

  return {
    async fetchChirpSource(sourcePath) {
      const relPath = normalizeSourcePath(sourcePath);
      return fetchTextImpl(`${chirpCdnBase}/${relPath}`);
    },
    async fetchRuntimeBridge() {
      return fetchTextImpl(runtimeBridgePath);
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
  runtimeBridgePath,
  readText,
  readDirNames,
  joinPath,
} = {}) {
  if (!chirpPackageDir) {
    throw new Error("createFilesystemPythonSource requires chirpPackageDir");
  }
  if (!runtimeBridgePath) {
    throw new Error("createFilesystemPythonSource requires runtimeBridgePath");
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
    async fetchRuntimeBridge() {
      return readText(runtimeBridgePath);
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
  assertMethod(sourceProvider, "fetchRuntimeBridge");
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

  const runtimePython = await sourceProvider.fetchRuntimeBridge();
  await pyodide.runPythonAsync(runtimePython);
}

export async function listDriverModules(sourceProvider) {
  ensureProvider(sourceProvider);
  return sourceProvider.listDriverModules();
}

// Single source of truth for the CHIRP revision the app runs against. The
// chirp/ submodule and the committed web/radio-catalog.json must match this
// revision; scripts/build-catalog.mjs enforces it at catalog build time and
// the runtime rejects a mismatched static catalog.
export const DEFAULT_CHIRP_REVISION = "098f57b2563af7d9411f2f42722947c52d569929";

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

// Retrying the runtime's source fetches.
//
// Seeding the runtime is a burst of parallel GETs -- the core CHIRP files from
// jsDelivr, the bridge files from the app's own asset host, one driver module
// per lazy import -- and one rejected request aborts the whole Promise.all. A
// transient blip (a dropped connection, a 429 from a CDN edge, a 5xx while
// Pages rolls a deploy) therefore costs the visitor a reload and files itself
// as a crash. Every one of these requests is an idempotent GET for a pinned
// asset, so trying it again has no side effects.
export const PYTHON_SOURCE_MAX_ATTEMPTS = 3;
export const PYTHON_SOURCE_TIMEOUT_MS = 15000;
const PYTHON_SOURCE_BASE_BACKOFF_MS = 250;

// A non-2xx response, carrying its status so the retry loop can tell "come back
// later" from "this request is wrong". The message keeps its historical shape
// so existing debug lines and the Sentry scrub rules read the same.
class PythonSourceFetchError extends Error {
  constructor(url, status) {
    super(`Failed to fetch ${url}: ${status}`);
    this.name = "PythonSourceFetchError";
    this.status = status;
  }
}

// Only retry what a second attempt can plausibly fix. The CDN asking us to come
// back (408/429) or failing on its side (5xx) is transient; every other 4xx is
// about the request itself -- a bad pin, a typo in a runtime URL -- and would
// fail identically, so retrying it only delays the loud failure. A transport
// rejection (offline, DNS, TLS, a blocking proxy) carries no status and is
// transient by nature; so is this module's own timeout.
function isRetryableError(error) {
  return !(error instanceof PythonSourceFetchError)
    || error.status === 408
    || error.status === 429
    || error.status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with jitter. The seeding burst is 30-odd requests at
// once, so an unjittered delay resends them all at the same instant -- which is
// how a CDN that is already rate-limiting the visitor stays rate-limited.
function backoffDelay(baseMs, attemptNumber, random) {
  const exponential = baseMs * 2 ** (attemptNumber - 1);
  return Math.round(exponential + exponential * 0.5 * random());
}

// One attempt under a deadline. fetch() resolves as soon as the response
// headers arrive, so the body read has to happen inside `run` for a host that
// answers 200 and then stalls mid-body to be bounded too. An AbortSignal rather
// than Promise.race so the connection is actually closed, and a setTimeout
// rather than AbortSignal.timeout() so tests can drive the deadline over a
// mocked clock (the same reasoning as web/js/request-timeout.js).
async function withDeadline(url, run, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Failed to fetch ${url}: timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Bounded retry shared by every source fetch. `attempt(signal)` performs one
// full request-and-parse; `onRetry` is told about each failure so the debug
// panel can show a boot that is slow because it is retrying, not hung.
export async function fetchWithRetry(url, attempt, {
  maxAttempts = PYTHON_SOURCE_MAX_ATTEMPTS,
  timeoutMs = PYTHON_SOURCE_TIMEOUT_MS,
  baseBackoffMs = PYTHON_SOURCE_BASE_BACKOFF_MS,
  sleepImpl = sleep,
  randomImpl = Math.random,
  onRetry = null,
} = {}) {
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      return await withDeadline(url, attempt, timeoutMs);
    } catch (error) {
      if (attemptNumber >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      const waitMs = backoffDelay(baseBackoffMs, attemptNumber, randomImpl);
      if (onRetry) {
        onRetry(
          `RETRY ${url} failed (${error?.message || error}); `
          + `attempt ${attemptNumber}/${maxAttempts}, next in ${waitMs} ms`,
        );
      }
      await sleepImpl(waitMs);
    }
  }
  // Unreachable: the loop returns or throws on its last iteration. Kept so the
  // function has no implicit `undefined` return path.
  throw new Error(`fetchWithRetry exhausted without an error: ${url}`);
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
  fetchImpl = fetch,
  maxAttempts = PYTHON_SOURCE_MAX_ATTEMPTS,
  timeoutMs = PYTHON_SOURCE_TIMEOUT_MS,
  sleepImpl = sleep,
  randomImpl = Math.random,
  onRetry = null,
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
  const retryOptions = { maxAttempts, timeoutMs, sleepImpl, randomImpl, onRetry };

  // One GET whose body is read inside the attempt, so a response that stalls
  // mid-body is retried rather than handed on half-read.
  const fetchText = (url) =>
    fetchWithRetry(url, async (signal) => {
      const res = await fetchImpl(url, { signal });
      if (!res.ok) {
        throw new PythonSourceFetchError(url, res.status);
      }
      return res.text();
    }, retryOptions);

  const fetchJson = (url) =>
    fetchWithRetry(url, async (signal) => {
      const res = await fetchImpl(url, { signal });
      if (!res.ok) {
        throw new PythonSourceFetchError(url, res.status);
      }
      return res.json();
    }, retryOptions);

  return {
    async fetchChirpSource(sourcePath) {
      const relPath = normalizeSourcePath(sourcePath);
      return fetchText(`${chirpCdnBase}/${relPath}`);
    },
    async fetchRuntimeFile(relPath) {
      return fetchText(runtimeFileUrls[relPath]);
    },
    async listDriverModules() {
      const indexJson = await fetchJson(chirpFileIndexUrl);
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

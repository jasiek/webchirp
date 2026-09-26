// Single source of truth for the CHIRP revision the app runs against. The
// chirp/ submodule, the committed web/radio-catalog.json and the CHIRP archive
// (web/chirp/chirp-<pin>.zip, built by scripts/build-chirp-bundle.mjs) must
// all match this revision; scripts/build-catalog.mjs and the bundle build
// enforce it at build time and the runtime rejects a mismatched static catalog
// or bundle manifest.
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

// Every file of the Python runtime, by its path under web/python/ -- which is
// also where it lands under /webchirp_runtime in the Pyodide filesystem, so
// the webchirp_bridge package imports by exactly these names. The entry point
// is executed rather than written: it is the one file whose names land in
// Pyodide's globals, and rpc_dispatch (web/python/webchirp_bridge/rpc.py) is
// the only one JS reads back. Where the browser fetches each file from is the caller's
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
  "webchirp_bridge/rpc.py",
  "webchirp_bridge/runtime_errors.py",
  "webchirp_bridge/serial_pipe.py",
]);

// Where the CHIRP archive lives under web/ (and so under dist/), and the two
// files it consists of for a given pin. Named by the pin rather than by
// content so the URL is immutable on GitHub Pages without scripts/build-dist.mjs
// learning a new hashing rule; scripts/build-chirp-bundle.mjs writes them and
// scripts/retain-deployed-assets.mjs carries the previous pin's pair forward.
// The names are not hashed by the build, so unlike the runtime files above
// they can be spelled here and resolved against the page's own origin.
export const CHIRP_BUNDLE_DIR = "chirp";
export function chirpBundleFileNames(chirpRevision) {
  const pin = String(chirpRevision || "");
  if (!/^[0-9a-f]{40}$/.test(pin)) {
    throw new Error(`chirpBundleFileNames: not a full git sha: ${pin}`);
  }
  return Object.freeze({
    archive: `chirp-${pin}.zip`,
    manifest: `chirp-${pin}.json`,
  });
}

// Where the whole runtime lives in the Pyodide filesystem: the CHIRP package
// from the archive, the bundled drivers written over it, and the bridge
// package beside them. web/python/runtime_bridge.py puts it on sys.path.
export const RUNTIME_MOUNT_DIR = "/webchirp_runtime";

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

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res;
}

async function fetchText(url) {
  return (await fetchOk(url)).text();
}

async function fetchJson(url) {
  return (await fetchOk(url)).json();
}

async function fetchBytes(url) {
  return new Uint8Array(await (await fetchOk(url)).arrayBuffer());
}

// The driver modules a bundle manifest lists, after checking it is the
// manifest for the pin this runtime expects: a deploy that paired a runtime
// with another pin's archive would otherwise import drivers that do not match
// the catalog the user picked from. Exported so the Node provider
// (tests/support/chirp-bundle-source.mjs) applies the same check.
export function driverModulesFromManifest(manifest, chirpRevision) {
  if (manifest?.chirpRevision !== chirpRevision) {
    throw new Error(
      `CHIRP bundle manifest is for revision ${manifest?.chirpRevision || "unknown"}, `
      + `runtime is pinned to ${chirpRevision}`,
    );
  }
  if (!Array.isArray(manifest.drivers) || manifest.drivers.length === 0) {
    throw new Error("CHIRP bundle manifest lists no driver modules");
  }
  return manifest.drivers.map(String).sort();
}

// The browser's source of every Python file the runtime needs: the CHIRP
// archive and manifest from chirpBundleBaseUrl (our own origin, see
// scripts/build-chirp-bundle.mjs) and the bridge package and bundled drivers
// from runtimeFileUrls. tests/support/chirp-bundle-source.mjs is the Node
// counterpart with the same shape, building the archive from the submodule.
export function createBrowserPythonSource({
  chirpRevision = DEFAULT_CHIRP_REVISION,
  driverSet = DEFAULT_DRIVER_SET,
  runtimeFileUrls,
  chirpBundleBaseUrl,
  fetchTextImpl = fetchText,
  fetchJsonImpl = fetchJson,
  fetchBytesImpl = fetchBytes,
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
      throw new Error(`createBrowserPythonSource: no URL for runtime Python file ${relPath}`);
    }
  }
  if (!chirpBundleBaseUrl) {
    throw new Error("createBrowserPythonSource requires chirpBundleBaseUrl");
  }
  const bundleNames = chirpBundleFileNames(chirpRevision);
  const bundleUrl = (name) => new URL(name, chirpBundleBaseUrl).href;
  let manifestPromise = null;

  // Fetched once per page: the manifest is read before the all-drivers sweep
  // and again by the catalog fallback, and it never changes under a pinned
  // name. A failed fetch is not cached, so a later call retries.
  function fetchChirpManifest() {
    if (!manifestPromise) {
      manifestPromise = fetchJsonImpl(bundleUrl(bundleNames.manifest)).catch((error) => {
        manifestPromise = null;
        throw error;
      });
    }
    return manifestPromise;
  }

  return {
    async fetchChirpArchive() {
      return fetchBytesImpl(bundleUrl(bundleNames.archive));
    },
    fetchChirpManifest,
    async fetchRuntimeFile(relPath) {
      return fetchTextImpl(runtimeFileUrls[relPath]);
    },
    async listDriverModules() {
      if (selectedDriverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
        return [...QUANSHENG_UNOFFICIAL_DRIVER_MODULES];
      }
      return driverModulesFromManifest(await fetchChirpManifest(), chirpRevision);
    },
    getRuntimeInfo() {
      return {
        chirpRevision,
        chirpSourceKind: "bundle",
        chirpBundleUrl: bundleUrl(bundleNames.archive),
        driverSet: selectedDriverSet,
      };
    },
  };
}

function ensureProvider(sourceProvider) {
  assertMethod(sourceProvider, "fetchChirpArchive");
  assertMethod(sourceProvider, "fetchRuntimeFile");
  assertMethod(sourceProvider, "listDriverModules");
  assertMethod(sourceProvider, "getRuntimeInfo");
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

// Seed one interpreter: unpack the CHIRP archive, write the bridge package
// next to it and run the entry point. No import hook is involved any more --
// every chirp.* module is a file on the mounted tree, so imports resolve
// through Python's ordinary path finder and never suspend the interpreter.
export async function seedPyodideRuntime(pyodide, sourceProvider) {
  ensureProvider(sourceProvider);
  await mkdirp(pyodide, RUNTIME_MOUNT_DIR);

  const archive = await sourceProvider.fetchChirpArchive();
  await pyodide.unpackArchive(archive, "zip", { extractDir: RUNTIME_MOUNT_DIR });

  // The unofficial drivers are separate files shipped by WebCHIRP, written
  // into the mounted tree under the module names the catalog uses so they
  // import exactly like an upstream driver. Only the selected set is written:
  // the releases share CHIRP identities and must never coexist with the
  // upstream uvk5 drivers in one interpreter.
  if (sourceProvider.getRuntimeInfo().driverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    await Promise.all(
      QUANSHENG_UNOFFICIAL_DRIVERS.map(async (driver) => {
        const text = await sourceProvider.fetchRuntimeFile(driver.relPath);
        pyodide.FS.writeFile(
          `${RUNTIME_MOUNT_DIR}/chirp/drivers/${driver.module}.py`,
          text,
          { encoding: "utf8" },
        );
      }),
    );
  }

  // The package modules go into the filesystem alongside chirp/, where the
  // entry point's sys.path entry finds them; the entry point itself is run.
  await Promise.all(
    RUNTIME_PYTHON_FILES.filter((relPath) => relPath !== RUNTIME_BRIDGE_ENTRY)
      .map(async (relPath) => {
        const text = await sourceProvider.fetchRuntimeFile(relPath);
        const target = `${RUNTIME_MOUNT_DIR}/${relPath}`;
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

// The Node counterpart of createBrowserPythonSource (web/js/python-sources.mjs):
// the same provider shape, fed from disk. The CHIRP archive is built
// in-process from the submodule by scripts/build-chirp-bundle.mjs, the very
// function the deploy runs, so the test harness, scripts/build-catalog.mjs
// and scripts/radio-codeplug.mjs mount exactly what a browser would -- there
// is no second code path that reads chirp/ file by file and no fetch global
// to fake.
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildChirpBundle,
  resolveChirpPackageDir,
} from "../../scripts/build-chirp-bundle.mjs";
import {
  DEFAULT_CHIRP_REVISION,
  DEFAULT_DRIVER_SET,
  driverModulesFromManifest,
  normalizeDriverSet,
  QUANSHENG_UNOFFICIAL_DRIVER_MODULES,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
} from "../../web/js/python-sources.mjs";

// One archive per package directory per process. Every harness in a test
// file (and the isolated ones some tests ask for) mounts the same tree, and
// deflating six megabytes of drivers is the slow part of a boot.
const bundlesByDir = new Map();

function bundleFor(chirpPackageDir) {
  if (!bundlesByDir.has(chirpPackageDir)) {
    bundlesByDir.set(
      chirpPackageDir,
      buildChirpBundle({ chirpPackageDir, chirpRevision: DEFAULT_CHIRP_REVISION }),
    );
  }
  return bundlesByDir.get(chirpPackageDir);
}

// A provider over a CHIRP checkout (repo/chirp by default, or
// WEBCHIRP_CHIRP_DIR / an explicit chirpDir) and the repo's web/python tree.
export async function createLocalPythonSource({ repoRoot, chirpDir = "", driverSet } = {}) {
  const selectedDriverSet = normalizeDriverSet(driverSet || DEFAULT_DRIVER_SET);
  const chirpInputDir =
    chirpDir || process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp");
  const chirpPackageDir = await resolveChirpPackageDir(chirpInputDir);
  const runtimePythonDir = path.join(repoRoot, "web/python");

  return {
    // A fresh copy: Buffers can alias Node's shared pool, and Pyodide reads
    // the bytes it is handed by their own offset and length.
    async fetchChirpArchive() {
      return new Uint8Array((await bundleFor(chirpPackageDir)).archive);
    },
    async fetchChirpManifest() {
      return (await bundleFor(chirpPackageDir)).manifest;
    },
    async fetchRuntimeFile(relPath) {
      return fs.readFile(path.join(runtimePythonDir, ...relPath.split("/")), "utf8");
    },
    async listDriverModules() {
      if (selectedDriverSet === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
        return [...QUANSHENG_UNOFFICIAL_DRIVER_MODULES];
      }
      return driverModulesFromManifest(await this.fetchChirpManifest(), DEFAULT_CHIRP_REVISION);
    },
    getRuntimeInfo() {
      return {
        chirpRevision: DEFAULT_CHIRP_REVISION,
        chirpSourceKind: "bundle",
        chirpPackageDir: String(chirpPackageDir),
        driverSet: selectedDriverSet,
      };
    },
  };
}

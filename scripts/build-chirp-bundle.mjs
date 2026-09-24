// Builds the CHIRP archive the runtime mounts into Pyodide at boot.
//
// The browser used to fetch CHIRP module by module from jsDelivr, through a
// meta-path finder that suspended the interpreter on every first import. This
// script replaces that with one zip of the pinned chirp/chirp package, built
// from the submodule and served from our own origin, plus a small manifest
// naming the pin, the driver modules inside and the archive's size. Both are
// named after the pin rather than a content hash: the URL is immutable on
// GitHub Pages (a pin bump is a new name) without the build having to learn a
// new hashing rule, and the same pin always produces the same bytes -- the zip
// carries no timestamps, so a rebuild of an unchanged submodule is
// byte-identical.
//
// Only what the runtime can import goes in. The excluded directories were
// checked by grepping every import in chirp/chirp/*.py and chirp/chirp/drivers
// for chirp.cli, chirp.sources and chirp.wxui (none), and for share/,
// stock_configs/ and locale/ reads at import time (none: chirp.platform looks
// for share/ only from the desktop frontend); tests/build/chirp-bundle.mjs
// keeps that check alive on every pin bump.
//
// Usage: node scripts/build-chirp-bundle.mjs
// Writes web/chirp/chirp-<pin>.zip and web/chirp/chirp-<pin>.json. The
// functions are exported so the Node test harness (tests/support/
// chirp-bundle-source.mjs) can build the same archive in-process from the
// same submodule instead of faking a fetch.

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";

import {
  CHIRP_BUNDLE_DIR,
  chirpBundleFileNames,
  DEFAULT_CHIRP_REVISION,
} from "../web/js/python-sources.mjs";

const execFileAsync = promisify(execFile);

// Directories under chirp/chirp that nothing the runtime imports reaches:
// the desktop frontend, its CLI, the repeater-directory clients, translations
// and the desktop's icons and stock configs.
export const CHIRP_BUNDLE_EXCLUDED_DIRS = Object.freeze([
  "__pycache__",
  "cli",
  "locale",
  "share",
  "sources",
  "stock_configs",
  "wxui",
]);

// The package directory of a CHIRP checkout: either the directory itself or
// its chirp/ child, whichever holds __init__.py and drivers/.
export async function resolveChirpPackageDir(inputDir) {
  const candidate = path.resolve(inputDir);
  for (const dir of [candidate, path.join(candidate, "chirp")]) {
    try {
      await readFile(path.join(dir, "__init__.py"));
      await readdir(path.join(dir, "drivers"));
      return dir;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error(
    `Invalid CHIRP source dir: ${candidate}. Expected dir containing __init__.py and drivers/`,
  );
}

// Every file the archive carries, as archive-relative POSIX paths under
// chirp/ with their bytes, sorted so the archive is reproducible.
export async function collectChirpBundleFiles(chirpPackageDir) {
  const excluded = new Set(CHIRP_BUNDLE_EXCLUDED_DIRS);
  const files = [];
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) {
          await walk(path.join(dir, entry.name), entryRel);
        }
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push({
          archivePath: `chirp/${entryRel}`,
          bytes: await readFile(path.join(dir, entry.name)),
        });
      }
    }
  }
  await walk(chirpPackageDir, "");
  files.sort((a, b) => (a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0));
  return files;
}

// The driver module names an archive file list carries: every
// chirp/drivers/<name>.py that is not a dunder, sorted.
export function driverModulesFromFiles(files) {
  return files
    .map((file) => file.archivePath.match(/^chirp\/drivers\/([A-Za-z0-9_]+)\.py$/)?.[1])
    .filter((name) => name && !name.startsWith("__"))
    .sort();
}

// A DOS date/time of 1980-01-01 00:00, the earliest a zip can express. Fixed
// so the archive bytes depend only on the files, never on when it was built.
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = (1 << 5) | 1;

// Pack entries into a zip with deflate compression. Written here rather than
// taken from a dependency because the format is small (three record types)
// and Node ships both halves of it: deflateRawSync and crc32. No data
// descriptors or zip64, since the archive is a few thousand files at most.
export function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { archivePath, bytes } of entries) {
    const name = Buffer.from(archivePath, "utf8");
    const data = Buffer.from(bytes);
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(ZIP_DOS_TIME, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // central directory disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, ...centralParts, end]);
}

// Build the archive and its manifest from a CHIRP package directory. The
// manifest is what the runtime reads instead of listing drivers itself: the
// pin it was built from, the driver modules inside, and the sizes that let a
// deploy be sanity-checked without opening the zip.
export async function buildChirpBundle({ chirpPackageDir, chirpRevision }) {
  const files = await collectChirpBundleFiles(chirpPackageDir);
  const archive = createZipArchive(files);
  const manifest = {
    chirpRevision,
    archive: chirpBundleFileNames(chirpRevision).archive,
    drivers: driverModulesFromFiles(files),
    fileCount: files.length,
    sourceBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    archiveBytes: archive.length,
  };
  return { archive, manifest, files };
}

// Write the archive and manifest under outputDir with their pin-derived
// names, returning where they landed.
export async function writeChirpBundle({ chirpPackageDir, chirpRevision, outputDir }) {
  const { archive, manifest } = await buildChirpBundle({ chirpPackageDir, chirpRevision });
  const names = chirpBundleFileNames(chirpRevision);
  await mkdir(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, names.archive);
  const manifestPath = path.join(outputDir, names.manifest);
  await writeFile(archivePath, archive);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 0)}\n`, "utf8");
  return { archivePath, manifestPath, manifest };
}

// The submodule's checked-out revision, so a drifted checkout cannot be
// published under the pinned name; "local" when the directory is not a git
// checkout at all (a WEBCHIRP_CHIRP_DIR export, say).
async function resolveChirpRevision(chirpPackageDir) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", chirpPackageDir, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "local";
  }
}

async function main() {
  const repoRoot = process.cwd();
  const chirpPackageDir = await resolveChirpPackageDir(
    process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp"),
  );
  const checkedOut = await resolveChirpRevision(chirpPackageDir);
  // Same rule as scripts/build-catalog.mjs: the archive is named after the
  // pin, so building it from any other checkout would publish the wrong
  // sources under an immutable URL.
  if (checkedOut !== "local" && checkedOut !== DEFAULT_CHIRP_REVISION) {
    throw new Error(
      `CHIRP source is at revision ${checkedOut} but the runtime pin `
      + `(DEFAULT_CHIRP_REVISION in web/js/python-sources.mjs) is ${DEFAULT_CHIRP_REVISION}. `
      + "Check out the pinned revision in chirp/ or update the pin first.",
    );
  }
  const { archivePath, manifest } = await writeChirpBundle({
    chirpPackageDir,
    chirpRevision: DEFAULT_CHIRP_REVISION,
    outputDir: path.join(repoRoot, "web", CHIRP_BUNDLE_DIR),
  });
  console.log(
    `Wrote ${manifest.fileCount} CHIRP files (${manifest.drivers.length} driver modules, `
    + `${manifest.sourceBytes} bytes) as ${manifest.archiveBytes} bytes to `
    + `${path.relative(repoRoot, archivePath)}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

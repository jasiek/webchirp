// The CHIRP archive is what the browser mounts instead of fetching modules
// one by one, so what it contains decides which radios exist at runtime. These
// cases build it in-process from the submodule -- the same function the deploy
// and the Pyodide test harness use -- and pin what must hold on every pin
// bump: every driver on disk is inside and named in the manifest, the desktop
// trees stay out, nothing inside imports what was left out, and the bytes are
// reproducible so the pin-named URL really is immutable.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

import {
  buildChirpBundle,
  CHIRP_BUNDLE_EXCLUDED_DIRS,
  collectChirpBundleFiles,
  createZipArchive,
  resolveChirpPackageDir,
} from "../../scripts/build-chirp-bundle.mjs";
import {
  chirpBundleFileNames,
  DEFAULT_CHIRP_REVISION,
} from "../../web/js/python-sources.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

const chirpPackageDir = await resolveChirpPackageDir(
  process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp"),
);

// Built once: every case reads the same archive, and deflating the drivers is
// the slow part.
const bundle = await buildChirpBundle({ chirpPackageDir, chirpRevision: DEFAULT_CHIRP_REVISION });

// Walk a zip's central directory and inflate each entry, independently of the
// writer under test, so the format check is not the writer checking itself.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end-of-central-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory signature");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header of ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("the manifest names every driver module in chirp/drivers", () => {
  const onDisk = readdirSync(path.join(chirpPackageDir, "drivers"))
    .filter((name) => /^[A-Za-z0-9_]+\.py$/.test(name) && !name.startsWith("__"))
    .map((name) => name.replace(/\.py$/, ""))
    .sort();
  assert.ok(onDisk.length > 150, `expected the whole driver tree, found ${onDisk.length}`);
  assert.deepEqual(bundle.manifest.drivers, onDisk);
  assert.equal(bundle.manifest.chirpRevision, DEFAULT_CHIRP_REVISION);
  assert.equal(bundle.manifest.archive, chirpBundleFileNames(DEFAULT_CHIRP_REVISION).archive);
  assert.equal(bundle.manifest.fileCount, bundle.files.length);
  assert.equal(bundle.manifest.archiveBytes, bundle.archive.length);
  assert.equal(
    bundle.manifest.sourceBytes,
    bundle.files.reduce((sum, file) => sum + file.bytes.length, 0),
  );
});

test("the archive holds the package and its drivers and nothing from the excluded trees", () => {
  const entries = readZip(bundle.archive);
  assert.equal(entries.size, bundle.files.length);
  for (const file of bundle.files) {
    assert.ok(entries.has(file.archivePath), `${file.archivePath} missing from the archive`);
    assert.deepEqual(entries.get(file.archivePath), file.bytes, `${file.archivePath} bytes`);
  }
  // The package root and the drivers package, so both import as packages.
  assert.ok(entries.has("chirp/__init__.py"));
  assert.ok(entries.has("chirp/drivers/__init__.py"));
  assert.ok(entries.has("chirp/chirp_common.py"));
  for (const name of entries.keys()) {
    assert.match(name, /^chirp\/(?:[A-Za-z0-9_]+|drivers\/[A-Za-z0-9_]+)\.py$/, name);
    const [, top] = name.split("/");
    assert.ok(!CHIRP_BUNDLE_EXCLUDED_DIRS.includes(top), `${name} comes from an excluded tree`);
  }
  // Guard the exclusion list against a submodule that grows a directory the
  // list does not know: every directory on disk is either shipped or named.
  for (const entry of readdirSync(chirpPackageDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      assert.ok(
        entry.name === "drivers" || CHIRP_BUNDLE_EXCLUDED_DIRS.includes(entry.name),
        `chirp/${entry.name}/ is neither shipped nor listed in CHIRP_BUNDLE_EXCLUDED_DIRS`,
      );
    }
  }
});

// The exclusions are safe only while nothing shipped imports what was left
// out. This is the grep the exclusion list was made from, kept running so a
// driver that starts importing chirp.sources on the next pin fails here and
// not in a user's browser.
test("nothing in the archive imports from an excluded tree", () => {
  const excluded = CHIRP_BUNDLE_EXCLUDED_DIRS.filter((name) => name !== "__pycache__");
  const importPattern = new RegExp(
    `^\\s*(?:from\\s+chirp\\.(?:${excluded.join("|")})\\b|from\\s+chirp\\s+import\\s+[^\\n]*\\b(?:${excluded.join("|")})\\b|import\\s+chirp\\.(?:${excluded.join("|")})\\b)`,
    "m",
  );
  const offenders = bundle.files
    .filter((file) => importPattern.test(file.bytes.toString("utf8")))
    .map((file) => file.archivePath);
  assert.deepEqual(offenders, []);
});

test("the same tree builds to the same bytes", async () => {
  const again = await buildChirpBundle({ chirpPackageDir, chirpRevision: DEFAULT_CHIRP_REVISION });
  assert.deepEqual(again.archive, bundle.archive);
  assert.deepEqual(again.manifest, bundle.manifest);
});

test("the zip writer produces entries Python-compatible readers can inflate", () => {
  const archive = createZipArchive([
    { archivePath: "chirp/a.py", bytes: Buffer.from("A = 1\n") },
    { archivePath: "chirp/drivers/b.py", bytes: Buffer.alloc(0) },
  ]);
  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()], ["chirp/a.py", "chirp/drivers/b.py"]);
  assert.equal(entries.get("chirp/a.py").toString("utf8"), "A = 1\n");
  assert.equal(entries.get("chirp/drivers/b.py").length, 0);
});

test("the built archive is what web/chirp serves when it has been built", () => {
  // Not a required precondition -- the file is generated -- but when it is
  // there it must be this pin's bytes, or the dev server and the tests would
  // disagree about what a driver is.
  const names = chirpBundleFileNames(DEFAULT_CHIRP_REVISION);
  let shipped;
  try {
    shipped = readFileSync(path.join(repoRoot, "web", "chirp", names.archive));
  } catch {
    return;
  }
  assert.deepEqual(shipped, bundle.archive, "run npm run build:chirp to refresh web/chirp");
});

test("collectChirpBundleFiles walks nothing but .py files", async () => {
  const files = await collectChirpBundleFiles(chirpPackageDir);
  assert.ok(files.every((file) => file.archivePath.endsWith(".py")));
  const sorted = files.map((file) => file.archivePath);
  assert.deepEqual(sorted, [...sorted].sort());
});

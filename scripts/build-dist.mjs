import { createHash } from "node:crypto";
import { access, cp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const WEB_DIR = path.join(ROOT, "web");
const HASHED_EXTS = new Set([".js", ".css", ".py"]);
const REWRITE_EXTS = new Set([".html", ".js", ".css"]);
const REQUIRED_WEB_FILES = ["js/datasources.js"];

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

function rewriteText(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) {
    out = out.split(from).join(to);
  }
  return out;
}

function makePerFileRelativeReplacements(filePath, assetPairs) {
  const fileDir = path.dirname(filePath);
  const replacements = [];
  for (const pair of assetPairs) {
    const oldAbs = path.join(DIST_DIR, pair.oldRel);
    const newAbs = path.join(DIST_DIR, pair.newRel);
    let oldRef = toPosix(path.relative(fileDir, oldAbs));
    let newRef = toPosix(path.relative(fileDir, newAbs));
    if (!oldRef.startsWith(".")) {
      oldRef = `./${oldRef}`;
      newRef = `./${newRef}`;
    }
    replacements.push([oldRef, newRef]);
  }
  return replacements;
}

async function main() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await cp(WEB_DIR, DIST_DIR, {
    recursive: true,
    filter: (src) => path.basename(src) !== "__pycache__",
  });

  for (const relPath of REQUIRED_WEB_FILES) {
    const expectedPath = path.join(DIST_DIR, relPath);
    try {
      await access(expectedPath);
    } catch {
      throw new Error(`Missing required dist asset: ${toPosix(path.relative(DIST_DIR, expectedPath))}`);
    }
  }

  const webFiles = await walkFiles(DIST_DIR);
  const replacements = [];
  const assetPairs = [];

  for (const filePath of webFiles) {
    const ext = path.extname(filePath);
    if (!HASHED_EXTS.has(ext)) {
      continue;
    }

    const content = await readFile(filePath);
    const hash = contentHash(content);
    const dir = path.dirname(filePath);
    const stem = path.basename(filePath, ext);
    const hashedName = `${stem}.${hash}${ext}`;
    const hashedPath = path.join(dir, hashedName);

    await rename(filePath, hashedPath);

    const oldRel = toPosix(path.relative(DIST_DIR, filePath));
    const newRel = toPosix(path.relative(DIST_DIR, hashedPath));
    assetPairs.push({ oldRel, newRel });
    replacements.push([`./${oldRel}`, `./${newRel}`]);
    replacements.push([`/${oldRel}`, `/${newRel}`]);
  }

  replacements.sort((a, b) => b[0].length - a[0].length);

  const distFiles = await walkFiles(DIST_DIR);
  for (const filePath of distFiles) {
    const ext = path.extname(filePath);
    if (!REWRITE_EXTS.has(ext)) {
      continue;
    }
    const original = await readFile(filePath, "utf8");
    const localReplacements = makePerFileRelativeReplacements(filePath, assetPairs);
    const allReplacements = [...replacements, ...localReplacements]
      .sort((a, b) => b[0].length - a[0].length);
    const rewritten = rewriteText(original, allReplacements);
    if (rewritten !== original) {
      await writeFile(filePath, rewritten, "utf8");
    }
  }

  const buildHash = contentHash(JSON.stringify([...replacements].sort()));
  const manifest = {
    buildHash,
    generatedAt: new Date().toISOString(),
    assets: Object.fromEntries(replacements),
  };
  await writeFile(
    path.join(DIST_DIR, "asset-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

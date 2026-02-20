import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const DIST_WEB_DIR = path.join(DIST_DIR, "web");
const HASHED_EXTS = new Set([".js", ".css", ".py"]);
const REWRITE_EXTS = new Set([".html", ".js", ".css"]);

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

async function main() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await cp(path.join(ROOT, "web"), DIST_WEB_DIR, { recursive: true });
  await cp(path.join(ROOT, "index.html"), path.join(DIST_DIR, "index.html"));

  const webFiles = await walkFiles(DIST_WEB_DIR);
  const replacements = [];

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

    const oldRel = toPosix(path.relative(DIST_WEB_DIR, filePath));
    const newRel = toPosix(path.relative(DIST_WEB_DIR, hashedPath));
    replacements.push([`/web/${oldRel}`, `/web/${newRel}`]);
  }

  replacements.sort((a, b) => b[0].length - a[0].length);

  const distFiles = await walkFiles(DIST_DIR);
  for (const filePath of distFiles) {
    const ext = path.extname(filePath);
    if (!REWRITE_EXTS.has(ext)) {
      continue;
    }
    const original = await readFile(filePath, "utf8");
    const rewritten = rewriteText(original, replacements);
    if (rewritten !== original) {
      await writeFile(filePath, rewritten, "utf8");
    }
  }

  const buildHash = contentHash(
    JSON.stringify([...replacements].sort((a, b) => a[0].localeCompare(b[0]))),
  );

  const rootIndexPath = path.join(DIST_DIR, "index.html");
  const rootIndex = await readFile(rootIndexPath, "utf8");
  const target = `/web/index.html?v=${buildHash}`;
  const patchedRoot = rootIndex
    .replace('content="0; url=/web/"', `content="0; url=${target}"`)
    .replace("window.location.replace('/web/index.html');", `window.location.replace('${target}');`)
    .replace('href="/web/">/web/</a>', `href="${target}">${target}</a>`);
  await writeFile(rootIndexPath, patchedRoot, "utf8");

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

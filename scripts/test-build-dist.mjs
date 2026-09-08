// Pins the contract that content-hashed URLs exist to provide: a given hashed
// URL always names the same bytes. It is easy to lose without noticing, because
// every single build is internally consistent — the damage only appears across
// two deploys, when a browser holding a cached importer asks for a dependency
// name the new build no longer emits (issue #114). So every case here builds
// twice and compares, rather than inspecting one build.
//
// The real script runs as a child process against a throwaway web/ tree, so
// what is under test is exactly what CI runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot, webDir } from "./test-support/repo-paths.mjs";
import { withTempDir } from "./test-support/temp-dir.mjs";

const SCRIPT = path.join(repoRoot, "scripts", "build-dist.mjs");
// Matches build-dist.mjs: name.<10 hex>.ext.
const HASHED_NAME_RE = /\.([0-9a-f]{10})\.[a-z]+$/;

// The files build-dist.mjs refuses to build without; their contents are never
// read, only their presence.
const REQUIRED_FILES = {
  "js/datasources.js": "export const DATASOURCES = [];\n",
  "manifest.webmanifest": "{}\n",
  "images/icon-192.png": "",
  "images/icon-512.png": "",
  "images/icon-maskable-512.png": "",
  "images/apple-touch-icon.png": "",
};

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 10);
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

function runBuild(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT], { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`build-dist failed: ${stderr || stdout}`));
        return;
      }
      resolve();
    });
  });
}

// Build `files` into a temp repo and return every emitted path with its bytes.
// asset-manifest.json is excluded: it carries a timestamp, so it differs between
// any two builds by design and is not a content-hashed asset.
async function build(files) {
  return withTempDir("build-dist-", async (dir) => {
    await writeTree(path.join(dir, "web"), { ...REQUIRED_FILES, ...files });
    await runBuild(dir);
    const dist = path.join(dir, "dist");
    const emitted = new Map();
    for (const rel of await walk(dist)) {
      if (rel === "asset-manifest.json") {
        continue;
      }
      emitted.set(rel, await readFile(path.join(dist, rel)));
    }
    return emitted;
  });
}

// The invariant itself, over two builds of trees that differ somehow.
function assertNoUrlNamesTwoContents(first, second) {
  for (const [rel, bytes] of first) {
    if (!HASHED_NAME_RE.test(path.basename(rel)) || !second.has(rel)) {
      continue;
    }
    assert.deepEqual(
      second.get(rel),
      bytes,
      `${rel} names different bytes in the two builds; a cached client would keep the old one`,
    );
  }
}

function hashedNameOf(emitted, stem) {
  const match = [...emitted.keys()].find(
    (rel) => rel.startsWith(`${stem}.`) && HASHED_NAME_RE.test(path.basename(rel)),
  );
  assert.ok(match, `no hashed asset emitted for ${stem}`);
  return match;
}

// One importer, one dependency it imports, one page loading the importer, plus a
// stylesheet and a Python file so every hashed extension is covered.
function appTree(leafBody) {
  return {
    "index.html":
      '<!doctype html><link rel="stylesheet" href="./styles.css">' +
      '<script type="module" src="./js/app.js"></script>\n',
    "styles.css": "/* see web/js/app.js */\nbody { margin: 0; }\n",
    "js/app.js":
      'import { leaf } from "./ui/leaf.js";\n' +
      'export const bridgePath = "./python/bridge.py";\n' +
      "export const value = leaf;\n",
    "js/ui/leaf.js": leafBody,
    "python/bridge.py": "VALUE = 1\n",
  };
}

test("a dependency-only change moves the importer to a new URL", async () => {
  const before = await build(appTree("export const leaf = 1;\n"));
  const after = await build(appTree("export const leaf = 1;\n// changed\n"));

  assertNoUrlNamesTwoContents(before, after);

  const leafBefore = hashedNameOf(before, "js/ui/leaf");
  const leafAfter = hashedNameOf(after, "js/ui/leaf");
  assert.notEqual(leafAfter, leafBefore, "the changed dependency should be renamed");

  const appBefore = hashedNameOf(before, "js/app");
  const appAfter = hashedNameOf(after, "js/app");
  assert.notEqual(
    appAfter,
    appBefore,
    "the importer's bytes changed with its dependency's name, so its URL must change too",
  );
  assert.ok(
    after.get(appAfter).toString("utf8").includes(path.basename(leafAfter)),
    "the importer should import the new dependency name",
  );
});

test("every hashed name is the digest of the bytes served under it", async () => {
  const emitted = await build(appTree("export const leaf = 1;\n"));
  let checked = 0;
  for (const [rel, bytes] of emitted) {
    const match = path.basename(rel).match(HASHED_NAME_RE);
    if (!match) {
      continue;
    }
    checked += 1;
    assert.equal(digest(bytes), match[1], `${rel} is not named after its own content`);
  }
  assert.ok(checked >= 4, "expected the fixture to emit hashed js, css and py assets");
});

test("an unchanged tree builds to byte-identical assets", async () => {
  const first = await build(appTree("export const leaf = 1;\n"));
  const second = await build(appTree("export const leaf = 1;\n"));
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  assertNoUrlNamesTwoContents(first, second);
});

// A module graph with a cycle has no fixed point — each member's bytes name the
// others — so members share one group name. The invariant still has to hold.
function cyclicTree(extra) {
  return {
    "index.html": '<script type="module" src="./js/a.js"></script>\n',
    "js/a.js": `import { b } from "./b.js";\nexport const a = b;\n${extra}`,
    "js/b.js": 'import { a } from "./a.js";\nexport const b = () => a;\n',
  };
}

test("an import cycle still emits, under one name per cycle that stays immutable", async () => {
  const before = await build(cyclicTree(""));
  const after = await build(cyclicTree("// changed\n"));

  assertNoUrlNamesTwoContents(before, after);

  const aBefore = hashedNameOf(before, "js/a");
  const bBefore = hashedNameOf(before, "js/b");
  assert.equal(
    path.basename(aBefore).match(HASHED_NAME_RE)[1],
    path.basename(bBefore).match(HASHED_NAME_RE)[1],
    "cycle members share one group digest",
  );
  assert.ok(
    before.get(aBefore).toString("utf8").includes(path.basename(bBefore)),
    "the cycle's imports are still rewritten to the emitted names",
  );
  assert.notEqual(hashedNameOf(after, "js/a"), aBefore, "changing a member renames the group");
});

test("references are matched on path boundaries, not as substrings", async () => {
  const emitted = await build({
    "index.html": '<script type="module" src="./js/app.js"></script>\n',
    // "web/js/leaf.js" in prose contains "/js/leaf.js"; "../leaf.js" contains
    // "./leaf.js". Neither is a reference to anything this file imports.
    "js/app.js":
      '// leaf lives in web/js/leaf.js\nimport { leaf } from "./leaf.js";\nexport const v = leaf;\n',
    "js/leaf.js": '// the sibling module is web/js/ui/leaf.js\nexport const leaf = 1;\n',
    "js/ui/leaf.js": 'import { leaf } from "../leaf.js";\nexport const uiLeaf = leaf;\n',
  });

  const app = emitted.get(hashedNameOf(emitted, "js/app")).toString("utf8");
  assert.match(app, /web\/js\/leaf\.js$/m, "a module path in prose must survive untouched");
  assert.match(app, /from "\.\/leaf\.[0-9a-f]{10}\.js"/, "the real import must be rewritten");

  const uiLeaf = emitted.get(hashedNameOf(emitted, "js/ui/leaf")).toString("utf8");
  assert.match(
    uiLeaf,
    /from "\.\.\/leaf\.[0-9a-f]{10}\.js"/,
    "a parent-relative import must not be mistaken for a sibling one",
  );
  assert.ok(
    uiLeaf.includes(path.basename(hashedNameOf(emitted, "js/leaf"))),
    "../leaf.js must resolve to js/leaf.js, not to js/ui/leaf.js",
  );
});

// A path-shaped token naming a source file, anchored the same way build-dist.mjs
// anchors a reference so the two agree on what counts as one.
const PROSE_PATH_RE =
  /(?<![\w./-])([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:js|mjs|py|css))(?![\w-])/g;

// Best-effort comment text on one line: what follows "//", block-comment bodies
// and HTML comments. Over-inclusive by design — a path in code is canonical too
// or the build would not resolve it.
function proseOn(line) {
  let prose = "";
  const slash = line.indexOf("//");
  if (slash >= 0 && !/["'`]\s*$/.test(line.slice(0, slash))) {
    prose += line.slice(slash);
  }
  if (/^\s*[*]/.test(line) || line.includes("/*") || line.includes("<!--")) {
    prose += line;
  }
  return prose;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "typings") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(js|css|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// The convention the boundary rule exists to make safe. A module path in prose is
// written from the repo root ("web/js/ui/format.js"), never dist-relative
// ("./js/ui/format.js", which the build cannot tell from a real import and does
// rewrite) and never partial ("ui/format.js", which resolves from nowhere).
// Requiring it to resolve is also what catches a path left behind by a rename.
test("module paths named in comments are canonical and resolve", () => {
  const offenders = [];
  for (const file of sourceFiles(webDir)) {
    const rel = path.relative(repoRoot, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const [, token] of proseOn(line).matchAll(PROSE_PATH_RE)) {
          if (!existsSync(path.join(repoRoot, token))) {
            offenders.push(`${rel}:${i + 1} names ${token}`);
          }
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    "write module paths from the repo root, and update them when a module moves",
  );
});

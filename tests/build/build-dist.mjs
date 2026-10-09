// Pins the contract that content-hashed URLs exist to provide: a given hashed
// URL always names the same bytes. It is easy to lose without noticing, because
// every single build is internally consistent — the damage only appears across
// two deploys, when a browser holding a cached importer asks for a dependency
// name the new build no longer emits (issue #114). So most cases here build
// twice and compare, rather than inspecting one build.
//
// The real script runs as a child process against a throwaway web/ tree, so
// what is under test is exactly what CI runs: esbuild bundling the pages'
// module scripts and stylesheets, plus the Python hashing and the page
// rewrite scripts/build-dist.mjs does itself.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot, webDir } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";
import {
  CHIRP_BUNDLE_DIR,
  chirpBundleFileNames,
  DEFAULT_CHIRP_REVISION,
  EXTRA_DRIVER_RELATIVE_FILES,
  RUNTIME_PYTHON_FILES,
} from "../../web/js/python-sources.ts";
import { RUNTIME_PYTHON_URLS } from "../../web/js/runtime-python-urls.ts";

const SCRIPT = path.join(repoRoot, "scripts", "build-dist.mjs");
// esbuild's names (name.<8 base32>.js, .css, and .js.map beside each) and the
// Python files' (name.<10 hex>.py), the two shapes build-dist.mjs emits.
const HASHED_NAME_RE = /\.([A-Z2-7]{8}|[0-9a-f]{10})\.[a-z]+(?:\.map)?$/;
const PYTHON_NAME_RE = /\.([0-9a-f]{10})\.py$/;

// The CHIRP archive and manifest for the pinned revision, as dist-relative
// paths. build-dist.mjs requires them and lists them in the asset manifest.
const CHIRP_BUNDLE_FILES = Object.values(chirpBundleFileNames(DEFAULT_CHIRP_REVISION))
  .map((name) => `${CHIRP_BUNDLE_DIR}/${name}`);

// The files build-dist.mjs refuses to build without; their contents are never
// read, only their presence.
const REQUIRED_FILES = {
  "manifest.webmanifest": "{}\n",
  "images/icon-192.png": "",
  "images/icon-512.png": "",
  "images/icon-maskable-512.png": "",
  "images/apple-touch-icon.png": "",
  "images/screenshot-narrow.png": "",
  "images/screenshot-wide.png": "",
  ...Object.fromEntries(CHIRP_BUNDLE_FILES.map((rel) => [rel, "not a real archive\n"])),
};

// The digest build-dist.mjs names Python files with, so a name can be checked
// against the bytes served under it.
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

// Run the real build against a throwaway repo, surfacing its output on failure
// — a build that dies silently would otherwise look like an empty dist/.
function runBuild(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT], { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`build-dist failed: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
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
  let compared = 0;
  for (const [rel, bytes] of first) {
    if (!HASHED_NAME_RE.test(path.basename(rel)) || !second.has(rel)) {
      continue;
    }
    compared += 1;
    assert.deepEqual(
      second.get(rel),
      bytes,
      `${rel} names different bytes in the two builds; a cached client would keep the old one`,
    );
  }
  return compared;
}

// Every emitted path for a source stem, whose hash is unknown to the test by
// design: asserting on a literal hash would pin the digest, not the invariant.
// Source maps are left out; they travel with their file.
function hashedNamesOf(emitted, stem) {
  return [...emitted.keys()].filter(
    (rel) => rel.startsWith(`${stem}.`) && !rel.endsWith(".map") && HASHED_NAME_RE.test(path.basename(rel)),
  );
}

function hashedNameOf(emitted, stem) {
  const matches = hashedNamesOf(emitted, stem);
  assert.equal(matches.length, 1, `expected one hashed asset for ${stem}, got ${matches.join(", ") || "none"}`);
  return matches[0];
}

function text(emitted, rel) {
  return emitted.get(rel).toString("utf8");
}

// Two pages, each loading its own entry, both entries importing one module: the
// shape that makes esbuild split the shared module into a chunk of its own,
// which is the case where a dependency-only change has to rename importers
// that did not change. Plus a stylesheet and a Python file, so every kind of
// hashed output is covered.
function appTree(leafBody) {
  return {
    "index.html":
      '<!doctype html><link rel="stylesheet" href="./styles.css">' +
      '<script type="module" src="./js/app.js"></script>\n',
    "about.html": '<!doctype html><script type="module" src="./js/about.js"></script>\n',
    "styles.css": "body { margin: 0; }\n",
    "js/app.js":
      'import { leaf } from "./ui/leaf.js";\n' +
      "export const value = leaf;\n",
    "js/about.js": 'import { leaf } from "./ui/leaf.js";\nconsole.log(leaf);\n',
    "js/ui/leaf.js": leafBody,
    "python/bridge.py": "VALUE = 1\n",
  };
}

test("a dependency-only change moves every importer to a new URL", async () => {
  const before = await build(appTree("export const leaf = 1;\n"));
  const after = await build(appTree("export const leaf = 2;\n"));

  assertNoUrlNamesTwoContents(before, after);

  const chunkBefore = hashedNameOf(before, "js/chunk");
  const chunkAfter = hashedNameOf(after, "js/chunk");
  assert.notEqual(chunkAfter, chunkBefore, "the chunk holding the changed module should be renamed");

  for (const stem of ["js/app", "js/about"]) {
    const entryBefore = hashedNameOf(before, stem);
    const entryAfter = hashedNameOf(after, stem);
    assert.notEqual(
      entryAfter,
      entryBefore,
      `${stem}'s bytes changed with its dependency's name, so its URL must change too`,
    );
    assert.ok(
      text(after, entryAfter).includes(path.basename(chunkAfter)),
      `${stem} should import the new chunk name`,
    );
  }
});

test("a module bundled into its importer renames the importer when it changes", async () => {
  const tree = (body) => ({
    "index.html": '<script type="module" src="./js/app.js"></script>\n',
    "js/app.js": 'import { errors } from "./errors.mjs";\nexport const value = errors;\n',
    "js/errors.mjs": body,
  });
  const before = await build(tree("export const errors = 1;\n"));
  const after = await build(tree("export const errors = 2;\n"));
  assertNoUrlNamesTwoContents(before, after);
  assert.notEqual(hashedNameOf(after, "js/app"), hashedNameOf(before, "js/app"));
});

// The sources are TypeScript: a page names its .ts entry, the entry imports
// other .ts files by their .ts names, and what ships is JavaScript under a
// hashed .js name with the page pointed at it.
test("a TypeScript entry is bundled with its types stripped", async () => {
  const emitted = await build({
    "index.html": '<script type="module" src="./js/app.ts"></script>\n',
    "js/app.ts":
      'import { leaf } from "./leaf.ts";\n'
      + 'import type { Leaf } from "./leaf.ts";\n'
      + "export const value: Leaf = leaf;\n",
    "js/leaf.ts": "export type Leaf = number;\nexport const leaf: Leaf = 41 + 1;\n",
  });
  const entry = hashedNameOf(emitted, "js/app");
  assert.match(entry, /\.js$/);
  const code = text(emitted, entry);
  assert.match(code, /41 \+ 1/);
  assert.doesNotMatch(code, /: Leaf|import type/);
  assert.ok(text(emitted, "index.html").includes(`src="./${entry}"`));
  assert.deepEqual([...emitted.keys()].filter((rel) => rel.endsWith(".ts")), [], "no .ts file ships");
});

test("no source module or stylesheet ships under its own name", async () => {
  const emitted = await build(appTree("export const leaf = 1;\n"));
  const unhashed = [...emitted.keys()].filter(
    (rel) => /\.(?:m?js|css|py)$/.test(rel) && !HASHED_NAME_RE.test(path.basename(rel)),
  );
  assert.deepEqual(unhashed, [], "every script, stylesheet and Python file is served under a hashed name");
  for (const rel of emitted.keys()) {
    if (/\.(?:js|css)$/.test(rel)) {
      assert.ok(emitted.has(`${rel}.map`), `${rel} should have its source map beside it`);
    }
  }
});

test("every Python file is named after the bytes served under it", async () => {
  const emitted = await build(appTree("export const leaf = 1;\n"));
  const python = [...emitted.keys()].filter((rel) => PYTHON_NAME_RE.test(rel));
  assert.equal(python.length, 1, "expected the fixture's one Python file");
  for (const rel of python) {
    assert.equal(digest(emitted.get(rel)), rel.match(PYTHON_NAME_RE)[1], `${rel} is not named after its own content`);
  }
});

test("an unchanged tree builds to byte-identical assets", async () => {
  const first = await build(appTree("export const leaf = 1;\n"));
  const second = await build(appTree("export const leaf = 1;\n"));
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  assert.ok(assertNoUrlNamesTwoContents(first, second) >= 8, "expected entries, a chunk, css, maps and Python");
});

// The archive is immutable by pin, not by digest: it must reach dist/ under
// its own name, unhashed, and be listed in the asset manifest so retention
// (scripts/retain-deployed-assets.mjs) carries the previous pin forward. Every
// hashed output is listed the same way.
test("the CHIRP archive and every hashed output are listed for retention", async () => {
  await withTempDir("build-dist-", async (dir) => {
    await writeTree(path.join(dir, "web"), { ...REQUIRED_FILES, ...appTree("export const leaf = 1;\n") });
    await runBuild(dir);
    const dist = path.join(dir, "dist");
    for (const rel of CHIRP_BUNDLE_FILES) {
      assert.equal(
        (await readFile(path.join(dist, rel), "utf8")),
        REQUIRED_FILES[rel],
        `${rel} should be copied verbatim`,
      );
    }
    const manifest = JSON.parse(await readFile(path.join(dist, "asset-manifest.json"), "utf8"));
    for (const rel of CHIRP_BUNDLE_FILES) {
      assert.equal(manifest.assets[`./${rel}`], `./${rel}`);
      assert.equal(manifest.assets[`/${rel}`], `/${rel}`);
    }
    const listed = new Set(Object.values(manifest.assets).map((ref) => ref.replace(/^\.?\//, "")));
    const hashed = (await walk(dist)).filter((rel) => HASHED_NAME_RE.test(path.basename(rel)));
    assert.ok(hashed.length >= 8, "expected hashed outputs to list");
    assert.deepEqual(hashed.filter((rel) => !listed.has(rel)), [], "every hashed output must be retainable");
    assert.match(manifest.buildHash, /^[0-9a-f]{10}$/);
  });
});

test("a missing CHIRP archive fails the build", async () => {
  await withTempDir("build-dist-", async (dir) => {
    const files = { ...REQUIRED_FILES, ...appTree("export const leaf = 1;\n") };
    delete files[CHIRP_BUNDLE_FILES[0]];
    await writeTree(path.join(dir, "web"), files);
    await assert.rejects(runBuild(dir), new RegExp(`Missing required dist asset: ${CHIRP_BUNDLE_FILES[0]}`));
  });
});

// A module graph with a cycle is nothing special to a bundler: both members
// land in one output, which still renames when either changes.
test("an import cycle bundles and still renames when a member changes", async () => {
  const cyclicTree = (extra) => ({
    "index.html": '<script type="module" src="./js/a.js"></script>\n',
    "js/a.js": `import { b } from "./b.js";\nexport const a = b;\n${extra}`,
    "js/b.js": 'import { a } from "./a.js";\nexport const b = () => a;\n',
  });
  const before = await build(cyclicTree(""));
  const after = await build(cyclicTree("console.log(a);\n"));
  assertNoUrlNamesTwoContents(before, after);
  assert.notEqual(hashedNameOf(after, "js/a"), hashedNameOf(before, "js/a"), "changing a member renames the bundle");
});

// Pages are rewritten through their tags: each module script's src and each
// stylesheet's href is pointed at the entry's output, relative to the page,
// and nothing else in the page changes -- not a path in a comment, not one in
// a JSON-LD block, not a CDN script.
test("pages point at their entries' outputs and nothing else in them changes", async () => {
  const page = (prefix) =>
    "<!doctype html>\n"
    + `<!-- the app is ${prefix}js/app.js -->\n`
    + `<link rel="stylesheet" href="${prefix}styles.css" />\n`
    + `<script type="application/ld+json">{"url": "${prefix}js/app.js"}</script>\n`
    + '<script type="module" src="https://cdn.example.test/lib.js"></script>\n'
    + `<script type=module src='${prefix}js/app.js'></script>\n`
    + `<p>Load ${prefix}js/app.js by hand.</p>\n`;
  const emitted = await build({
    ...appTree("export const leaf = 1;\n"),
    "index.html": page("./"),
    "radios/model.html": page("../"),
  });
  const app = hashedNameOf(emitted, "js/app");
  const styles = hashedNameOf(emitted, "styles");
  for (const [rel, prefix] of [["index.html", "./"], ["radios/model.html", "../"]]) {
    const html = text(emitted, rel);
    assert.ok(html.includes(`src='${prefix}${app}'`), `${rel} should load ${app}`);
    assert.ok(html.includes(`href="${prefix}${styles}"`), `${rel} should load ${styles}`);
    assert.ok(html.includes(`<!-- the app is ${prefix}js/app.js -->`), "a comment must survive untouched");
    assert.ok(html.includes(`{"url": "${prefix}js/app.js"}`), "JSON-LD must survive untouched");
    assert.ok(html.includes(`Load ${prefix}js/app.js by hand.`), "prose must survive untouched");
    assert.ok(html.includes('src="https://cdn.example.test/lib.js"'), "a CDN script is not ours to rewrite");
  }
});

// Exercise URL resolution through the real build, including a nested decoy
// that would silently be bundled if a site-root URL were joined as a path.
test("nested pages resolve asset URLs from the web root and retain URL suffixes", async () => {
  const emitted = await build({
    "index.html": "<!doctype html>",
    "radios/model.html":
      '<link rel="stylesheet" href="/styles.css?theme=light#sheet">'
      + '<script type="module" src="/js/app.js?version=1#entry"></script>'
      + '<script type="module" src="../js/other%20entry.js?version=2#other"></script>',
    "styles.css": "body { color: red; }",
    "js/app.js": 'console.log("root entry");',
    "js/other entry.js": 'console.log("relative entry");',
    "radios/styles.css": "body { color: blue; }",
    "radios/js/app.js": 'console.log("wrong nested entry");',
  });
  const app = hashedNameOf(emitted, "js/app");
  const styles = hashedNameOf(emitted, "styles");
  const html = text(emitted, "radios/model.html");
  assert.ok(html.includes('../' + app + '?version=1#entry'));
  assert.ok(html.includes('../' + styles + '?theme=light#sheet'));
  assert.match(text(emitted, app), /root entry/);
  assert.doesNotMatch(text(emitted, app), /wrong nested entry/);
  assert.match(text(emitted, styles), /color: red/);
  const otherRef = html.match(/src="([^"]+\?version=2#other)"/)[1];
  const otherPath = decodeURIComponent(new URL(otherRef, "https://build.invalid/radios/model.html").pathname).slice(1);
  assert.match(text(emitted, otherPath), /relative entry/);
});

test("a page loading a module that does not exist fails the build", async () => {
  await withTempDir("build-dist-", async (dir) => {
    await writeTree(path.join(dir, "web"), {
      ...REQUIRED_FILES,
      "index.html": '<script type="module" src="./js/missing.js"></script>\n',
    });
    await assert.rejects(runBuild(dir), /index\.html loads \.\/js\/missing\.js, which does not exist/);
  });
});

test("an inline module script fails the build rather than shipping unbundled", async () => {
  await withTempDir("build-dist-", async (dir) => {
    await writeTree(path.join(dir, "web"), {
      ...REQUIRED_FILES,
      "index.html": '<script type="module">import "./js/app.js";</script>\n',
      "js/app.js": "export const value = 1;\n",
    });
    await assert.rejects(runBuild(dir), /inline module scripts are not bundled/);
  });
});

// The CDN modules stay on the CDN: a static import of one is left for the
// browser, and a dynamic one stays dynamic (lazy) rather than being fetched
// at build time.
test("CDN imports stay external and lazy ones stay dynamic", async () => {
  const emitted = await build({
    "index.html": '<script type="module" src="./js/app.js"></script>\n',
    "js/app.js":
      'import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs";\n'
      + 'const SDK_URL = "https://cdn.jsdelivr.net/npm/@sentry/browser@10.73.0/+esm";\n'
      + "export const sdk = () => import(SDK_URL);\nexport { loadPyodide };\n",
  });
  const app = text(emitted, hashedNameOf(emitted, "js/app"));
  assert.match(app, /from "https:\/\/cdn\.jsdelivr\.net\/pyodide\/v0\.27\.2\/full\/pyodide\.mjs"/);
  assert.match(app, /import\(SDK_URL\)/);
});

// The runtime fetches its Python by URL, so the bundle has to name the hashed
// copies: web/js/runtime-python-urls.ts is replaced in the bundle by a literal
// table of them, while the source keeps naming the unhashed files the dev
// server serves.
test("the bundle fetches each runtime Python file under its hashed name", async () => {
  const emitted = await build({
    ...appTree("export const leaf = 1;\n"),
    "js/app.js":
      'import { RUNTIME_PYTHON_URLS } from "./runtime-python-urls.ts";\n'
      + "export const urls = RUNTIME_PYTHON_URLS;\n",
    "js/runtime-python-urls.ts":
      'export const RUNTIME_PYTHON_URLS = { "bridge.py": "./python/bridge.py" };\n',
    "python/pkg/module.py": "OTHER = 2\n",
  });
  const app = text(emitted, hashedNameOf(emitted, "js/app"));
  for (const rel of ["python/bridge", "python/pkg/module"]) {
    const hashed = hashedNameOf(emitted, rel);
    assert.ok(app.includes(`"./${hashed}"`), `the bundle should name ${hashed}`);
  }
  assert.ok(!app.includes('"./python/bridge.py"'), "the unhashed source URL must not reach the bundle");
});

// Every Python file under web/python, by its path there.
function pythonFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...pythonFiles(full, base));
    } else if (entry.name.endsWith(".py")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

// The build ships every .py under web/python and the browser fetches what
// RUNTIME_PYTHON_FILES and EXTRA_DRIVER_RELATIVE_FILES list, by the URL
// web/js/runtime-python-urls.ts derives from them. The two sets have to be the
// same: a listed file that is not there 404s at boot, and a file that is not
// listed is shipped and never loaded.
test("every runtime Python file is listed, shipped and has a URL", () => {
  const listed = [...RUNTIME_PYTHON_FILES, ...EXTRA_DRIVER_RELATIVE_FILES];
  const shipped = pythonFiles(path.join(webDir, "python"));
  assert.deepEqual(
    shipped.filter((relPath) => !listed.includes(relPath)),
    [],
    "list bridge files in RUNTIME_PYTHON_FILES or drivers in EXTRA_DRIVER_RELATIVE_FILES",
  );
  assert.deepEqual(
    listed.filter((relPath) => !existsSync(path.join(webDir, "python", relPath))),
    [],
    "a listed runtime Python file is missing from web/python",
  );
  assert.deepEqual(Object.keys(RUNTIME_PYTHON_URLS).sort(), [...listed].sort());
  for (const relPath of listed) {
    assert.equal(RUNTIME_PYTHON_URLS[relPath], `./python/${relPath}`);
  }
});

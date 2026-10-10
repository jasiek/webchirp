// Build dist/, the tree GitHub Pages serves (.github/workflows/pages.yml).
//
// JavaScript and CSS go through esbuild. The entry points are whatever the
// pages load -- every local <script type="module" src> and
// <link rel="stylesheet" href> in every HTML file under web/, found by
// parsing the tags rather than listed here -- bundled with code splitting into
// ES modules under content-hashed names, with linked source maps. esbuild
// resolves the imports and names each chunk after its own bytes and the names
// of the chunks it imports, so a dependency-only change renames every
// importer up the graph (issue #114) without this script reading any import
// itself. Each page is then pointed at its entries' hashed outputs from
// esbuild's metafile, by rewriting the src/href attribute of the tag that
// named the source; nothing else in any file is rewritten.
//
// What esbuild does not handle:
//   * The runtime Python files (web/python/**/*.py) are fetched by URL, not
//     imported. Each is copied under name.<10 hex>.py, the hex being its
//     SHA-256, and the bundle learns those URLs from a generated module:
//     web/js/runtime-python-urls.ts is replaced wholesale with a literal table
//     of the hashed URLs (pythonUrlsPlugin below), so the source keeps
//     deriving the unhashed URLs the dev server serves.
//   * The CHIRP archive and manifest (web/chirp/, scripts/build-chirp-bundle.ts)
//     are named after the pin, so they are copied as they are, required, and
//     listed in the asset manifest for retention.
//   * Everything else -- the web manifest and icons, the radio catalogs,
//     version.json, sitemap.xml, robots.txt, favicon -- is copied verbatim.
//   * Pyodide (and its wasm and stdlib, through PYODIDE_INDEX_URL), the
//     Sentry SDK and the web-serial polyfill stay on jsDelivr; their URLs are
//     external, so the bundle never fetches them and the two lazy ones stay
//     dynamic imports.
//   * The service worker (web/sw.ts) is bundled on its own, as a classic
//     script, to dist/sw.js: unhashed and at the root, because a worker
//     controls only pages at or below its URL and the browser updates it by
//     fetching that same URL again.
//
// asset-manifest.json lists every immutable name this build emits, which
// scripts/retain-deployed-assets.ts carries into the next deploy, and under
// "offline" what the service worker caches so the build loads without a
// network (web/js/offline-cache.ts): the root pages and OFFLINE_DATA_FILES
// with the digest of each, every immutable name but the source maps, the
// CDN files (OFFLINE_CDN_URLS), and optional groups: files only some hosts
// use, cached best-effort and only there (OFFLINE_OPTIONAL_GROUPS).
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as esbuild from "esbuild";

import {
  CHIRP_BUNDLE_DIR,
  chirpBundleFileNames,
  DEFAULT_CHIRP_REVISION,
} from "../web/js/python-sources.ts";
import { OFFLINE_CDN_URLS, SENTRY_SDK_MODULES } from "../web/js/cdn-urls.ts";
import { SENTRY_HOSTS } from "../web/js/sentry.ts";
import { errorFields } from "../web/js/error-details.ts";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const WEB_DIR = path.join(ROOT, "web");
const PYTHON_DIR = path.join(WEB_DIR, "python");
// The module whose source names every runtime Python file by its unhashed URL,
// and which the bundle gets in a generated form naming the hashed copies.
const PYTHON_URLS_MODULE = path.join(WEB_DIR, "js", "runtime-python-urls.ts");
// Every bundled JS output lands in this one directory, entries and chunks
// alike, at the depth web/js/ has in the source. A module that resolves a URL
// against import.meta.url (web/js/runtime-rpc.ts reads "../radio-catalog.json"
// that way) then resolves it the same way in whichever chunk it ends up in.
const JS_OUT_DIR = "js";
// The three CDN modules, all on jsDelivr: Pyodide's loader (a static import in
// web/js/runtime-rpc.ts), the Sentry SDK (web/js/sentry.ts) and the
// web-serial polyfill (web/js/webusb-serial.ts), the last two lazy.
const EXTERNAL_URLS = ["https://cdn.jsdelivr.net/*"];
// The CHIRP archive and manifest for the pinned revision. Immutable by name like
// the hashed assets, but named after the pin rather than their content, so they
// are neither hashed nor rewritten here -- only required, and listed in the
// asset manifest so scripts/retain-deployed-assets.ts carries the previous pin
// forward.
const CHIRP_BUNDLE_FILES = Object.values(chirpBundleFileNames(DEFAULT_CHIRP_REVISION))
  .map((name) => `${CHIRP_BUNDLE_DIR}/${name}`);
// Assets whose absence is invisible at runtime until a user notices something
// missing: the manifest and its icons only matter when someone tries to install
// the app to a home screen, which no test page load exercises. (A JS module
// needs no entry here: esbuild fails the build on an import it cannot resolve.)
const REQUIRED_WEB_FILES = [
  "manifest.webmanifest",
  "images/icon-192.png",
  "images/icon-512.png",
  "images/icon-maskable-512.png",
  "images/apple-touch-icon.png",
  // The manifest screenshots are what make Chrome's install dialog the rich one
  // rather than a bare icon-and-origin sheet; a missing one silently downgrades
  // it back, which no page load reveals.
  "images/screenshot-narrow.png",
  "images/screenshot-wide.png",
  // Without the archive the runtime cannot boot at all, but the page itself
  // loads and shows the catalog, so a deploy that forgot to build it looks
  // fine until the first radio is selected.
  ...CHIRP_BUNDLE_FILES,
];
// The service worker's source, bundled to dist/sw.js.
const SERVICE_WORKER_SOURCE = path.join(WEB_DIR, "sw.ts");
// The files the app reads at runtime under names that do not change with their
// content, which the service worker caches with each build's pages: the
// catalogs the radio pickers load, the version the footer and Sentry read, and
// what an installed app's launcher shows. Each must exist; an offline app
// missing one is broken in a way no online page load reveals.
const OFFLINE_DATA_FILES = [
  "radio-catalog.json",
  "radio-catalog-quansheng-unofficial.json",
  "version.json",
  "manifest.webmanifest",
  "favicon.ico",
  "images/icon-192.png",
  "images/icon-512.png",
  "images/icon-maskable-512.png",
  "images/apple-touch-icon.png",
];
// Files the service worker caches only on the hosts named, and best-effort
// there: a build is offline-ready without them. The Sentry SDK loads on the
// production hosts alone (initSentry's host gate), so a fork would cache it
// for nothing, and a privacy filter blocking it must not stop the app itself
// from working offline.
const OFFLINE_OPTIONAL_GROUPS = [
  { hosts: [...SENTRY_HOSTS], urls: [...SENTRY_SDK_MODULES] },
];
// Source files that reach dist/ only through esbuild or the Python hashing, so
// the verbatim copy skips them (as it skips type declarations, which only tsc
// reads, and the pages, which are written once rewritten).
const BUILT_EXTS = new Set([".js", ".mjs", ".ts", ".css", ".py"]);
// The source modules esbuild bundles, and so the ones a page might leave
// unshipped. A .d.ts is not one: tsc reads it, nothing imports it.
const SOURCE_MODULE_EXTS = new Set([".js", ".mjs", ".ts"]);

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

function contentHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name === "__pycache__") {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

// Every start tag in an HTML document with its attributes and where each
// attribute's value sits, skipping comments and the raw text of <script> and
// <style> -- so a path mentioned in prose, a comment or a JSON-LD block is
// never mistaken for a reference. Only as much HTML as the generated and
// hand-written pages use: quoted and unquoted attribute values, void and
// self-closing tags.
/** One attribute of a start tag, with where its value sits in the page. */
interface TagAttr {
  name: string;
  value: string;
  /** -1 for an attribute with no value. */
  valueStart: number;
  valueEnd: number;
}

function startTags(html: string): Array<{ name: string; attrs: TagAttr[] }> {
  const tags: Array<{ name: string; attrs: TagAttr[] }> = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      break;
    }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    let j = lt + nameMatch[0].length;
    const attrs: TagAttr[] = [];
    while (j < html.length) {
      while (/\s/.test(html[j])) {
        j += 1;
      }
      if (html[j] === ">") {
        j += 1;
        break;
      }
      if (html.startsWith("/>", j)) {
        j += 2;
        break;
      }
      const attrName = /^[^\s"'>/=]+/.exec(html.slice(j, j + 256));
      if (!attrName) {
        j += 1;
        continue;
      }
      j += attrName[0].length;
      while (/\s/.test(html[j])) {
        j += 1;
      }
      const attr: TagAttr = { name: attrName[0].toLowerCase(), value: "", valueStart: -1, valueEnd: -1 };
      if (html[j] === "=") {
        j += 1;
        while (/\s/.test(html[j])) {
          j += 1;
        }
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          attr.valueStart = j + 1;
          attr.valueEnd = html.indexOf(quote, j + 1);
          if (attr.valueEnd < 0) {
            throw new Error(`Unterminated attribute value at offset ${j}`);
          }
          j = attr.valueEnd + 1;
        } else {
          attr.valueStart = j;
          attr.valueEnd = j + (/^[^\s>]*/.exec(html.slice(j))?.[0].length ?? 0);
          j = attr.valueEnd;
        }
        attr.value = html.slice(attr.valueStart, attr.valueEnd);
      }
      attrs.push(attr);
    }
    tags.push({ name, attrs });
    if (name === "script" || name === "style") {
      const closer = new RegExp(`</${name}`, "ig");
      closer.lastIndex = j;
      const close = closer.exec(html);
      i = close ? close.index : html.length;
    } else {
      i = j;
    }
  }
  return tags;
}

// A reference to a file this build serves, as opposed to a CDN or data URL.
function isLocalRef(value: string): boolean {
  return Boolean(value) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

// The source files a page loads that esbuild owns, each with the attribute
// that names it: module scripts and stylesheets. A classic script, or an inline
// module script, is refused rather than shipped unbundled -- its imports would
// name source files dist/ does not have.
function pageAssetRefs(
  html: string,
  pageRel: string,
): Array<{ kind: "js" | "css"; attr: TagAttr; source: string; suffix: string }> {
  const refs: Array<{ kind: "js" | "css"; attr: TagAttr }> = [];
  for (const tag of startTags(html)) {
    const attr = (name: string) => tag.attrs.find((candidate) => candidate.name === name);
    if (tag.name === "script") {
      const src = attr("src");
      const type = (attr("type")?.value || "").trim().toLowerCase();
      if (type === "module" && !src) {
        throw new Error(`${pageRel}: inline module scripts are not bundled; load the module by src`);
      }
      if (!src || !isLocalRef(src.value)) {
        continue;
      }
      if (type !== "module") {
        throw new Error(`${pageRel}: ${src.value} is not a module script; only module scripts are bundled`);
      }
      refs.push({ kind: "js", attr: src });
    } else if (tag.name === "link") {
      const rel = (attr("rel")?.value || "").toLowerCase().split(/\s+/);
      const href = attr("href");
      if (rel.includes("stylesheet") && href && isLocalRef(href.value)) {
        refs.push({ kind: "css", attr: href });
      }
    }
  }
  return refs.map((ref) => {
    // Resolve browser URLs before filesystem lookup: leading slashes name the
    // web root, and query strings/fragments belong only on the emitted URL.
    const url = new URL(ref.attr.value, new URL(pageRel, "https://build.invalid/"));
    return {
      ...ref,
      source: path.join(WEB_DIR, decodeURIComponent(url.pathname)),
      suffix: url.search + url.hash,
    };
  });
}

// Copy every runtime Python file under its content hash and return the URL
// table the bundle gets, keyed by path under web/python/ the way
// RUNTIME_PYTHON_FILES (web/js/python-sources.ts) names them.
async function emitPythonFiles(): Promise<{ urls: Record<string, string>; emitted: Array<[string, string]> }> {
  const urls: Record<string, string> = {};
  const emitted: Array<[string, string]> = [];
  let files: string[] = [];
  try {
    files = (await walkFiles(PYTHON_DIR)).filter((file) => file.endsWith(".py"));
  } catch (error) {
    if (errorFields(error).code !== "ENOENT") {
      throw error;
    }
  }
  for (const file of files.sort()) {
    const content = await readFile(file);
    const rel = toPosix(path.relative(PYTHON_DIR, file));
    const hashedRel = rel.replace(/\.py$/, `.${contentHash(content)}.py`);
    const target = path.join(DIST_DIR, "python", hashedRel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    urls[rel] = `./python/${hashedRel}`;
    emitted.push([`python/${rel}`, `python/${hashedRel}`]);
  }
  return { urls, emitted };
}

// Give the bundle web/js/runtime-python-urls.ts as a literal table of the
// hashed URLs, in place of the source that derives the unhashed ones. The
// whole module is replaced, never edited, so nothing depends on how the
// source spells it.
function pythonUrlsPlugin(urls: Record<string, string>): esbuild.Plugin {
  const contents = [
    "// Generated by scripts/build-dist.ts: each runtime Python file's",
    "// content-hashed URL in dist/.",
    `export const RUNTIME_PYTHON_URLS = Object.freeze(${JSON.stringify(urls, null, 2)});`,
    "",
  ].join("\n");
  return {
    name: "runtime-python-urls",
    setup(build) {
      build.onLoad({ filter: /runtime-python-urls\.ts$/ }, (args) => (
        path.resolve(args.path) === PYTHON_URLS_MODULE
          ? { contents, loader: "js", resolveDir: path.dirname(PYTHON_URLS_MODULE) }
          : undefined
      ));
    },
  };
}

// The options both esbuild runs share: bundled ES modules, readable output
// (unminified, so a stack trace in Sentry or the debug panel stays legible
// without its map) and a linked source map beside every output.
const COMMON_BUILD_OPTIONS = Object.freeze({
  absWorkingDir: ROOT,
  outdir: DIST_DIR,
  bundle: true,
  write: true,
  metafile: true,
  sourcemap: "linked",
  minify: false,
  charset: "utf8",
  logLevel: "warning",
});

// Run esbuild over the page entries and map each entry's source path to the
// dist path of its output. The outputs are every file it wrote.
async function bundle(
  entries: string[],
  options: esbuild.BuildOptions,
): Promise<{ entryOutputs: Map<string, string>; outputs: string[]; inputs: string[] }> {
  if (entries.length === 0) {
    return { entryOutputs: new Map(), outputs: [], inputs: [] };
  }
  const result = await esbuild.build({ ...COMMON_BUILD_OPTIONS, ...options, entryPoints: entries });
  const { metafile } = result;
  if (!metafile) {
    throw new Error("esbuild returned no metafile; COMMON_BUILD_OPTIONS must keep metafile: true");
  }
  const entryOutputs = new Map<string, string>();
  for (const [outPath, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint) {
      entryOutputs.set(path.resolve(ROOT, output.entryPoint), path.resolve(ROOT, outPath));
    }
  }
  return {
    entryOutputs,
    outputs: Object.keys(metafile.outputs).map((outPath) => path.resolve(ROOT, outPath)),
    inputs: Object.keys(metafile.inputs).map((inPath) => path.resolve(ROOT, inPath)),
  };
}

// The digest of every file the service worker caches under a name that does
// not change with its content -- the root pages and OFFLINE_DATA_FILES -- as
// dist-relative paths, which the worker checks each fetched copy against so a
// deploy landing mid-download cannot leave it a mixed build.
async function offlineFileDigests(rootPages: string[]): Promise<Record<string, string>> {
  const rels = [
    ...rootPages.map((page) => toPosix(path.relative(WEB_DIR, page))),
    ...OFFLINE_DATA_FILES,
  ].sort();
  const digests: Record<string, string> = {};
  for (const rel of rels) {
    try {
      digests[rel] = contentHash(await readFile(path.join(DIST_DIR, rel)));
    } catch {
      throw new Error(`Missing offline asset: ${rel}`);
    }
  }
  return digests;
}

async function main() {
  await rm(DIST_DIR, { recursive: true, force: true });

  const webFiles = await walkFiles(WEB_DIR);
  const pages = webFiles.filter((file) => file.endsWith(".html"));
  const pageRefs = new Map<string, { html: string; refs: ReturnType<typeof pageAssetRefs> }>();
  const jsEntries = new Set<string>();
  const cssEntries = new Set<string>();
  for (const page of pages) {
    const pageRel = toPosix(path.relative(WEB_DIR, page));
    const html = await readFile(page, "utf8");
    const refs = pageAssetRefs(html, pageRel);
    for (const ref of refs) {
      try {
        await access(ref.source);
      } catch {
        throw new Error(`${pageRel} loads ${ref.attr.value}, which does not exist`);
      }
      (ref.kind === "js" ? jsEntries : cssEntries).add(ref.source);
    }
    pageRefs.set(page, { html, refs });
  }

  const python = await emitPythonFiles();

  const js = await bundle([...jsEntries].sort(), {
    format: "esm",
    splitting: true,
    target: "es2022",
    entryNames: `${JS_OUT_DIR}/[name].[hash]`,
    chunkNames: `${JS_OUT_DIR}/[name].[hash]`,
    external: EXTERNAL_URLS,
    plugins: [pythonUrlsPlugin(python.urls)],
  });
  // CSS keeps its place in the tree (styles.css stays at the root), so a
  // url() it might come to hold resolves as it does in the source.
  const css = await bundle([...cssEntries].sort(), {
    outbase: WEB_DIR,
    entryNames: "[dir]/[name].[hash]",
  });
  const entryOutputs = new Map([...js.entryOutputs, ...css.entryOutputs]);
  // A classic script rather than a module, which every browser with service
  // workers can run; unhashed at the root (see the header).
  const sw = await bundle([SERVICE_WORKER_SOURCE], {
    format: "iife",
    target: "es2022",
    outbase: WEB_DIR,
    entryNames: "[name]",
  });

  // Everything esbuild and the Python hashing did not produce, as it is. A
  // source module no page reaches is left out like any other source module;
  // it is named here so that leaving it out is never silent.
  // File by file rather than one recursive copy, so a directory that held
  // only source modules (web/js/ui/) does not reappear in dist/ empty.
  for (const file of webFiles) {
    if (BUILT_EXTS.has(path.extname(file)) || file.endsWith(".d.ts") || file.endsWith(".html")) {
      continue;
    }
    const target = path.join(DIST_DIR, path.relative(WEB_DIR, file));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
  }
  const bundled = new Set([...js.inputs, ...css.inputs, ...sw.inputs]);
  const unbundled = webFiles
    .filter((file) => (SOURCE_MODULE_EXTS.has(path.extname(file)) && !file.endsWith(".d.ts"))
      || path.extname(file) === ".css")
    .filter((file) => !bundled.has(file) && file !== PYTHON_URLS_MODULE)
    .map((file) => toPosix(path.relative(ROOT, file)));
  if (unbundled.length > 0) {
    console.log(`Not loaded by any page, so not shipped: ${unbundled.join(", ")}`);
  }

  for (const relPath of REQUIRED_WEB_FILES) {
    const expectedPath = path.join(DIST_DIR, relPath);
    try {
      await access(expectedPath);
    } catch {
      throw new Error(`Missing required dist asset: ${toPosix(path.relative(DIST_DIR, expectedPath))}`);
    }
  }

  // Point each page at its entries' outputs. Only the src or href attribute
  // that named the source is rewritten, at the offsets the tag parse found.
  for (const [page, { html, refs }] of pageRefs) {
    const pageDir = path.dirname(page.replace(WEB_DIR, DIST_DIR));
    let out = html;
    for (const ref of [...refs].sort((a, b) => b.attr.valueStart - a.attr.valueStart)) {
      // Every ref's source was handed to esbuild as an entry, so it has an output.
      let target = toPosix(path.relative(pageDir, entryOutputs.get(ref.source) as string));
      if (!target.startsWith(".")) {
        target = `./${target}`;
      }
      out = out.slice(0, ref.attr.valueStart) + target + ref.suffix + out.slice(ref.attr.valueEnd);
    }
    await mkdir(pageDir, { recursive: true });
    await writeFile(page.replace(WEB_DIR, DIST_DIR), out, "utf8");
  }

  // Every immutable name this build emits, each in both spellings a page may
  // request it by, keyed by what it was built from where that is one file. The
  // pin-named CHIRP archive and manifest map to themselves: they are not
  // renamed, but they are immutable and a cached page from the previous deploy
  // still asks for the previous pin's pair, so retention has to see them.
  const sourceOf = new Map([...entryOutputs].map(([source, output]) => [output, source]));
  const pairs = [
    ...[...js.outputs, ...css.outputs].map((output) => [
      toPosix(path.relative(sourceOf.has(output) ? WEB_DIR : DIST_DIR, sourceOf.get(output) || output)),
      toPosix(path.relative(DIST_DIR, output)),
    ]),
    ...python.emitted,
    ...CHIRP_BUNDLE_FILES.map((rel) => [rel, rel]),
  ];
  const replacements = pairs.flatMap(([from, to]) => [[`./${from}`, `./${to}`], [`/${from}`, `/${to}`]]);
  replacements.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const offline = {
    files: await offlineFileDigests(pages.filter((page) => path.dirname(page) === WEB_DIR)),
    assets: [...new Set(replacements.map(([, to]) => to.replace(/^\.?\//, "")))]
      .filter((rel) => !rel.endsWith(".map"))
      .sort(),
    cdn: [...OFFLINE_CDN_URLS],
    optional: OFFLINE_OPTIONAL_GROUPS,
  };

  // esbuild names each output after its bytes and its imports' names, and the
  // Python and pin names cover their files the same way, so a digest over the
  // name list is a digest of every hashed file. The whole offline section
  // joins it: the offline files' digests, so a change to index.html or a
  // catalog alone is a new build for the service worker to cache too, and the
  // CDN list, which can change without any emitted file changing (the browser
  // bundle tree-shakes it away). A worker that already holds a build hash
  // never syncs it again, so anything it caches must move the hash.
  const buildHash = contentHash(JSON.stringify([replacements, offline]));
  const manifest = {
    buildHash,
    generatedAt: new Date().toISOString(),
    assets: Object.fromEntries(replacements),
    offline,
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

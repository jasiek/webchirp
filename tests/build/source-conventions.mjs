// The TypeScript sources' conventions, read from the files: each test below is
// a rule that used to be CLAUDE.md prose and is now held by the suite, with a
// failure message that says what to do instead. The readers are in
// tests/support/source-conventions.mjs. Two rules predate this test and still
// have offenders; tests/support/source-conventions-baseline.json lists them,
// and the test fails on anything outside that list and on any entry the code
// no longer earns, so the list only shrinks.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { OFFLINE_CDN_URLS } from "../../web/js/cdn-urls.ts";
import { repoRoot } from "../support/repo-paths.mjs";
import {
  codeLines,
  codeMatches,
  relativeImports,
  typeScriptSources,
  uncommentedAnys,
  uncommentedFunctions,
  unresolvableImports,
  untypedExportReturns,
} from "../support/source-conventions.mjs";

const FILES = typeScriptSources();
const BROWSER_FILES = FILES.filter((rel) => rel.startsWith("web/"));
const BASELINE = JSON.parse(
  readFileSync(path.join(repoRoot, "tests", "support", "source-conventions-baseline.json"), "utf8"),
);

// Hold found against the frozen baseline: nothing new, nothing stale.
function assertRatchet(found, baselined, fix) {
  const known = new Set(baselined);
  const fresh = found.filter((entry) => !known.has(entry));
  assert.deepEqual(fresh, [], `${fix}:\n${fresh.join("\n")}`);
  const now = new Set(found);
  const stale = baselined.filter((entry) => !now.has(entry));
  assert.deepEqual(
    stale,
    [],
    `these now follow the rule; delete them from tests/support/source-conventions-baseline.json:\n${stale.join("\n")}`,
  );
}

test("the readers see the whole tree", () => {
  // Guards the guard: an empty file list passes every rule below.
  assert.ok(FILES.includes("web/app.ts") && FILES.includes("scripts/build-dist.ts"), FILES.join(", "));
  assert.ok(FILES.length > 80, `expected the whole tree, found ${FILES.length} files`);
});

test("every top-level function has a comment saying what it does and why", () => {
  assertRatchet(
    uncommentedFunctions(FILES),
    BASELINE.uncommentedFunctions,
    "put a comment directly above each of these functions saying what it does and why",
  );
});

test("every exported function names its return type", () => {
  assertRatchet(
    untypedExportReturns(FILES),
    BASELINE.untypedExportReturns,
    "give each of these exported functions an explicit return type",
  );
});

test("an explicit any carries a comment saying why the data is untyped", () => {
  const found = uncommentedAnys(FILES);
  assert.deepEqual(
    found,
    [],
    "any belongs only where data arrives untyped (JSON from Python, the network or a file, a "
      + "Pyodide proxy), with a comment saying so; otherwise use a real type, then unknown:\n"
      + found.join("\n"),
  );
});

test("relative imports name the file Node will load", () => {
  // Node resolves a specifier as written and never maps .js onto .ts, so
  // "./y" or "./y.js" for y.ts works under tsc and the bundler and fails in
  // Node and the dev server. A .js specifier is right only for a .d.ts.
  const found = unresolvableImports(FILES);
  assert.deepEqual(found, [], `name the .ts file ("./y.ts"):\n${found.join("\n")}`);
});

test("UI modules reach the modules ui.ts constructs through ctx, never by importing them", () => {
  // ui.ts builds each area module with create<Area>(ctx) and hands every one
  // to the others on ctx. A value import of one from another would bypass that
  // and can close a cycle; a type import is erased and is fine.
  const uiSource = readFileSync(path.join(repoRoot, "web", "js", "ui.ts"), "utf8");
  const constructed = new Set();
  for (const [, names, specifier] of uiSource.matchAll(/^import \{([^}]+)\} from "(\.\/ui\/[\w-]+\.ts)";$/gm)) {
    const called = names.split(",").map((name) => name.trim())
      .filter((name) => /^create[A-Z]\w*$/.test(name) && new RegExp(`\\b${name}\\(ctx\\)`).test(uiSource));
    if (called.length) constructed.add(path.posix.join("web/js", specifier));
  }
  assert.ok(constructed.size > 8, `found ${[...constructed].join(", ")}`);
  const found = [];
  for (const rel of BROWSER_FILES.filter((file) => file !== "web/js/ui.ts")) {
    const lines = readFileSync(path.join(repoRoot, rel), "utf8").split("\n");
    for (const { specifier, line } of relativeImports(rel)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
      if (constructed.has(target) && !/^import type\b/.test(lines[line - 1])) {
        found.push(`${rel}:${line} imports ${target}`);
      }
    }
  }
  assert.deepEqual(found, [], `call these through ctx (ctx.table.render()) or ctx.actions instead:\n${found.join("\n")}`);
});

test("UI feature modules get document elements from dom.ts", () => {
  const found = codeMatches(
    FILES.filter((rel) => rel.startsWith("web/js/ui/") && rel !== "web/js/ui/dom.ts"),
    /\bdocument\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\(/,
  );
  assert.deepEqual(found, [], `query the element in web/js/ui/dom.ts and read it from ctx.dom:\n${found.join("\n")}`);
});

test("only web/js/analytics.ts touches gtag", () => {
  const found = codeMatches(FILES.filter((rel) => rel !== "web/js/analytics.ts"), /\bgtag\b/);
  assert.deepEqual(found, [], `send events with trackEvent() (web/js/ui/analytics.ts):\n${found.join("\n")}`);
});

test("only the bootstrap runs Python, and only from the runtime files", () => {
  // web/js/python-sources.ts runs web/python/runtime_bridge.py as fetched;
  // everything else calls rpc_dispatch by name (web/js/rpc-dispatch.ts).
  const found = codeMatches(FILES.filter((rel) => rel !== "web/js/python-sources.ts"), /\brunPython(Async)?\b/);
  assert.deepEqual(
    found,
    [],
    "put Python in web/python/webchirp_bridge and register an RPC method for JS to call:\n" + found.join("\n"),
  );
});

test("every CDN file the browser loads is cached for offline use", () => {
  // A CDN URL named anywhere but web/js/cdn-urls.ts can escape
  // OFFLINE_CDN_URLS, which breaks only offline -- no online load shows it.
  // A bare origin (a preconnect, an origin check) names no file.
  const pages = readdirSync(path.join(repoRoot, "web")).filter((name) => name.endsWith(".html"))
    .map((name) => `web/${name}`);
  const found = [];
  for (const rel of [...BROWSER_FILES.filter((file) => file !== "web/js/cdn-urls.ts"), ...pages]) {
    for (const { text, line } of codeLines(rel)) {
      for (const [url] of text.matchAll(/https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)[^"'`\s)]*/g)) {
        if (new URL(url).pathname !== "/" && !OFFLINE_CDN_URLS.includes(url)) found.push(`${rel}:${line} ${url}`);
      }
    }
  }
  assert.deepEqual(found, [], `name the URL in web/js/cdn-urls.ts and list it in OFFLINE_CDN_URLS:\n${found.join("\n")}`);
});

test("test files are named for what they cover, never test-*", () => {
  const found = readdirSync(path.join(repoRoot, "tests"), { recursive: true })
    .filter((rel) => /(^|\/)test-[^/]*$/.test(String(rel)));
  assert.deepEqual(found, [], `drop the test- prefix; the directory already says it is a test:\n${found.join("\n")}`);
});

test("UI tests dispatch at the element a user touches instead of faking event.target", () => {
  const testFiles = readdirSync(path.join(repoRoot, "tests"), { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith(".mjs") && !rel.startsWith("support/") && rel !== "build/source-conventions.mjs")
    .map((rel) => `tests/${rel}`);
  const found = codeMatches(testFiles, /defineProperty\([^,]+,\s*["']target["']/);
  assert.deepEqual(
    found,
    [],
    "dispatch the event at the element (tests/support/ui-interactions.mjs) and let it bubble:\n" + found.join("\n"),
  );
});

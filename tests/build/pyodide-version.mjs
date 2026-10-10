// One Pyodide release everywhere. The browser loads Pyodide from jsDelivr
// (web/js/runtime-rpc.ts), while the Node suites run the pyodide npm package
// (tests/support/radio-harness.mjs) and tsc takes the loader's types from it
// (tsconfig.json's paths). When the npm range drifted ahead of the CDN pin,
// every runtime test passed against 0.27.7 while users ran 0.27.2. Nothing
// fails when they part, so this does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "../support/repo-paths.mjs";

const CDN_RE = /https:\/\/cdn\.jsdelivr\.net\/pyodide\/v([^/]+)\/full\//;

async function readRepoFile(...segments) {
  return readFile(path.join(repoRoot, ...segments), "utf8");
}

test("the browser, the Node tests and the types share one Pyodide release", async () => {
  const runtime = await readRepoFile("web", "js", "runtime-rpc.ts");
  const loader = runtime.match(/^import \{ loadPyodide \} from "([^"]+)";$/m)?.[1] || "";
  const indexUrl = runtime.match(/^const PYODIDE_INDEX_URL = "([^"]+)";$/m)?.[1] || "";
  const pathsKey = Object.keys(JSON.parse(await readRepoFile("tsconfig.json")).compilerOptions.paths)
    .find((key) => CDN_RE.test(key)) || "";
  const installed = JSON.parse(await readRepoFile("node_modules", "pyodide", "package.json")).version;

  assert.equal(loader, `${indexUrl}pyodide.mjs`, "the loader import and PYODIDE_INDEX_URL name different releases");
  assert.equal(indexUrl.match(CDN_RE)?.[1], installed, "the CDN serves a different release than the Node tests run");
  assert.equal(pathsKey, loader, "tsconfig.json types a different URL than the one imported");
});

// A range would let npm install move the tests to a newer patch on its own.
test("the pyodide npm package is pinned exactly", async () => {
  const spec = JSON.parse(await readRepoFile("package.json")).dependencies.pyodide;
  assert.match(spec, /^\d+\.\d+\.\d+$/, `package.json pins pyodide to a range: ${spec}`);
});

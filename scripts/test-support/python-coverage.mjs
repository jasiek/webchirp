// Env-gated coverage.py instrumentation for the Pyodide runtime, wired into
// scripts/test-radio-harness.mjs. Off unless WEBCHIRP_PY_COVERAGE names a
// directory, so an ordinary npm test pays nothing: no extra package load, no
// tracer, no exit hook.
//
// Pyodide ships coverage.py in its package set and its C tracer works under
// WASM, so this measures the real thing rather than a re-implementation. The
// tracer itself is Python and lives in scripts/test-support/python_coverage.py;
// this module only seeds it and moves data across the JS boundary.
//
// node:test gives each test file its own process, and each process boots its
// own Pyodide, so every one writes a fragment and scripts/coverage.mjs merges
// them. Merging is a union of executed lines over a union of statements: a
// module one process never imported still carries its full statement list from
// that process's fragment, so nothing drops out of the denominator.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const TRACER_PYTHON_PATH = path.join(supportDir, "python_coverage.py");

// Where seedPyodideRuntime() writes the runtime, and where those files live in
// the repo. Fragments carry Pyodide paths; callers want repo-relative ones.
const RUNTIME_PREFIX = "/webchirp_runtime/";
const REPO_PREFIX = "web/python/";

export const PYTHON_COVERAGE_ENV = "WEBCHIRP_PY_COVERAGE";

// The directory fragments are written to, or "" when coverage is off.
export function pythonCoverageDir() {
  const configured = String(process.env[PYTHON_COVERAGE_ENV] || "").trim();
  return configured ? path.resolve(configured) : "";
}

// Turn a Pyodide filesystem path into the repo path the same file has on disk,
// so a merged report and an lcov file both point at something a reader (or
// GitHub's diff view) can open.
export function toRepoPath(runtimePath) {
  const text = String(runtimePath || "");
  return text.startsWith(RUNTIME_PREFIX) ? REPO_PREFIX + text.slice(RUNTIME_PREFIX.length) : text;
}

// Start tracing in a freshly loaded Pyodide, before the runtime is seeded --
// tracing has to be running while webchirp_bridge is imported or the
// module-level statements never register as executed. Returns whether it did
// anything, so the caller can stay quiet when coverage is off.
export async function startPythonCoverage(pyodide) {
  const outputDir = pythonCoverageDir();
  if (!outputDir) {
    return false;
  }
  await pyodide.loadPackage("coverage");
  pyodide.runPython(fs.readFileSync(TRACER_PYTHON_PATH, "utf8"));
  pyodide.runPython("_webchirp_coverage_start()");

  // process.on("exit") only runs synchronous work, which is all this needs:
  // runPython and writeFileSync are both sync. An async hook would be dropped.
  let written = false;
  process.on("exit", () => {
    if (written) {
      return;
    }
    written = true;
    try {
      writePythonCoverageFragment(pyodide, outputDir);
    } catch (error) {
      // A missing fragment understates coverage but must never fail a test
      // run that otherwise passed, so this reports rather than throws.
      process.stderr.write(`python coverage fragment failed: ${error && error.message}\n`);
    }
  });
  return true;
}

// Pull this process's coverage out of Pyodide and write it as one fragment
// file. Named by pid plus a counter because a single process can boot more
// than one isolated harness.
let fragmentSeq = 0;
export function writePythonCoverageFragment(pyodide, outputDir) {
  const json = pyodide.runPython("_webchirp_coverage_fragment()");
  const parsed = JSON.parse(json);
  if (Object.keys(parsed).length === 0) {
    return "";
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, `fragment-${process.pid}-${fragmentSeq++}.json`);
  fs.writeFileSync(target, JSON.stringify(parsed));
  return target;
}

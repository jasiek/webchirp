// The runtime Python package's conventions, read from its source: every module
// has the future import, every function is fully typed and says what it does,
// a radio parameter is never Any, an import only annotations read sits under
// TYPE_CHECKING, and the bridge modules import each other without a cycle. The
// checks themselves are in tests/support/python_conventions.py (ast does the
// reading); this file runs them over web/python, and over a fixture that breaks
// each rule once, so a check that stopped finding anything would fail too.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { repoRoot, webDir } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const CHECKER = path.join(repoRoot, "tests", "support", "python_conventions.py");

// Run the checker over a web/python-shaped directory and return its report.
function report(pythonDir) {
  return JSON.parse(execFileSync("python3", ["-I", CHECKER, pythonDir], { encoding: "utf8" }));
}

const real = report(path.join(webDir, "python"));

const FIXES = {
  future_annotations: "add 'from __future__ import annotations' at the top of the module",
  signatures: "annotate every parameter and the return type",
  radio_params_not_any: "type radio parameters with the CHIRP class (chirp_common.Radio), not Any",
  annotation_only_imports: "move the import under 'if TYPE_CHECKING:'",
  function_comments: "give the function a docstring, or a comment above it, saying what it does and why",
  import_cycles: "break the cycle: move the shared code down, or import it under TYPE_CHECKING when only annotations need it",
};

for (const [rule, fix] of Object.entries(FIXES)) {
  test(`web/python: ${rule.replaceAll("_", " ")}`, () => {
    assert.deepEqual(real[rule], [], `${fix}:\n${real[rule].join("\n")}`);
  });
}

test("the checker saw the whole bridge package", () => {
  // Guards the guard: an empty package would pass every rule above.
  assert.ok(real.modules_seen.includes("rpc"), real.modules_seen.join(", "));
  assert.ok(real.modules_seen.length > 10, real.modules_seen.join(", "));
});

test("each check finds the violation it exists for", async () => {
  await withTempDir("python-conventions-", async (dir) => {
    const pkg = path.join(dir, "webchirp_bridge");
    mkdirSync(pkg);
    writeFileSync(path.join(dir, "runtime_bridge.py"), "from __future__ import annotations\n");
    writeFileSync(path.join(pkg, "__init__.py"), "from __future__ import annotations\n");
    writeFileSync(path.join(pkg, "alpha.py"), [
      "from typing import Any",
      "from chirp import chirp_common",
      "from webchirp_bridge.beta import helper",
      "",
      "def untyped(radio: Any, value):",
      "    return helper(value)",
      "",
      "# Says what it does.",
      "def typed(radio: chirp_common.Radio) -> None:",
      "    return None",
      "",
    ].join("\n"));
    writeFileSync(path.join(pkg, "beta.py"), [
      "from __future__ import annotations",
      "",
      "from webchirp_bridge.alpha import typed",
      "",
      "",
      "def helper(value: int) -> int:",
      '    """Documented."""',
      "    return typed",
      "",
    ].join("\n"));
    const found = report(dir);
    assert.deepEqual(found.future_annotations, ["webchirp_bridge/alpha.py:1 lacks 'from __future__ import annotations'"]);
    assert.deepEqual(found.signatures, [
      "webchirp_bridge/alpha.py:5 untyped() leaves value untyped",
      "webchirp_bridge/alpha.py:5 untyped() has no return annotation",
    ]);
    assert.equal(found.radio_params_not_any.length, 1);
    assert.match(found.radio_params_not_any[0], /alpha\.py:5 untyped\(radio\)/);
    assert.deepEqual(found.annotation_only_imports.map((line) => line.split(";")[0]), [
      "webchirp_bridge/alpha.py:1 imports Any only for annotations",
      "webchirp_bridge/alpha.py:2 imports chirp_common only for annotations",
    ]);
    assert.deepEqual(found.function_comments, ["webchirp_bridge/alpha.py:5 untyped() has no docstring or comment"]);
    assert.deepEqual(found.import_cycles, ["alpha -> beta -> alpha"]);
  });
});

test("a subpackage's modules are checked and join the import graph", async () => {
  await withTempDir("python-conventions-", async (dir) => {
    const pkg = path.join(dir, "webchirp_bridge");
    const sub = path.join(pkg, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(dir, "runtime_bridge.py"), "from __future__ import annotations\n");
    writeFileSync(path.join(pkg, "__init__.py"), "from __future__ import annotations\n");
    writeFileSync(path.join(pkg, "delta.py"), [
      "from __future__ import annotations",
      "",
      "from webchirp_bridge.sub.gamma import helper",
      "",
    ].join("\n"));
    // A package importing its own submodule is how a hook reaches its
    // workarounds; Python runs the package first, so that is no cycle.
    writeFileSync(path.join(sub, "__init__.py"), [
      "from __future__ import annotations",
      "",
      "from webchirp_bridge.sub import gamma",
      "",
    ].join("\n"));
    // Relative imports count from the importing module's package: ".." is
    // the bridge package here, and "." is sub.
    writeFileSync(path.join(sub, "gamma.py"), [
      "from .. import delta",
      "",
    ].join("\n"));
    writeFileSync(path.join(sub, "alpha.py"), [
      "from __future__ import annotations",
      "",
      "from . import beta",
      "",
    ].join("\n"));
    writeFileSync(path.join(sub, "beta.py"), [
      "from __future__ import annotations",
      "",
      "from .alpha import helper",
      "",
    ].join("\n"));
    const found = report(dir);
    assert.deepEqual(found.future_annotations, ["webchirp_bridge/sub/gamma.py:1 lacks 'from __future__ import annotations'"]);
    assert.deepEqual(found.modules_seen, ["__init__", "delta", "sub", "sub.alpha", "sub.beta", "sub.gamma"]);
    assert.deepEqual(found.import_cycles, [
      "delta -> sub.gamma -> delta",
      "sub.alpha -> sub.beta -> sub.alpha",
    ]);
  });
});

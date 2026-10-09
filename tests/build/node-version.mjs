// One Node version, named in one place. .tool-versions is what asdf installs
// locally and what both workflows hand actions/setup-node (node-version-file),
// and package.json's engines field repeats it so npm warns anyone running
// another version. These tests keep the three from drifting apart, and keep
// the retired --experimental-wasm-stack-switching flag from coming back: on
// Node 25 JSPI is on by default, and Node 26 refuses to start with the flag.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../support/repo-paths.mjs";

const workflowsDir = path.join(repoRoot, ".github", "workflows");

// The nodejs version .tool-versions pins, or null when the line is missing.
function toolVersionsNode() {
  const text = readFileSync(path.join(repoRoot, ".tool-versions"), "utf8");
  const match = text.match(/^nodejs\s+(\S+)\s*$/m);
  return match ? match[1] : null;
}

test("package.json engines names the Node version .tool-versions pins", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const pinned = toolVersionsNode();
  assert.ok(pinned, ".tool-versions has no nodejs line");
  assert.equal(pkg.engines?.node, pinned);
});

test("every workflow that sets up Node reads the version from .tool-versions", () => {
  let seen = 0;
  for (const name of readdirSync(workflowsDir).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(path.join(workflowsDir, name), "utf8");
    const setups = text.split("uses: actions/setup-node@").slice(1);
    for (const setup of setups) {
      seen += 1;
      // The with: block of this step ends at the next step.
      const step = setup.split(/\n\s*- /)[0];
      assert.match(step, /node-version-file: \.tool-versions/, `${name} sets up Node without .tool-versions`);
      assert.doesNotMatch(step, /node-version:/, `${name} also names a Node version by hand`);
    }
  }
  assert.ok(seen > 0, "no workflow sets up Node, so this test checked nothing");
});

test("no npm script or workflow passes --experimental-wasm-stack-switching", () => {
  const sources = [path.join(repoRoot, "package.json"), path.join(repoRoot, "scripts", "coverage.ts")];
  for (const name of readdirSync(workflowsDir)) {
    sources.push(path.join(workflowsDir, name));
  }
  for (const file of sources) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /--experimental-wasm-stack-switching/, file);
  }
});

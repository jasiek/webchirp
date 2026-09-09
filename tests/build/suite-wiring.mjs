// The suite layout is load-bearing: npm test globs tests/<suite>/*.mjs and
// scripts/coverage.mjs discovers the same directories, so a test file is run
// and measured purely by where it sits. Nothing lists the files any more, which
// is the point -- and also why the wiring itself needs a test. Each assertion
// below covers a way a file can end up silently unrun: sitting in a directory
// npm test does not reach, sitting loose in tests/, being measured for coverage
// while CI never executes it, or -- the one that actually happened -- never
// reaching the repository at all, because an unanchored build/ in .gitignore
// matched tests/build/ and git never offered its new files for commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { suitesRunByNpmTest, testFiles } from "../../scripts/coverage.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

const TESTS_DIR = path.join(repoRoot, "tests");
// support/ holds fixtures rather than tests; manual/ is deliberately excluded
// from npm test (one file needs the network, the other a radio on a port).
const NON_SUITE_DIRS = new Set(["support", "manual"]);

const pkgPath = path.join(repoRoot, "package.json");

function scripts() {
  return JSON.parse(readFileSync(pkgPath, "utf8")).scripts;
}

function suiteDirs() {
  return readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NON_SUITE_DIRS.has(e.name))
    .map((e) => e.name);
}

test("every suite directory is reachable from npm test", () => {
  // Reachable, not merely mentioned. A test: script that still globs its suite
  // but is no longer chained into the root test script leaves the suite green
  // in coverage and absent from the gate: .github/workflows/pages.yml runs
  // npm test and nothing else, so that suite would stop blocking a deploy.
  const gated = suitesRunByNpmTest(JSON.parse(readFileSync(pkgPath, "utf8")));
  const unrun = suiteDirs().filter((name) => !gated.has(name));
  assert.deepEqual(unrun, [], `suite directories npm test never reaches: ${unrun.join(", ")}`);
});

test("suites are globbed, never listed file by file", () => {
  // test:api and test:hw are exempt: they are invoked one file at a time on
  // purpose, and tests/manual/ is not a suite anything globs.
  const named = Object.entries(scripts())
    .filter(([, command]) => /tests\/[\w-]+\/[\w-]+\.mjs/.test(command.replaceAll("*.mjs", "")))
    .filter(([name]) => name !== "test:api" && name !== "test:hw")
    .map(([name]) => name);
  assert.deepEqual(
    named,
    [],
    `these scripts name individual test files, so adding a test would need a `
      + `package.json edit: ${named.join(", ")}`,
  );
});

test("no test file sits loose in tests/, where nothing would run it", () => {
  const loose = readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => e.name);
  assert.deepEqual(loose, [], `move these into a suite directory: ${loose.join(", ")}`);
});

test("coverage measures exactly the files the suites run", () => {
  const expected = suiteDirs()
    .flatMap((suite) =>
      readdirSync(path.join(TESTS_DIR, suite))
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => `tests/${suite}/${name}`))
    .sort();
  assert.deepEqual(testFiles(), expected);
  // Guards the guard: an empty expectation would make the equality vacuous.
  assert.ok(expected.length > 60, `expected the whole suite, found ${expected.length} files`);
});

test("no test file is hidden from git by an ignore rule", () => {
  // A glob runs what is on disk; CI runs what was committed. An ignore rule
  // that matches a suite directory silently separates the two -- the author
  // sees green locally and the file never lands. Ask git directly rather than
  // reasoning about the patterns: check-ignore prints the paths it would
  // ignore and exits 1 when there are none, so the throw is the good case.
  const files = suiteDirs()
    .concat([...NON_SUITE_DIRS])
    .flatMap((dir) =>
      readdirSync(path.join(TESTS_DIR, dir))
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => `tests/${dir}/${name}`));
  let ignored = "";
  try {
    // --no-index is what makes this check anything at all: by default
    // check-ignore reports nothing for a path already in the index, so every
    // file here -- all of them committed -- would come back clean however
    // badly .gitignore were written, and the guard would pass vacuously.
    ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: repoRoot,
      input: files.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (error.status !== 1) {
      throw error;
    }
  }
  assert.equal(ignored, "", `.gitignore hides these test files:\n${ignored}`);
});

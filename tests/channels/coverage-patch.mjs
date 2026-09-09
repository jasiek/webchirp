// Patch coverage (scripts/coverage-patch.mjs) is what a reviewer reads on a
// pull request, so its arithmetic has to be right in the cases that are easy to
// get wrong: a hunk header with no line count, a pure deletion, a changed
// comment inside untested code, and a run of uncovered lines that should read
// as one range rather than thirty entries.
import assert from "node:assert/strict";
import test from "node:test";

import { isJsCodeLine } from "../../scripts/coverage-lcov.mjs";
import {
  changedLinesFromDiff,
  classifyChangedLines,
  percent,
  renderMarkdown,
  toRanges,
} from "../../scripts/coverage-patch.mjs";

// One lcov-shaped entry, as scripts/coverage-lcov.mjs would parse it.
function coverageOf(entries) {
  return new Map(
    Object.entries(entries).map(([file, hits]) => [file, { lineHits: new Map(Object.entries(hits).map(([k, v]) => [Number(k), v])) }]),
  );
}

test("a hunk header without a count covers exactly one line", () => {
  const diff = [
    "--- a/web/js/a.js",
    "+++ b/web/js/a.js",
    "@@ -3 +3 @@",
    "-old",
    "+new",
  ].join("\n");

  assert.deepEqual([...changedLinesFromDiff(diff).get("web/js/a.js")], [3]);
});

test("a hunk that only deletes contributes no changed lines", () => {
  // git writes "+7,0" for a deletion: nothing exists at line 7 afterwards, so
  // counting it would blame the branch for a line it removed.
  const diff = ["--- a/web/js/a.js", "+++ b/web/js/a.js", "@@ -7,3 +7,0 @@", "-gone"].join("\n");

  assert.equal(changedLinesFromDiff(diff).has("web/js/a.js"), false);
});

test("several hunks in several files accumulate", () => {
  const diff = [
    "--- a/web/js/a.js",
    "+++ b/web/js/a.js",
    "@@ -1,0 +2,3 @@",
    "+one",
    "@@ -9,1 +12,1 @@",
    "+two",
    "--- a/web/python/webchirp_bridge/b.py",
    "+++ b/web/python/webchirp_bridge/b.py",
    "@@ -4,0 +5,2 @@",
    "+three",
  ].join("\n");

  const changed = changedLinesFromDiff(diff);
  assert.deepEqual([...changed.get("web/js/a.js")], [2, 3, 4, 12]);
  assert.deepEqual([...changed.get("web/python/webchirp_bridge/b.py")], [5, 6]);
});

test("a rename's old path is not counted as changed", () => {
  // Only the +++ side names a file, so the a/ path never enters the map.
  const diff = [
    "--- a/web/js/old.js",
    "+++ b/web/js/new.js",
    "@@ -1,0 +1,1 @@",
    "+line",
  ].join("\n");

  const changed = changedLinesFromDiff(diff);
  assert.deepEqual([...changed.keys()], ["web/js/new.js"]);
});

test("comment and blank lines are not code", () => {
  assert.equal(isJsCodeLine("const x = 1;"), true);
  assert.equal(isJsCodeLine("  return x; // trailing comment"), true);
  assert.equal(isJsCodeLine("// a comment"), false);
  assert.equal(isJsCodeLine("  /* block start"), false);
  assert.equal(isJsCodeLine("   * continuation"), false);
  assert.equal(isJsCodeLine("   */"), false);
  assert.equal(isJsCodeLine("   "), false);
  assert.equal(isJsCodeLine(""), false);
});

test("changed lines split into covered and uncovered by hit count", () => {
  const changed = new Map([["web/python/webchirp_bridge/b.py", new Set([1, 2, 3])]]);
  const coverage = coverageOf({ "web/python/webchirp_bridge/b.py": { 1: 4, 2: 0, 3: 1 } });

  const result = classifyChangedLines(changed, coverage, { filterComments: false });
  assert.deepEqual(result.covered.map((e) => e.line), [1, 3]);
  assert.deepEqual(result.uncovered.map((e) => e.line), [2]);
});

test("a changed line the coverage data never mentions is ignored", () => {
  // For Python that means the line is not a statement; for JavaScript that it
  // falls outside anything V8 measured. Either way it is not a coverage gap.
  const changed = new Map([["web/python/webchirp_bridge/b.py", new Set([1, 99])]]);
  const coverage = coverageOf({ "web/python/webchirp_bridge/b.py": { 1: 0 } });

  const result = classifyChangedLines(changed, coverage, { filterComments: false });
  assert.deepEqual(result.uncovered.map((e) => e.line), [1]);
  assert.equal(result.covered.length, 0);
});

test("a changed file with no coverage data at all is skipped", () => {
  const changed = new Map([["scripts/build-dist.mjs", new Set([1, 2])]]);

  const result = classifyChangedLines(changed, new Map(), { filterComments: false });
  assert.deepEqual(result, { covered: [], uncovered: [] });
});

test("consecutive uncovered lines in one file collapse to a range", () => {
  const ranges = toRanges([
    { file: "a.js", line: 4 },
    { file: "a.js", line: 5 },
    { file: "a.js", line: 6 },
    { file: "a.js", line: 9 },
    { file: "b.js", line: 10 },
  ]);

  assert.deepEqual(ranges, [
    { file: "a.js", start: 4, end: 6 },
    { file: "a.js", start: 9, end: 9 },
    { file: "b.js", start: 10, end: 10 },
  ]);
});

test("a line adjacent in number but in another file starts a new range", () => {
  assert.deepEqual(
    toRanges([{ file: "a.js", line: 4 }, { file: "b.js", line: 5 }]),
    [{ file: "a.js", start: 4, end: 4 }, { file: "b.js", start: 5, end: 5 }],
  );
});

test("percent treats no measurable lines as complete, not as zero", () => {
  // A branch that changes nothing under test has not failed to cover anything.
  assert.equal(percent(0, 0), 100);
  assert.equal(percent(1, 3), 33.33);
});

test("a branch that changes nothing measured says so instead of showing 0%", () => {
  const markdown = renderMarkdown([{ label: "JavaScript", covered: [], uncovered: [] }]);

  assert.match(markdown, /nothing to cover/);
  assert.doesNotMatch(markdown, /0\.00%/);
});

test("a very long uncovered list is capped, and says how much it dropped", () => {
  // A GitHub comment body is capped at 65,536 characters, so an enormous list
  // has to be trimmed rather than silently rejected by the API.
  const uncovered = Array.from({ length: 140 }, (_, i) => ({
    file: `web/js/f${i}.js`,
    line: 10,
  }));
  const markdown = renderMarkdown([{ label: "JavaScript", covered: [], uncovered }]);

  assert.match(markdown, /and 40 more range\(s\)/);
  assert.match(markdown, /web\/js\/f99\.js/);
  assert.doesNotMatch(markdown, /web\/js\/f100\.js/);
});

test("the report names every uncovered range, not just the annotated ones", () => {
  // GitHub renders ten annotations per step; the markdown is where the rest
  // have to survive, so a long list must not be truncated here too.
  const uncovered = Array.from({ length: 24 }, (_, i) => ({
    file: `web/js/f${i}.js`,
    line: 10,
  }));
  const markdown = renderMarkdown([{ label: "JavaScript", covered: [], uncovered }]);

  for (let i = 0; i < 24; i += 1) {
    assert.match(markdown, new RegExp(`web/js/f${i}\\.js`));
  }
  assert.match(markdown, /0\.00%/);
});

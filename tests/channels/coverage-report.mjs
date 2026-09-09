// The coverage viewer (scripts/coverage-report.mjs) decides what a reader is
// told about each line, so its classification has to be right where the two
// languages differ: Node's lcov records every physical line, coverage.py
// records only statements, and a comment must never be painted as a gap.
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFile,
  escapeHtml,
  renderFileSection,
  uncoveredRuns,
} from "../../scripts/coverage-report.mjs";

// One file's worth of report input, with only the fields the renderer reads.
function fileFixture(overrides = {}) {
  return {
    path: "web/js/ui/format.js",
    language: "javascript",
    sourceLines: ["const x = 1;"],
    verdicts: ["covered"],
    measured: 1,
    covered: 1,
    percent: 83.19,
    ...overrides,
  };
}

test("a line with no lcov record is neutral, not uncovered", () => {
  // Python's lcov only records statements, so a docstring continuation or a
  // blank line simply has no DA entry. Calling that a gap would be a lie.
  const verdicts = classifyFile(["import os", "", "x = 1"], new Map([[1, 1], [3, 0]]), false);

  assert.deepEqual(verdicts, ["covered", "neutral", "uncovered"]);
});

test("JavaScript comments are neutral even though lcov gives them a hit count", () => {
  const source = ["// explains the next line", "const x = 1;", "  * continuation", "run();"];
  const hits = new Map([[1, 0], [2, 0], [3, 0], [4, 3]]);

  assert.deepEqual(classifyFile(source, hits, true), [
    "neutral",
    "uncovered",
    "neutral",
    "covered",
  ]);
});

test("the same comment lines stay uncovered when the file is Python", () => {
  // A "//" line in Python is not a comment, and coverage.py would not have
  // recorded it unless it were a statement, so the JS filter must not apply.
  const source = ["// not a python comment", "x = 1"];

  assert.deepEqual(classifyFile(source, new Map([[1, 0], [2, 1]]), false), [
    "uncovered",
    "covered",
  ]);
});

test("consecutive uncovered lines are one run", () => {
  assert.deepEqual(uncoveredRuns(["covered", "uncovered", "uncovered", "covered"]), [
    { start: 2, end: 3 },
  ]);
});

test("a neutral line inside an untested block does not split the run", () => {
  // An untested function with a comment in the middle is one gap to a reader,
  // not two, and reporting it as two makes a file look worse than it is.
  const verdicts = ["uncovered", "neutral", "uncovered"];

  assert.deepEqual(uncoveredRuns(verdicts), [{ start: 1, end: 3 }]);
});

test("a covered line between two gaps does split the run", () => {
  const verdicts = ["uncovered", "covered", "uncovered"];

  assert.deepEqual(uncoveredRuns(verdicts), [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
});

test("a fully covered file has no runs", () => {
  assert.deepEqual(uncoveredRuns(["covered", "neutral", "covered"]), []);
});

test("source is escaped before it reaches the HTML report", () => {
  // Every line of every measured file is interpolated into the page, and this
  // repo's sources contain angle brackets and ampersands in real code.
  assert.equal(
    escapeHtml('if (a < b && c > d) return "<script>";'),
    "if (a &lt; b &amp;&amp; c &gt; d) return \"&lt;script&gt;\";",
  );
});

test("each row carries the sort keys the toolbar reads", () => {
  // The page sorts by reordering these sections, so a missing or misspelt
  // attribute leaves a file stuck wherever it was emitted.
  const html = renderFileSection(fileFixture());

  assert.match(html, /data-percent="83\.19"/);
  assert.match(html, /data-path="web\/js\/ui\/format\.js"/);
  assert.match(html, /data-language="javascript"/);
});

test("a row is labelled with the language whose lcov it came from", () => {
  // Not guessed from the extension: the two languages are measured by
  // different tools counting different things, so the badge has to reflect
  // which lcov the row was read from.
  assert.match(renderFileSection(fileFixture()), /<span class="lang javascript">JS<\/span>/);
  assert.match(
    renderFileSection(fileFixture({
      path: "web/python/webchirp_bridge/clone.py",
      language: "python",
    })),
    /<span class="lang python">PY<\/span>/,
  );
});

test("a path is escaped in the sort key as well as in the heading", () => {
  // data-path is inside a quoted attribute the sort script compares on, so it
  // has to be escaped there too, not only where it is displayed.
  const html = renderFileSection(fileFixture({ path: "web/js/a&b<c>.js" }));

  assert.match(html, /data-path="web\/js\/a&amp;b&lt;c&gt;\.js"/);
  assert.doesNotMatch(html, /data-path="[^"]*<c>/);
});

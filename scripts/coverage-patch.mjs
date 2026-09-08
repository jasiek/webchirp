// Patch coverage: of the lines this branch adds or changes, how many does the
// test suite actually run?
//
// Project coverage barely moves on a small change -- forty new untested lines
// shift a 13,000-line denominator by a third of a percent -- so it cannot
// answer the question a reviewer is actually asking. This can: "you added 40
// lines, 12 of them are never executed, here they are."
//
// Reads the lcov files scripts/coverage.mjs has already written, so it measures
// the same run rather than re-testing. Writes coverage/patch.md, and emits
// GitHub workflow commands so the uncovered lines appear as annotations on the
// pull request's own diff.
//
// Usage:
//   node scripts/coverage-patch.mjs [--base <ref>]
// COVERAGE_DIFF_BASE is the same setting as --base; it defaults to
// origin/master. CI passes the pull request's base branch as a ref, never a
// SHA -- see changedLinesByFile() below for why that distinction matters.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isJsCodeLine, parseLcov } from "./coverage-lcov.mjs";
import { repoRoot } from "./test-support/repo-paths.mjs";

const COVERAGE_DIR = path.join(repoRoot, "coverage");

// GitHub renders at most ten annotations of each level per step, so listing
// every uncovered line as an annotation would silently drop the rest. The
// markdown block carries the full list; annotations are the first few.
const MAX_ANNOTATIONS = 10;

// A GitHub comment body is capped at 65,536 characters, and a branch that
// rewrites a large module can produce hundreds of uncovered ranges. Listing
// every one would both overflow that and bury the number a reader came for, so
// the list is capped and says how much it left out. The run's artifact carries
// the complete lcov either way.
const MAX_LISTED_RANGES = 100;

// --- the changed lines ------------------------------------------------------

// Line numbers this branch adds or modifies, per file, from a zero-context
// diff. Three dots, so the base is the merge base git computes now: a change
// that landed on master after the branch started is not this branch's to answer
// for. This is also why the base must be given as a *ref* rather than a SHA --
// GitHub's own pull_request.base.sha is pinned at creation and goes stale
// (pr-refs-go-stale in FINDINGS.md).
function changedLinesByFile(base) {
  const diff = execFileSync(
    "git",
    ["diff", "--unified=0", "--diff-filter=d", `${base}...HEAD`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return changedLinesFromDiff(diff);
}

// The parsing half, kept separate from running git so it can be tested against
// diffs that would be awkward to produce as real commits.
export function changedLinesFromDiff(diff) {
  const byFile = new Map();
  let file = "";
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[1];
      continue;
    }
    // "@@ -12,3 +14,5 @@" -- the + side is the post-change line range, and a
    // missing count means one line.
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !file) {
      continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) {
      continue;
    }
    const lines = byFile.get(file) || new Set();
    for (let n = start; n < start + count; n += 1) {
      lines.add(n);
    }
    byFile.set(file, lines);
  }
  return byFile;
}

// --- deciding what counts ---------------------------------------------------

function readSourceLines(repoRelativePath) {
  const full = path.join(repoRoot, repoRelativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8").split("\n") : [];
}

// Changed lines that the coverage data has something to say about, split into
// covered and uncovered. A changed line with no DA record is ignored: for
// JavaScript that means it is outside anything V8 measured, and for Python that
// it is not a statement.
export function classifyChangedLines(changed, coverage, { filterComments }) {
  const covered = [];
  const uncovered = [];
  for (const [file, lines] of changed) {
    const fileCoverage = coverage.get(file);
    if (!fileCoverage) {
      continue;
    }
    const source = filterComments ? readSourceLines(file) : [];
    for (const line of [...lines].sort((a, b) => a - b)) {
      const hits = fileCoverage.lineHits.get(line);
      if (hits === undefined) {
        continue;
      }
      if (filterComments && !isJsCodeLine(source[line - 1])) {
        continue;
      }
      (hits > 0 ? covered : uncovered).push({ file, line });
    }
  }
  return { covered, uncovered };
}

// --- reporting --------------------------------------------------------------

export function percent(covered, total) {
  return total === 0 ? 100 : Math.round((covered / total) * 10000) / 100;
}

// Consecutive uncovered lines in one file collapse to a range, so a whole
// untested function reads as one entry instead of thirty.
export function toRanges(entries) {
  const ranges = [];
  for (const { file, line } of entries) {
    const last = ranges[ranges.length - 1];
    if (last && last.file === file && line === last.end + 1) {
      last.end = line;
    } else {
      ranges.push({ file, start: line, end: line });
    }
  }
  return ranges;
}

export function renderMarkdown(results) {
  const totalCovered = results.reduce((sum, r) => sum + r.covered.length, 0);
  const totalLines = results.reduce((sum, r) => sum + r.covered.length + r.uncovered.length, 0);
  const lines = ["### Patch coverage", ""];

  if (totalLines === 0) {
    lines.push(
      "This branch changes no measured line of `web/`, so there is nothing to cover.",
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    `**${percent(totalCovered, totalLines).toFixed(2)}%** of the `
      + `${totalLines} changed line(s) under test are executed by the suite `
      + `(${totalLines - totalCovered} not).`,
    "",
    "| scope | changed | covered |",
    "| --- | ---: | ---: |",
  );
  for (const result of results) {
    const total = result.covered.length + result.uncovered.length;
    lines.push(
      `| ${result.label} | ${total} | `
        + `${total === 0 ? "—" : `${percent(result.covered.length, total).toFixed(2)}%`} |`,
    );
  }

  const uncovered = results.flatMap((r) => r.uncovered);
  const ranges = toRanges(uncovered);
  const listed = ranges.slice(0, MAX_LISTED_RANGES);
  if (uncovered.length) {
    lines.push(
      "",
      "<details><summary>Changed lines with no test coverage</summary>",
      "",
      ...listed.map(({ file, start, end }) =>
        `- \`${file}\`: ${start === end ? `line ${start}` : `lines ${start}–${end}`}`),
      ...(ranges.length > listed.length
        ? [`- _…and ${ranges.length - listed.length} more range(s); the run's `
          + "artifact carries the complete lcov._"]
        : []),
      "",
      "</details>",
    );
  }
  lines.push(
    "",
    "_Patch coverage is reported, not gated: a branch can legitimately add a line "
      + "no unit test reaches. Treat a low number as a question, not a failure._",
    "",
  );
  return lines.join("\n");
}

// GitHub turns these into annotations on the pull request diff, which is the
// only place a reviewer sees the finding next to the code that caused it.
function emitAnnotations(results) {
  const ranges = toRanges(results.flatMap((r) => r.uncovered));
  for (const { file, start, end } of ranges.slice(0, MAX_ANNOTATIONS)) {
    const what = start === end ? "This line is" : `These ${end - start + 1} lines are`;
    process.stdout.write(
      `::warning file=${file},line=${start},endLine=${end},`
        + `title=Not covered by tests::${what} changed by this branch and never `
        + "executed by the test suite.\n",
    );
  }
  if (ranges.length > MAX_ANNOTATIONS) {
    process.stdout.write(
      `::notice::${ranges.length - MAX_ANNOTATIONS} further uncovered range(s) are `
        + "listed in the coverage comment; GitHub renders only ten annotations per step.\n",
    );
  }
}

// --- main -------------------------------------------------------------------

function main() {
  const baseFlag = process.argv.indexOf("--base");
  const base = baseFlag === -1
    ? String(process.env.COVERAGE_DIFF_BASE || "origin/master")
    : process.argv[baseFlag + 1];

  // Without the lcov files every changed line looks unmeasured, which reads as
  // "nothing to cover" rather than "coverage was never run". Say which it is.
  if (!fs.existsSync(path.join(COVERAGE_DIR, "js.lcov"))
    && !fs.existsSync(path.join(COVERAGE_DIR, "python.lcov"))) {
    throw new Error("no coverage data in coverage/; run npm run coverage first");
  }

  const changed = changedLinesByFile(base);
  const results = [
    {
      label: "JavaScript",
      lcov: "js.lcov",
      filterComments: true,
    },
    {
      label: "Python",
      lcov: "python.lcov",
      filterComments: false,
    },
  ].map((scope) => {
    const lcovPath = path.join(COVERAGE_DIR, scope.lcov);
    const coverage = fs.existsSync(lcovPath)
      ? parseLcov(fs.readFileSync(lcovPath, "utf8"))
      : new Map();
    return {
      label: scope.label,
      ...classifyChangedLines(changed, coverage, { filterComments: scope.filterComments }),
    };
  });

  const markdown = renderMarkdown(results);
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(COVERAGE_DIR, "patch.md"), markdown);
  process.stderr.write(`${markdown}\n`);
  emitAnnotations(results);
}

// Only when run as a script: the test imports this module for its helpers, and
// must not trigger a git call or write files by doing so.
if (import.meta.main) {
  main();
}

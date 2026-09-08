// Turns the lcov files into something a person can read: which lines of which
// file the suite runs, and which it never touches.
//
// npm run coverage answers "how much"; this answers "what". Both come from the
// same lcov, so the two can never disagree.
//
// Usage:
//   npm run coverage:report            write coverage/report.html
//   npm run coverage:show -- <path>    print a file's uncovered lines
//
// The HTML is one self-contained file with no external requests, so it opens
// from disk and survives being attached to an issue or downloaded from a CI
// artifact. The terminal mode is for the edit-test loop: it prints only the
// uncovered regions, with a little context, rather than the whole file.
import fs from "node:fs";
import path from "node:path";

import { isJsCodeLine, parseLcov } from "./coverage-lcov.mjs";
import { repoRoot } from "./test-support/repo-paths.mjs";

const COVERAGE_DIR = path.join(repoRoot, "coverage");
const LCOV_FILES = ["js.lcov", "python.lcov"];

// Lines either side of an uncovered run in the terminal view. Enough to see
// which function you are looking at without reprinting the file.
const CONTEXT_LINES = 2;

// --- classifying a line -----------------------------------------------------

// "covered" | "uncovered" | "neutral" for every line of a file.
//
// neutral means the line is not something coverage can be measured against: a
// blank or comment line in JavaScript, or in Python anything coverage.py did
// not record as a statement. Rendering those as uncovered would paint whole
// comment blocks red and bury the real gaps.
export function classifyFile(sourceLines, lineHits, isJavaScript) {
  return sourceLines.map((text, index) => {
    const hits = lineHits.get(index + 1);
    if (hits === undefined) {
      return "neutral";
    }
    if (isJavaScript && !isJsCodeLine(text)) {
      return "neutral";
    }
    return hits > 0 ? "covered" : "uncovered";
  });
}

// Every measured file, with its source, per-line verdicts and totals.
function collectFiles() {
  const present = LCOV_FILES.filter((name) => fs.existsSync(path.join(COVERAGE_DIR, name)));
  if (present.length === 0) {
    throw new Error("no coverage data in coverage/; run npm run coverage first");
  }
  const files = [];
  for (const name of present) {
    const parsed = parseLcov(fs.readFileSync(path.join(COVERAGE_DIR, name), "utf8"));
    for (const [repoPath, data] of parsed) {
      const full = path.join(repoRoot, repoPath);
      if (!fs.existsSync(full)) {
        // The lcov outlived the file: a rename or delete since the last run.
        continue;
      }
      const sourceLines = fs.readFileSync(full, "utf8").split("\n");
      const verdicts = classifyFile(sourceLines, data.lineHits, name === "js.lcov");
      const measured = verdicts.filter((verdict) => verdict !== "neutral").length;
      const covered = verdicts.filter((verdict) => verdict === "covered").length;
      files.push({
        path: repoPath,
        sourceLines,
        verdicts,
        measured,
        covered,
        percent: measured === 0 ? 100 : Math.round((covered / measured) * 10000) / 100,
      });
    }
  }
  // Worst first: the useful end of the list should not need scrolling to.
  return files.sort((a, b) => a.percent - b.percent || b.measured - a.measured);
}

// Runs of consecutive uncovered lines, which is how a reader thinks about a
// gap -- one untested function, not thirty untested lines.
export function uncoveredRuns(verdicts) {
  const runs = [];
  verdicts.forEach((verdict, index) => {
    if (verdict !== "uncovered") {
      return;
    }
    const line = index + 1;
    const last = runs[runs.length - 1];
    // A neutral line inside an untested block -- a comment between two dead
    // statements -- should not split one gap into two.
    if (last && verdicts.slice(last.end, index).every((between) => between !== "covered")) {
      last.end = line;
    } else {
      runs.push({ start: line, end: line });
    }
  });
  return runs;
}

// --- terminal ---------------------------------------------------------------

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  bold: "\u001b[1m",
};

// Colour only when stdout is a terminal, so a redirect to a file stays plain.
function paint(code, text) {
  return process.stdout.isTTY ? `${code}${text}${ANSI.reset}` : text;
}

function showFile(file) {
  const runs = uncoveredRuns(file.verdicts);
  // "code lines", not "lines": this view drops comments and blanks, so its
  // percentage is deliberately not the one in coverage/summary.md, which counts
  // every physical line because that is what Node's lcov measures.
  const header = `${file.path}  ${file.covered}/${file.measured} code lines  `
    + `${file.percent.toFixed(2)}%`;
  process.stdout.write(`\n${paint(ANSI.bold, header)}\n`);
  if (runs.length === 0) {
    process.stdout.write(`${paint(ANSI.dim, "  every measured line is covered")}\n`);
    return;
  }
  const width = String(file.sourceLines.length).length;
  for (const run of runs) {
    const from = Math.max(1, run.start - CONTEXT_LINES);
    const to = Math.min(file.sourceLines.length, run.end + CONTEXT_LINES);
    process.stdout.write(`${paint(ANSI.dim, `  @@ ${run.start}-${run.end}`)}\n`);
    for (let line = from; line <= to; line += 1) {
      const uncovered = file.verdicts[line - 1] === "uncovered";
      const gutter = `${uncovered ? "!" : " "} ${String(line).padStart(width)} | `;
      const text = `${gutter}${file.sourceLines[line - 1]}`;
      process.stdout.write(`${uncovered ? paint(ANSI.red, text) : paint(ANSI.dim, text)}\n`);
    }
  }
}

// --- html -------------------------------------------------------------------

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Each file is a <details>, closed by default, so the page opens as an index
// and a reader expands the one they came for.
function renderFileSection(file) {
  const rows = file.sourceLines.map((text, index) => {
    const verdict = file.verdicts[index];
    return `<tr class="${verdict}"><td class="n">${index + 1}</td>`
      + `<td class="s">${escapeHtml(text) || "&nbsp;"}</td></tr>`;
  });
  return [
    `<details id="${escapeHtml(file.path)}">`,
    `<summary><span class="pct ${file.percent < 60 ? "low" : ""}">`
      + `${file.percent.toFixed(2)}%</span> <code>${escapeHtml(file.path)}</code>`
      + ` <span class="meta">${file.covered}/${file.measured} code lines</span></summary>`,
    `<table>${rows.join("")}</table>`,
    "</details>",
  ].join("\n");
}

function renderHtml(files) {
  const totalMeasured = files.reduce((sum, file) => sum + file.measured, 0);
  const totalCovered = files.reduce((sum, file) => sum + file.covered, 0);
  const overall = totalMeasured === 0 ? 100 : (totalCovered / totalMeasured) * 100;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webchirp coverage</title>
<style>
:root { color-scheme: light dark; --covered: #1a7f37; --uncovered: #cf222e; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 1.5rem; }
h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
.lede { color: #656d76; margin: 0 0 1.5rem; }
details { border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: .5rem; }
summary { cursor: pointer; padding: .5rem .75rem; }
.pct { display: inline-block; min-width: 4.5em; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--covered); }
.pct.low { color: var(--uncovered); }
.meta { color: #656d76; }
table { border-collapse: collapse; width: 100%; font: 12px/1.45 ui-monospace, monospace; }
td.n { width: 1%; padding: 0 .75rem 0 .5rem; text-align: right; color: #8c959f; user-select: none; }
td.s { white-space: pre-wrap; word-break: break-word; padding-right: .5rem; }
tr.covered { background: rgba(26, 127, 55, .10); }
tr.uncovered { background: rgba(207, 34, 46, .16); }
tr.uncovered td.n { color: var(--uncovered); font-weight: 600; }
tr.neutral { color: #8c959f; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  details { border-color: #30363d; }
  .lede, .meta, td.n { color: #8b949e; }
}
</style></head><body>
<h1>webchirp coverage</h1>
<p class="lede">${overall.toFixed(2)}% of ${totalMeasured} code lines across ${files.length} files,
worst first. Green ran, red never did, grey is not measurable &mdash; a blank or
comment line in JavaScript, or a non-statement in Python.
<strong>This percentage is not the one in the job summary</strong>: that counts every
physical line, because that is what Node&rsquo;s lcov measures, so it reads higher on a
commented file. Same underlying data, stricter denominator. Generated
${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.</p>
${files.map(renderFileSection).join("\n")}
</body></html>
`;
}

// --- main -------------------------------------------------------------------

function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const files = collectFiles();

  if (requested.length === 0) {
    const target = path.join(COVERAGE_DIR, "report.html");
    fs.writeFileSync(target, renderHtml(files));
    process.stdout.write(`Wrote ${path.relative(repoRoot, target)} (${files.length} files)\n`);
    process.stdout.write("Open it, or run npm run coverage:show -- <path> for one file.\n");
    return;
  }

  // A path may be given as typed on the command line or as it appears in the
  // lcov, and a fragment is enough as long as it picks out something.
  for (const request of requested) {
    const normalised = path.relative(repoRoot, path.resolve(request));
    const matches = files.filter((file) => file.path === normalised || file.path.includes(request));
    if (matches.length === 0) {
      process.stderr.write(`No coverage data for ${request}\n`);
      process.exitCode = 1;
      continue;
    }
    matches.forEach(showFile);
  }
}

// Guarded so a test can import the helpers without writing files.
if (import.meta.main) {
  main();
}

// Runs the whole test suite under coverage and writes the artifacts CI needs.
//
// Two languages, two mechanisms, one report. JavaScript is measured by Node's
// own V8 coverage; the Python runtime is measured by coverage.py running
// inside Pyodide (scripts/test-support/python-coverage.mjs). Both end up as
// lcov plus a merged summary, so a reader sees one number per language and CI
// can gate on both.
//
// Outputs, all under coverage/ (gitignored):
//   js.lcov        line/branch/function coverage of web/**, from V8
//   python.lcov    line coverage of web/python/webchirp_bridge/**
//   summary.json   machine-readable totals, uploaded so a later run can diff
//   summary.md     the GitHub Actions job summary
//
// Usage:
//   npm run coverage                       measure, report, fail below the floors
//   npm run coverage -- --update-floors    rewrite coverage-floors.json to match
//   npm run coverage -- --baseline <file>  add a delta column against an earlier
//                                          summary.json (CI passes the last
//                                          successful master run's artifact, so a
//                                          PR shows movement, not just a level)
//
// WEBCHIRP_COVERAGE_BASELINE is the same setting as --baseline. CI uses the
// variable because npm eats an unknown flag name when a script chains into
// another npm run, so only the value would survive the hop.
//
// The floors live in a committed file rather than in this script so the ratchet
// is visible in git history: every PR that raises coverage raises the floor in
// the same commit, and git log over that one file is the trend line.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { toRepoPath } from "./test-support/python-coverage.mjs";
import { repoRoot } from "./test-support/repo-paths.mjs";

const COVERAGE_DIR = path.join(repoRoot, "coverage");
const FRAGMENT_DIR = path.join(COVERAGE_DIR, "python-fragments");
const FLOORS_PATH = path.join(repoRoot, "coverage-floors.json");

// The suites worth measuring. Read out of package.json rather than repeated
// here, so a test file added to npm test is measured without a second edit --
// and so this cannot drift into measuring a subset while claiming a total.
// test:api and test:hw are excluded: one calls a live third-party API, the
// other needs a radio on a serial port.
const MEASURED_SUITES = ["test:channels", "test:webusb", "test:settings", "test:build"];

function testFilesFromPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const files = new Set();
  for (const suite of MEASURED_SUITES) {
    const command = pkg.scripts[suite];
    if (!command) {
      throw new Error(`package.json has no script named ${suite}`);
    }
    for (const match of command.matchAll(/scripts\/[\w-]+\.mjs/g)) {
      files.add(match[0]);
    }
  }
  return [...files].sort();
}

// --- lcov -------------------------------------------------------------------

// Totals per file from an lcov file, keyed by source path.
function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const [key, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)];
    if (key === "SF") {
      current = { lines: 0, linesHit: 0, branches: 0, branchesHit: 0, functions: 0, functionsHit: 0 };
      files.set(value.trim(), current);
    } else if (!current) {
      continue;
    } else if (key === "LF") current.lines = Number(value);
    else if (key === "LH") current.linesHit = Number(value);
    else if (key === "BRF") current.branches = Number(value);
    else if (key === "BRH") current.branchesHit = Number(value);
    else if (key === "FNF") current.functions = Number(value);
    else if (key === "FNH") current.functionsHit = Number(value);
    else if (key === "end_of_record") current = null;
  }
  return files;
}

// An lcov file carrying line hits only, which is all coverage.py's fragments
// give us. Enough for GitHub annotations and for every lcov reader worth using.
function writeLineOnlyLcov(targetPath, filesByPath) {
  const chunks = ["TN:"];
  for (const [sourcePath, data] of [...filesByPath].sort(([a], [b]) => a.localeCompare(b))) {
    chunks.push(`SF:${sourcePath}`);
    const executed = new Set(data.executed);
    for (const line of data.statements) {
      chunks.push(`DA:${line},${executed.has(line) ? 1 : 0}`);
    }
    chunks.push(`LF:${data.statements.length}`, `LH:${executed.size}`, "end_of_record");
  }
  fs.writeFileSync(targetPath, `${chunks.join("\n")}\n`);
}

// --- running the suite ------------------------------------------------------

function runSuiteWithCoverage(testFiles) {
  const args = [
    "--test",
    "--experimental-wasm-stack-switching",
    "--experimental-test-coverage",
    // Measure what ships, not the scripts that exercise it.
    "--test-coverage-include=web/**",
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${path.join(COVERAGE_DIR, "js.lcov")}`,
    ...testFiles,
  ];
  // Thresholds are enforced below against both languages at once, so the test
  // run itself only has to report; a non-zero exit here means a real failure.
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, WEBCHIRP_PY_COVERAGE: FRAGMENT_DIR },
  });
}

// Union the per-process fragments. Statements are unioned so a module some
// processes never imported keeps its full statement count, and executed lines
// are unioned so a line reached by any test counts as reached.
function mergePythonFragments() {
  if (!fs.existsSync(FRAGMENT_DIR)) {
    return new Map();
  }
  const merged = new Map();
  for (const name of fs.readdirSync(FRAGMENT_DIR)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const fragment = JSON.parse(fs.readFileSync(path.join(FRAGMENT_DIR, name), "utf8"));
    for (const [runtimePath, data] of Object.entries(fragment)) {
      const key = toRepoPath(runtimePath);
      const existing = merged.get(key) || { statements: new Set(), executed: new Set() };
      data.statements.forEach((line) => existing.statements.add(line));
      data.executed.forEach((line) => existing.executed.add(line));
      merged.set(key, existing);
    }
  }
  return new Map(
    [...merged].map(([key, value]) => [
      key,
      { statements: [...value.statements].sort((a, b) => a - b), executed: [...value.executed] },
    ]),
  );
}

// --- summarising ------------------------------------------------------------

function percent(hit, total) {
  return total === 0 ? 100 : Math.round((hit / total) * 10000) / 100;
}

function summarise(files, pick) {
  let total = 0;
  let hit = 0;
  for (const data of files.values()) {
    const [fileTotal, fileHit] = pick(data);
    total += fileTotal;
    hit += fileHit;
  }
  return { total, hit, percent: percent(hit, total) };
}

function buildSummary(jsFiles, pythonFiles) {
  return {
    js: {
      lines: summarise(jsFiles, (d) => [d.lines, d.linesHit]),
      branches: summarise(jsFiles, (d) => [d.branches, d.branchesHit]),
      functions: summarise(jsFiles, (d) => [d.functions, d.functionsHit]),
      files: jsFiles.size,
    },
    python: {
      lines: summarise(pythonFiles, (d) => [d.statements.length, new Set(d.executed).size]),
      files: pythonFiles.size,
    },
    generatedAt: new Date().toISOString(),
  };
}

// Per-file rows, worst first: the useful end of the table is the bottom of the
// ranking, and a reader scanning a job summary should not have to sort it.
function fileRows(files, pick) {
  return [...files]
    .map(([name, data]) => {
      const [total, hit] = pick(data);
      return { name, total, hit, percent: percent(hit, total) };
    })
    .sort((a, b) => a.percent - b.percent || b.total - a.total);
}

function markdownTable(rows, limit) {
  const shown = rows.slice(0, limit);
  const lines = ["| file | lines | covered |", "| --- | ---: | ---: |"];
  for (const row of shown) {
    lines.push(`| \`${row.name}\` | ${row.total} | ${row.percent.toFixed(2)}% |`);
  }
  if (rows.length > shown.length) {
    lines.push(`| _…${rows.length - shown.length} more at or above this level_ | | |`);
  }
  return lines.join("\n");
}

function renderMarkdown(summary, jsFiles, pythonFiles, floors, failures, baseline) {
  const { js, python } = summary;
  const gate = failures.length === 0 ? "✅ all floors met" : `❌ ${failures.length} floor(s) breached`;
  return [
    "## Coverage",
    "",
    `${gate}`,
    "",
    ...(baseline ? ["Change in brackets is against the last successful master run.", ""] : []),
    "| scope | lines | branches | functions | files |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| JavaScript (\`web/**\`) `
      + `| ${js.lines.percent.toFixed(2)}%${delta(baseline, (b) => b.js?.lines?.percent, js.lines.percent)} `
      + `| ${js.branches.percent.toFixed(2)}%${delta(baseline, (b) => b.js?.branches?.percent, js.branches.percent)} `
      + `| ${js.functions.percent.toFixed(2)}%${delta(baseline, (b) => b.js?.functions?.percent, js.functions.percent)} `
      + `| ${js.files} |`,
    `| Python (\`webchirp_bridge\`) `
      + `| ${python.lines.percent.toFixed(2)}%${delta(baseline, (b) => b.python?.lines?.percent, python.lines.percent)} `
      + `| — | — | ${python.files} |`,
    "",
    `Floors: JS lines ${floors.js.lines}%, JS branches ${floors.js.branches}%, `
      + `JS functions ${floors.js.functions}%, Python lines ${floors.python.lines}%.`,
    ...(failures.length ? ["", "### Below floor", "", ...failures.map((f) => `- ${f}`)] : []),
    "",
    "<details><summary>Least-covered JavaScript files</summary>",
    "",
    markdownTable(fileRows(jsFiles, (d) => [d.lines, d.linesHit]), 15),
    "",
    "</details>",
    "",
    "<details><summary>Python runtime, per module</summary>",
    "",
    markdownTable(
      fileRows(pythonFiles, (d) => [d.statements.length, new Set(d.executed).size]),
      50,
    ),
    "",
    "</details>",
    "",
    "_Two caveats on the numbers. Node's V8 line coverage counts every physical "
      + "line, comments and blanks included, so the JavaScript line figure is not "
      + "the statement coverage coverage.py reports for Python -- compare each "
      + "against its own history, not against the other. Branch and function "
      + "percentages have no such caveat. And web/python/runtime_bridge.py is not "
      + "instrumentable at all: it is executed as a string rather than imported, so "
      + "CPython compiles it as `<exec>` and coverage cannot map it to a file._",
    "",
  ].join("\n");
}

// --- baseline ---------------------------------------------------------------

// An earlier run's summary.json, or null. Absence is normal and not an error:
// the first run on a branch has nothing to compare against, and a report
// without a delta column is still a report.
function readBaseline(baselinePath) {
  if (!baselinePath || !fs.existsSync(baselinePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch {
    return null;
  }
}

// A signed delta against the baseline, or "" when there is nothing to compare.
// Rendered to two decimals like the levels themselves, so a column of them
// lines up and a change smaller than that reads as no change rather than noise.
function delta(baseline, pick, current) {
  const previous = baseline && pick(baseline);
  if (typeof previous !== "number") {
    return "";
  }
  const change = current - previous;
  if (Math.abs(change) < 0.005) {
    return " (=)";
  }
  return ` (${change > 0 ? "+" : "\u2212"}${Math.abs(change).toFixed(2)})`;
}

// --- floors -----------------------------------------------------------------

function readFloors() {
  return JSON.parse(fs.readFileSync(FLOORS_PATH, "utf8"));
}

function checkFloors(summary, floors) {
  const checks = [
    ["JS lines", summary.js.lines.percent, floors.js.lines],
    ["JS branches", summary.js.branches.percent, floors.js.branches],
    ["JS functions", summary.js.functions.percent, floors.js.functions],
    ["Python lines", summary.python.lines.percent, floors.python.lines],
  ];
  return checks
    .filter(([, actual, floor]) => actual < floor)
    .map(([label, actual, floor]) => `${label}: ${actual.toFixed(2)}% is below the ${floor}% floor`);
}

// How far below the measured value a floor is set. Coverage is not
// deterministic across runs: the same commit measured 81.04% then 80.94% of JS
// branches, roughly three branches out of 2605, because some of what the suite
// exercises is timing-dependent (test-driver-import-race.mjs races two imports
// on purpose, and async ordering decides which arm of a few guards runs). A
// floor set at the last measurement therefore fails intermittently on an
// unchanged branch. Half a point absorbs that jitter and still catches a real
// regression, which moves coverage by whole points, not tenths.
const FLOOR_TOLERANCE_POINTS = 0.5;

// Set the floors below what was measured, by the tolerance above, rounded down
// to one decimal.
function updateFloors(summary) {
  const down = (value) => Math.floor((value - FLOOR_TOLERANCE_POINTS) * 10) / 10;
  const next = {
    js: {
      lines: down(summary.js.lines.percent),
      branches: down(summary.js.branches.percent),
      functions: down(summary.js.functions.percent),
    },
    python: { lines: down(summary.python.lines.percent) },
  };
  fs.writeFileSync(FLOORS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// --- main -------------------------------------------------------------------

function main() {
  const updating = process.argv.includes("--update-floors");
  const baselineFlag = process.argv.indexOf("--baseline");
  const baselinePath = baselineFlag === -1
    ? String(process.env.WEBCHIRP_COVERAGE_BASELINE || "")
    : process.argv[baselineFlag + 1];
  const baseline = readBaseline(baselinePath);
  fs.rmSync(COVERAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAGMENT_DIR, { recursive: true });

  runSuiteWithCoverage(testFilesFromPackageJson());

  const jsFiles = parseLcov(fs.readFileSync(path.join(COVERAGE_DIR, "js.lcov"), "utf8"));
  const pythonFiles = mergePythonFragments();
  if (pythonFiles.size === 0) {
    throw new Error(
      "no Python coverage was collected; check that scripts/test-radio-harness.mjs still calls startPythonCoverage()",
    );
  }
  writeLineOnlyLcov(path.join(COVERAGE_DIR, "python.lcov"), pythonFiles);

  const summary = buildSummary(jsFiles, pythonFiles);
  const floors = updating ? updateFloors(summary) : readFloors();
  const failures = checkFloors(summary, floors);

  fs.writeFileSync(
    path.join(COVERAGE_DIR, "summary.json"),
    `${JSON.stringify({ ...summary, floors }, null, 2)}\n`,
  );
  const markdown = renderMarkdown(summary, jsFiles, pythonFiles, floors, failures, baseline);
  fs.writeFileSync(path.join(COVERAGE_DIR, "summary.md"), markdown);
  // Fragments are an implementation detail of the merge; the artifact should
  // carry the merged result, not a pile of per-process files.
  fs.rmSync(FRAGMENT_DIR, { recursive: true, force: true });

  process.stdout.write(`\n${markdown.split("<details>")[0]}\n`);
  process.stdout.write(`Artifacts written to ${path.relative(repoRoot, COVERAGE_DIR)}/\n`);

  if (updating) {
    process.stdout.write(`Floors updated in ${path.relative(repoRoot, FLOORS_PATH)}\n`);
    return;
  }
  if (failures.length) {
    process.stderr.write(`\nCoverage below floor:\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

main();

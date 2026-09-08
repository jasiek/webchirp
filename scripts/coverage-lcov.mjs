// lcov parsing, shared by scripts/coverage.mjs (which wants per-file totals)
// and scripts/coverage-patch.mjs (which wants per-line hits). One parser so the
// two can never disagree about what a file's coverage is.
//
// Both lcov files this repo produces are read here: coverage/js.lcov, written
// by Node's own lcov test reporter, and coverage/python.lcov, written by
// scripts/coverage.mjs from the coverage.py fragments.

// Totals and per-line hit counts per source file, keyed by the path in SF.
// lineHits holds one entry per DA record: for JavaScript that is every physical
// line of the file, for Python only the executable statements.
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of String(text).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      if (line.trim() === "end_of_record") {
        current = null;
      }
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "SF") {
      current = {
        lines: 0,
        linesHit: 0,
        branches: 0,
        branchesHit: 0,
        functions: 0,
        functionsHit: 0,
        lineHits: new Map(),
      };
      files.set(value.trim(), current);
    } else if (!current) {
      continue;
    } else if (key === "DA") {
      const [lineNumber, hits] = value.split(",");
      current.lineHits.set(Number(lineNumber), Number(hits));
    } else if (key === "LF") current.lines = Number(value);
    else if (key === "LH") current.linesHit = Number(value);
    else if (key === "BRF") current.branches = Number(value);
    else if (key === "BRH") current.branchesHit = Number(value);
    else if (key === "FNF") current.functions = Number(value);
    else if (key === "FNH") current.functionsHit = Number(value);
  }
  return files;
}

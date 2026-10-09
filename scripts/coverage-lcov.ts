// lcov parsing, shared by scripts/coverage.ts (which wants per-file totals)
// and scripts/coverage-patch.ts (which wants per-line hits). One parser so the
// two can never disagree about what a file's coverage is.
//
// Both lcov files this repo produces are read here: coverage/js.lcov, written
// by Node's own lcov test reporter, and coverage/python.lcov, written by
// scripts/coverage.ts from the coverage.py fragments.

/** One SF record: its totals and the hit count of every line it lists. */
export interface LcovFile {
  lines: number;
  linesHit: number;
  branches: number;
  branchesHit: number;
  functions: number;
  functionsHit: number;
  lineHits: Map<number, number>;
}

// Totals and per-line hit counts per source file, keyed by the path in SF.
// lineHits holds one entry per DA record: for JavaScript that is every physical
// line of the file, for Python only the executable statements.
export function parseLcov(text: string): Map<string, LcovFile> {
  const files = new Map<string, LcovFile>();
  let current: LcovFile | null = null;
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

// Node's lcov emits a DA record for every physical line, comments and blanks
// included (FINDINGS.md, v8-line-coverage-counts-comments-and-blanks), so a
// comment inside an untested function is reported as an uncovered line. Callers
// use this to tell real gaps from prose. It is a heuristic -- it cannot see a
// comment marker inside a string literal -- and it only ever moves a line out
// of the count, so its failure mode is understating a gap, not inventing one.
// Python needs none of this: its lcov comes from coverage.py, whose DA records
// are executable statements already.
export function isJsCodeLine(sourceLine: string | null | undefined): boolean {
  const trimmed = String(sourceLine || "").trim();
  if (trimmed === "") {
    return false;
  }
  return !/^(\/\/|\/\*|\*\/|\*)/.test(trimmed);
}

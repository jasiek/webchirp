// Line-level readers of the TypeScript sources for
// tests/build/source-conventions.mjs. Each turns one convention that used to
// be CLAUDE.md prose into a list of offending "file:line ..." entries, so the
// test can say exactly where a rule is broken and how to fix it. They read text,
// not an AST: tsc 7 has no JavaScript API, and every rule here is visible at
// the start of a line or in an import specifier.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./repo-paths.mjs";

// Every TypeScript source tsc checks (declaration files excluded), repo-relative.
export function typeScriptSources() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(repoRoot, rel);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(path.join(rel, name));
    } else if (rel.endsWith(".ts") && !rel.endsWith(".d.ts")) {
      files.push(rel.split(path.sep).join("/"));
    }
  };
  for (const root of ["web/js", "web/app.ts", "web/sw.ts", "scripts"]) walk(root);
  return files;
}

// A file's lines, read once per run.
const cache = new Map();
export function sourceLines(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(path.join(repoRoot, rel), "utf8").split("\n"));
  return cache.get(rel);
}

// Whether a line is (part of) a comment, so text checks skip prose about a rule.
export function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

// The code lines of a file with their 1-based numbers, comments left out.
export function codeLines(rel) {
  return sourceLines(rel)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => !isCommentLine(text));
}

// Whether the lines directly above index (up to `reach` of them) hold a comment.
function commentAbove(lines, index, reach) {
  for (let i = index - 1; i >= 0 && i >= index - reach; i -= 1) {
    if (isCommentLine(lines[i]) || lines[i].trimEnd().endsWith("*/")) return true;
  }
  return false;
}

const FUNCTION_DECLARATION = /^(export (default )?)?(async )?function\*? *([A-Za-z_$][\w$]*)/;

// Top-level function declarations with no comment directly above them, as
// "file#name": the name, not the line, so the list survives edits elsewhere.
export function uncommentedFunctions(files) {
  const found = [];
  for (const rel of files) {
    const lines = sourceLines(rel);
    lines.forEach((text, index) => {
      const match = FUNCTION_DECLARATION.exec(text);
      if (match && !commentAbove(lines, index, 1)) found.push(`${rel}#${match[4]}`);
    });
  }
  return found;
}

// Exported function declarations whose signature names no return type.
export function untypedExportReturns(files) {
  const found = [];
  for (const rel of files) {
    const lines = sourceLines(rel);
    const source = lines.join("\n");
    let offset = 0;
    lines.forEach((text) => {
      const match = FUNCTION_DECLARATION.exec(text);
      if (match && match[1]) {
        // Walk to the parenthesis closing the parameter list, then look at what follows.
        let depth = 0;
        let i = source.indexOf("(", offset);
        for (; i < source.length; i += 1) {
          if (source[i] === "(") depth += 1;
          else if (source[i] === ")" && --depth === 0) break;
        }
        if (!source.slice(i + 1).trimStart().startsWith(":")) found.push(`${rel}#${match[4]}`);
      }
      offset += text.length + 1;
    });
  }
  return found;
}

// An explicit any in a type position: an annotation, a type argument, an array.
const EXPLICIT_ANY = /(:\s*any\b|<any\b|\bany\[\]|\bas any\b|\|\s*any\b|,\s*any>)/;

// Explicit anys with no comment on their line or in the three lines above.
export function uncommentedAnys(files) {
  const found = [];
  for (const rel of files) {
    const lines = sourceLines(rel);
    lines.forEach((text, index) => {
      if (isCommentLine(text) || !EXPLICIT_ANY.test(text.replace(/\/\/.*$/, ""))) return;
      if (!text.includes("//") && !commentAbove(lines, index, 3)) found.push(`${rel}:${index + 1}`);
    });
  }
  return found;
}

// Every relative import specifier ("./x.ts", "../y.js") in a file, with its line.
export function relativeImports(rel) {
  const found = [];
  sourceLines(rel).forEach((text, index) => {
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g)) {
      found.push({ specifier: match[1], line: index + 1 });
    }
  });
  return found;
}

// Relative imports Node cannot resolve as written: anything but an existing
// .ts file (or .mjs, which tests/support stays in), or a .js specifier standing
// for a declaration file beside it.
export function unresolvableImports(files) {
  const found = [];
  for (const rel of files) {
    for (const { specifier, line } of relativeImports(rel)) {
      const target = path.join(repoRoot, path.dirname(rel), specifier);
      const ok = /\.m?ts$|\.mjs$/.test(specifier)
        ? existsSync(target)
        : specifier.endsWith(".js") && existsSync(target.replace(/\.js$/, ".d.ts"));
      if (!ok) found.push(`${rel}:${line} imports "${specifier}"`);
    }
  }
  return found;
}

// Code lines (comments skipped) of the given files that match a pattern.
export function codeMatches(files, pattern) {
  const found = [];
  for (const rel of files) {
    for (const { text, line } of codeLines(rel)) {
      if (pattern.test(text)) found.push(`${rel}:${line}`);
    }
  }
  return found;
}

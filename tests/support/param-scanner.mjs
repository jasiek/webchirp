// Reads the object literal at a call site out of source text, for the coverage
// checks that keep a declared vocabulary honest: every parameter a trackEvent()
// call sends has to be in CUSTOM_DIMENSIONS (tests/channels/ga-dimensions.mjs),
// and every attribute a recordFlow() call sends has to be in METRIC_ATTRIBUTES
// (tests/channels/metrics.mjs). Both failures are silent at runtime -- GA drops an
// undeclared parameter, web/js/sentry.js drops an undeclared attribute -- so
// reading the calls themselves beats a hand-kept list that drifts.
//
// It is deliberately a text scan rather than a parse: the alternative is a
// JavaScript parser as a dependency, for a check whose whole job is to be
// cheap and to run on every commit.

import fs from "node:fs";
import path from "node:path";

// Blank out comments, keeping the source's length and line structure so the
// offsets below stay meaningful. Without this a comment inside the object
// literal fails the build: any "word:" in prose -- "an honest third value: the
// browser chose" -- reads as a key and is reported as an undeclared parameter,
// which is a confusing failure a long way from its cause.
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

// Top-level keys of the first object literal passed to each call of `name`.
// Only a literal at the call site is visible: a parameter bag hoisted into a
// variable is invisible here and silently drops that call from the check, which
// is why the call sites keep their literals and hoist shared values instead.
export function callArgumentKeys(source, name) {
  const text = blankComments(source);
  const names = new Set();
  const token = `${name}(`;
  for (let start = text.indexOf(token); start !== -1; start = text.indexOf(token, start + 1)) {
    let depth = 0;
    let objectStart = -1;
    for (let index = start + name.length; index < text.length; index += 1) {
      const char = text[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      } else if (char === "{" && depth === 1) {
        objectStart = index;
        break;
      }
    }
    if (objectStart === -1) {
      continue;
    }
    let braces = 0;
    for (let index = objectStart; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") {
        braces += 1;
      } else if (char === "}") {
        braces -= 1;
        if (braces === 0) {
          break;
        }
      } else if (braces === 1 && /[A-Za-z_]/.test(char) && /[{,\s]/.test(text[index - 1])) {
        const key = text.slice(index).match(/^[A-Za-z_]\w*(?=\s*:)/);
        if (key) {
          names.add(key[0]);
        }
      }
    }
  }
  return names;
}

// Every JavaScript source under a directory, recursively. The coverage checks
// have to see all of them because a call site can be added in any module, and
// web/js is nested -- a flat listing would quietly stop covering web/js/ui,
// which is where most of them are.
export function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

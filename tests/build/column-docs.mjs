// The grid's column descriptions are CHIRP's, copied into
// web/js/ui/column-docs.js because the module that holds them upstream
// (chirp/chirp/wxui/memedit.py) imports wx and can never load in Pyodide. A
// copy of someone else's data goes stale silently -- CHIRP rewords a column,
// the app keeps showing last year's sentence, and nothing anywhere fails --
// so this re-derives the table from the pinned submodule and compares.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CHANNEL_COLUMN_DOCS, columnDoc } from "../../web/js/ui/column-docs.js";
import { repoRoot } from "../support/repo-paths.mjs";

const MEMEDIT_PATH = path.join(repoRoot, "chirp", "chirp", "wxui", "memedit.py");
const GENERIC_CSV_PATH = path.join(repoRoot, "chirp", "chirp", "drivers", "generic_csv.py");

// CrossMode's CHIRP help ends with a clause about the desktop editor's tone
// wizard, which this app has no equivalent of. See web/js/ui/column-docs.js.
const TRIMMED_SUFFIX = { CrossMode: " (starts the tone mode selection wizard)" };

// The body of the first {...} after a marker, brace-matched rather than
// regexed: generic_csv.py declares ATTR_MAP three times (one per CSV dialect)
// and only the first, on CSVRadio, describes the headers this app uses.
function braceBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} is gone from the pinned CHIRP source`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unterminated ${marker} block`);
}

// Python concatenates adjacent string literals, which is how the longer help
// strings are written; joining every literal in the group reproduces the value
// Python would build.
function pythonString(literals) {
  return [...literals.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]).join("");
}

// DEFAULT_COLUMN_HELP: memory attribute -> gettext-wrapped help string.
function chirpColumnHelp() {
  const block = braceBlock(fs.readFileSync(MEMEDIT_PATH, "utf8"), "DEFAULT_COLUMN_HELP");
  const help = {};
  for (const match of block.matchAll(/'(\w+)':\s*_\(\s*((?:'(?:[^'\\]|\\.)*'\s*)+)\)/g)) {
    help[match[1]] = pythonString(match[2]);
  }
  return help;
}

// CSVRadio.ATTR_MAP: CSV header -> (parser, memory attribute).
function chirpCsvAttributes() {
  const block = braceBlock(fs.readFileSync(GENERIC_CSV_PATH, "utf8"), "ATTR_MAP");
  const attributes = {};
  for (const match of block.matchAll(/"(\w+)":\s*\(\s*[^,]+,\s*"(\w+)"\s*\)/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function expectedDocs() {
  const help = chirpColumnHelp();
  const attributes = chirpCsvAttributes();
  const docs = {};
  for (const [header, attribute] of Object.entries(attributes)) {
    if (help[attribute]) {
      const suffix = TRIMMED_SUFFIX[header];
      assert.ok(
        !suffix || help[attribute].endsWith(suffix),
        `${header} no longer ends with the clause column-docs.js trims: ${help[attribute]}`,
      );
      docs[header] = suffix ? help[attribute].slice(0, -suffix.length) : help[attribute];
    }
  }
  return docs;
}

test("the CHIRP source the descriptions are copied from still parses", () => {
  const help = chirpColumnHelp();
  const attributes = chirpCsvAttributes();
  // Both parsers match on shape, so a refactor upstream could leave them
  // finding nothing and this file would pass by comparing two empty tables.
  assert.ok(Object.keys(help).length >= 10, "DEFAULT_COLUMN_HELP parsed as near-empty");
  assert.equal(attributes.Frequency, "freq");
  assert.equal(attributes.TStep, "tuning_step");
  assert.equal(help.freq, "Receive frequency");
});

test("every column description matches the pinned CHIRP revision", () => {
  assert.deepEqual(
    { ...CHANNEL_COLUMN_DOCS },
    expectedDocs(),
    "web/js/ui/column-docs.js disagrees with chirp/chirp/wxui/memedit.py; "
    + "update it to CHIRP's current wording",
  );
});

test("columns CHIRP documents nowhere report no description", () => {
  // Location is a memory slot rather than a property of the signal, and the
  // D-STAR call columns have never had an entry; both must come back blank
  // rather than as "undefined" text under a label.
  for (const header of ["Location", "URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]) {
    assert.equal(columnDoc(header), "");
  }
  assert.equal(columnDoc("Frequency"), "Receive frequency");
});

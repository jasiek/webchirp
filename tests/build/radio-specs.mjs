import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { repoRoot, webDir } from "../support/repo-paths.mjs";

// radio-specs.json is researched by hand from spec sheets and manuals, like
// radio-firmware.json, and so has the same failure modes: keys that drift from
// the catalog's spelling, radios nobody looked at, and entries whose shape the
// generator does not expect. The generator itself rejects values it cannot
// render (validateSpecs in scripts/build-model-pages.mjs); these check the rest.
const FIELDS = [
  "formFactor",
  "batteryMah",
  "charging",
  "powerW",
  "txMHz",
  "rxMHz",
  "modulations",
  "display",
  "inProduction",
  "dualReceive",
  "crossBandRepeater",
  "aprs",
  "gps",
  "bluetoothProgramming",
  "sources",
  "note",
];

async function readJson(...segments) {
  return JSON.parse(await fs.readFile(path.join(...segments), "utf8"));
}

test("every spec key names a radio the catalog still has", async () => {
  const catalog = await readJson(webDir, "radio-catalog.json");
  const specs = await readJson(repoRoot, "radio-specs.json");

  const models = new Set(catalog.radios.map((radio) => `${radio.vendor}|${radio.model}`));
  // A key spelled differently from the catalog is research that resolves to no
  // page at all, with nothing in the build output to say so.
  const stray = Object.keys(specs.models).filter((key) => !models.has(key));
  assert.deepEqual(stray, [], "radio-specs.json records models the catalog does not");
});

test("every model in the catalog has been researched", async () => {
  const catalog = await readJson(webDir, "radio-catalog.json");
  const specs = await readJson(repoRoot, "radio-specs.json");

  // An all-null entry is a legitimate answer, so this asks only that somebody
  // looked. A radio CHIRP adds later fails here instead of quietly getting a
  // page with no hardware section.
  const missing = [...new Set(catalog.radios.map((radio) => `${radio.vendor}|${radio.model}`))]
    .filter((key) => !(key in specs.models))
    .sort();
  assert.deepEqual(missing, [], "new radios need a specs entry, even if every field is null");
});

test("every entry has exactly the recorded fields, with usable sources and notes", async () => {
  const specs = await readJson(repoRoot, "radio-specs.json");

  for (const [key, entry] of Object.entries(specs.models)) {
    assert.deepEqual(Object.keys(entry).sort(), [...FIELDS].sort(), `${key} has the wrong fields`);
    assert.equal(typeof entry.note, "string", `${key} has a non-string note`);
    assert.equal(entry.note, entry.note.trim(), `${key} has a note with loose whitespace`);
    assert.ok(entry.note.length <= 200, `${key} has a note of ${entry.note.length} characters`);
    assert.ok(Array.isArray(entry.sources), `${key} has no sources list`);
    for (const source of entry.sources) {
      const url = new URL(source);
      assert.equal(url.protocol, "https:", `${key} cites ${source} over ${url.protocol}`);
    }
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { repoRoot, webDir } from "../support/repo-paths.mjs";

// Both files are written by one run of scripts/build-catalog.mjs. Committing
// them means the per-model page generator does not need a Pyodide boot, but it
// also means either can go stale on its own -- adding a radio and rebuilding
// only the catalog would leave the new model with no page and no error.
async function readJson(...segments) {
  return JSON.parse(await fs.readFile(path.join(...segments), "utf8"));
}

test("every catalogued radio has recorded features", async () => {
  const catalog = await readJson(webDir, "radio-catalog.json");
  const { features } = await readJson(repoRoot, "radio-features.json");

  const missing = catalog.radios.filter((radio) => !(radio.key in features));
  assert.deepEqual(
    missing.map((radio) => radio.key),
    [],
    "radio-features.json is stale: run npm run build:catalog",
  );

  const extra = Object.keys(features).filter(
    (key) => !catalog.radios.some((radio) => radio.key === key),
  );
  assert.deepEqual(extra, [], "radio-features.json describes radios the catalog does not list");
});

test("both build artifacts come from the same CHIRP revision", async () => {
  const catalog = await readJson(webDir, "radio-catalog.json");
  const features = await readJson(repoRoot, "radio-features.json");

  assert.equal(features.chirpRevision, catalog.chirpRevision);
});

test("recorded features are usable as page copy", async () => {
  const { features } = await readJson(repoRoot, "radio-features.json");

  for (const [key, entry] of Object.entries(features)) {
    const [low, high] = entry.memoryBounds;
    assert.ok(Number.isInteger(low) && Number.isInteger(high), `${key} has non-integer bounds`);
    assert.ok(high >= low, `${key} has an inverted channel range`);
    assert.ok(Array.isArray(entry.modes), `${key} has no mode list`);
    for (const band of entry.bands) {
      assert.equal(band.length, 2, `${key} has a malformed band`);
      assert.ok(band[1] > band[0], `${key} has an inverted band`);
    }
  }
});

// The generator's own skip rule, pinned here so a CHIRP bump that guts a
// driver's advertised capabilities shows up as a failing build rather than as
// a page claiming a radio holds zero channels.
test("the radios the keyword research targets describe themselves fully", async () => {
  const { features } = await readJson(repoRoot, "radio-features.json");

  for (const key of ["uv5r:BaofengUV5RGeneric", "h777:H777Radio", "uv5r:BaofengUV82Radio"]) {
    const entry = features[key];
    assert.ok(entry, `${key} is absent from radio-features.json`);
    assert.ok(entry.memoryBounds[1] > entry.memoryBounds[0], `${key} reports no channels`);
    assert.ok(entry.bands.length > 0, `${key} reports no bands`);
    assert.ok(Object.keys(entry.powerLevels).length > 0, `${key} reports no power levels`);
  }
});

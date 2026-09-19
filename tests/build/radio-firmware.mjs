import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { repoRoot, webDir } from "../support/repo-paths.mjs";

// radio-firmware.json is the only page input that is not generated. The other
// two fall out of a CHIRP driver, and go stale visibly -- add a radio, rebuild
// the catalog alone, and tests/build/radio-features.mjs says so. This one is
// written by hand from manufacturer download pages, because no driver knows
// whether the radio it talks to can take new firmware, and hand-written means
// its keys can drift from the catalog's spelling with nothing to notice.
//
// So these are the checks that would otherwise be nobody's job: that every key
// names a radio that exists, that every vendor has been considered at all, and
// that what is recorded is renderable as page copy.
const STATUSES = new Set(["official", "service", "community", "none", "unknown"]);

async function readJson(...segments) {
  return JSON.parse(await fs.readFile(path.join(...segments), "utf8"));
}

function entriesOf(firmware) {
  return [
    ...Object.entries(firmware.vendors).map(([key, entry]) => [`vendors.${key}`, entry]),
    ...Object.entries(firmware.models).map(([key, entry]) => [`models.${key}`, entry]),
  ];
}

test("every firmware key names a radio the catalog still has", async () => {
  const catalog = await readJson(webDir, "radio-catalog.json");
  const firmware = await readJson(repoRoot, "radio-firmware.json");

  const vendors = new Set(catalog.radios.map((radio) => radio.vendor));
  const models = new Set(catalog.radios.map((radio) => `${radio.vendor}|${radio.model}`));

  const strayVendors = Object.keys(firmware.vendors).filter((vendor) => !vendors.has(vendor));
  assert.deepEqual(strayVendors, [], "radio-firmware.json records vendors the catalog does not");

  // A model key the catalog spells differently is research that was done and
  // then silently lost: it resolves to nothing, the page falls back to the
  // vendor default, and no build output says so.
  const strayModels = Object.keys(firmware.models).filter((key) => !models.has(key));
  assert.deepEqual(strayModels, [], "radio-firmware.json records models the catalog does not");
});

test("every vendor in the catalog has been considered", async () => {
  const catalog = await readJson(webDir, "radio-catalog.json");
  const firmware = await readJson(repoRoot, "radio-firmware.json");

  // "unknown" is a legitimate entry, so this asks only that somebody looked.
  // A vendor that appears when CHIRP adds drivers should fail here rather than
  // quietly join the set of radios whose pages say nothing about firmware.
  const missing = [...new Set(catalog.radios.map((radio) => radio.vendor))]
    .filter((vendor) => !(vendor in firmware.vendors))
    .sort();
  assert.deepEqual(
    missing,
    [],
    "new vendors need a firmware answer, even if that answer is unknown",
  );
});

test("recorded answers are usable as page copy", async () => {
  const firmware = await readJson(repoRoot, "radio-firmware.json");

  for (const [key, entry] of entriesOf(firmware)) {
    assert.ok(STATUSES.has(entry.status), `${key} has status "${entry.status}"`);
    assert.equal(typeof entry.note, "string", `${key} has a non-string note`);
    assert.equal(entry.note, entry.note.trim(), `${key} has a note with loose whitespace`);
    // The note is one clause appended to a generated sentence, not a paragraph:
    // anything longer is prose that belongs on the manufacturer's own page.
    assert.ok(entry.note.length <= 200, `${key} has a note of ${entry.note.length} characters`);
    if (entry.status === "unknown") {
      // Nothing is rendered for an unknown radio, so a url or note on one is
      // research that no reader will ever see.
      assert.equal(entry.url, null, `${key} is unknown but carries a url`);
      assert.equal(entry.note, "", `${key} is unknown but carries a note`);
      continue;
    }
    if (entry.url === null) {
      continue;
    }
    const url = new URL(entry.url);
    assert.equal(url.protocol, "https:", `${key} links over ${url.protocol}`);
    assert.equal(url.hash, "", `${key} links to a fragment of a page`);
  }
});

test("a model entry says something its vendor's answer does not", async () => {
  const firmware = await readJson(repoRoot, "radio-firmware.json");

  // A model entry costs a reader nothing but costs a maintainer a line to keep
  // true, so one that merely restates the vendor default is a line to delete.
  // It also means the page claims per-model certainty for a fact established at
  // the vendor level, which is exactly what the two scopes exist to keep apart.
  const redundant = [];
  for (const [key, entry] of Object.entries(firmware.models)) {
    const fallback = firmware.vendors[key.split("|")[0]];
    if (!fallback) {
      continue;
    }
    if (
      entry.status === fallback.status
      && entry.url === fallback.url
      && entry.note === fallback.note
    ) {
      redundant.push(key);
    }
  }
  assert.deepEqual(redundant, [], "these model entries only repeat their vendor's answer");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "../support/repo-paths.mjs";

// The writing system each non-Latin guide language is published in. Serbian is
// written in both alphabets; the guides use Cyrillic to match the page frame.
const SCRIPTS = {
  ru: /\p{Script=Cyrillic}/gu, uk: /\p{Script=Cyrillic}/gu, bg: /\p{Script=Cyrillic}/gu,
  sr: /\p{Script=Cyrillic}/gu, kk: /\p{Script=Cyrillic}/gu, ky: /\p{Script=Cyrillic}/gu,
  el: /\p{Script=Greek}/gu, he: /\p{Script=Hebrew}/gu, ar: /\p{Script=Arabic}/gu,
  fa: /\p{Script=Arabic}/gu, th: /\p{Script=Thai}/gu, km: /\p{Script=Khmer}/gu,
  my: /\p{Script=Myanmar}/gu, bn: /\p{Script=Bengali}/gu, hi: /\p{Script=Devanagari}/gu,
  ko: /\p{Script=Hangul}/gu, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  "zh-Hans": /\p{Script=Han}/gu, "zh-Hant": /\p{Script=Han}/gu,
};

// Read a curated JSON input from the repository root.
async function readJson(name) {
  return JSON.parse(await readFile(path.join(repoRoot, name), "utf8"));
}

test("native-language guide text is written in its language's own script", async () => {
  const records = await readJson("licensing-countries.json");
  const guides = await readJson("licensing-guide-details.json");
  const misses = [];
  for (const record of records) {
    const script = SCRIPTS[record.locale];
    const guide = guides[record.slug];
    if (!script || !guide) continue;
    const claims = [...(guide.steps || []), ...(guide.requirements || []),
      guide.cost, guide.time?.official, guide.time?.forum].filter(Boolean);
    for (const claim of claims) {
      // Acronyms, URLs and call signs stay Latin, so only a Latin majority is a miss.
      const native = (claim.local.match(script) || []).length;
      const latin = (claim.local.match(/[A-Za-z]/g) || []).length;
      if (latin > native) misses.push(`${record.slug}: ${claim.local.slice(0, 60)}`);
    }
  }
  assert.deepEqual(misses, []);
});

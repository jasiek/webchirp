import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const SCRIPT = path.join(repoRoot, "scripts", "build-licensing-wiki.mjs");
const INPUTS = ["licensing-countries.json", "licensing-locales.json",
  "licensing-guide-copy.json", "licensing-guide-details.json", "licensing-cept.json"];

// Generate from copied inputs so a stale committed wiki page cannot pass unnoticed.
test("wiki source has one reproducible cited page per country", async () => {
  await withTempDir("webchirp-wiki-", async (root) => {
    for (const file of INPUTS) {
      await copyFile(path.join(repoRoot, file), path.join(root, file));
    }
    const output = path.join(root, "wiki");
    await new Promise((resolve, reject) => execFile(process.execPath,
      [SCRIPT, root, output], { cwd: root },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    const records = JSON.parse(await readFile(path.join(root, INPUTS[0]), "utf8"));
    const files = (await readdir(output)).toSorted();
    assert.deepEqual((await readdir(path.join(repoRoot, "wiki"))).toSorted(), files);
    assert.equal(records.length, 81);
    assert.deepEqual(files, ["Home.md", ...records.map((record) => `${record.slug}.md`)].toSorted());
    const home = await readFile(path.join(output, "Home.md"), "utf8");
    const actualOrder = [...home.matchAll(/https:\/\/github\.com\/jasiek\/webchirp\/wiki\/([a-z-]+)>/g)]
      .map((match) => match[1]);
    const expectedOrder = records.toSorted((a, b) => a.name.localeCompare(b.name, "en"))
      .map((record) => record.slug);
    assert.deepEqual(actualOrder, expectedOrder);

    for (const file of files) {
      const text = await readFile(path.join(output, file), "utf8");
      assert.equal(text, await readFile(path.join(repoRoot, "wiki", file), "utf8"), file);
      assert.ok(!text.includes("LICENSING_RESEARCH_SUMMARY"), file);
      if (file === "Home.md") continue;
      const record = records.find((entry) => `${entry.slug}.md` === file);
      assert.ok(text.includes(record.authority.url), file);
      assert.ok(text.includes(record.society.url), file);
      assert.ok(text.includes("English translation of the visible guide:"), file);
      assert.ok(text.includes("https://docdb.cept.org/"), file);
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const SCRIPT = path.join(repoRoot, "scripts", "build-licensing-pages.mjs");

// Stage the curated inputs and an existing sitemap, as the real page build does.
async function withGuides(callback) {
  return withTempDir("webchirp-licensing-", async (root) => {
    await mkdir(path.join(root, "web"), { recursive: true });
    for (const file of ["CNAME", "licensing-countries.json", "licensing-locales.json"]) {
      await copyFile(path.join(repoRoot, file), path.join(root, file));
    }
    await writeFile(path.join(root, "web", "sitemap.xml"),
      '<urlset><url><loc>https://webchirp.org/</loc></url></urlset>\n', "utf8");
    await new Promise((resolve, reject) => execFile(process.execPath, [SCRIPT], { cwd: root },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    return callback(root);
  });
}

test("one localized, cited guide is built for each named CSV location", async () => {
  await withGuides(async (root) => {
    const dir = path.join(root, "web", "licensing");
    const files = await readdir(dir);
    const records = JSON.parse(await readFile(path.join(root, "licensing-countries.json"), "utf8"));
    assert.equal(records.length, 81);
    assert.equal(files.length, 82);
    assert.ok(!records.some((record) => record.name === "(not set)"));
    const sitemap = await readFile(path.join(root, "web", "sitemap.xml"), "utf8");

    for (const record of records) {
      const filename = `${record.slug}.html`;
      const html = await readFile(path.join(dir, filename), "utf8");
      assert.match(html, new RegExp(`<html lang="${record.locale}"`), filename);
      assert.ok(html.includes("English translation of visible guide:"), filename);
      assert.ok(html.includes("class=\"licensing-flag\""), filename);
      assert.ok(html.includes(record.authority.url.replaceAll("&", "&amp;")), filename);
      assert.ok(html.includes(record.society.url.replaceAll("&", "&amp;")), filename);
      assert.ok(html.includes(`/licensing/${filename}`), filename);
      assert.ok(sitemap.includes(`/licensing/${filename}`), filename);
    }
    assert.ok(sitemap.includes("/licensing/index.html"));
    await new Promise((resolve, reject) => execFile(process.execPath, [SCRIPT], { cwd: root },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    const rerunSitemap = await readFile(path.join(root, "web", "sitemap.xml"), "utf8");
    assert.equal((rerunSitemap.match(/\/licensing\/poland\.html/g) || []).length, 1);
  });
});

test("the English comment matches the translated claims on a country guide", async () => {
  await withGuides(async (root) => {
    const html = await readFile(path.join(root, "web", "licensing", "poland.html"), "utf8");
    assert.match(html, /<html lang="pl">/);
    assert.match(html, /150 zł za egzamin i 82 zł za pozwolenie/);
    assert.match(html, /PLN 150 for the exam and PLN 82 for the permit/);
    assert.match(html, /Do 6 tygodni/);
    assert.match(html, /Up to 6 weeks/);
    assert.match(html, /href="#source-\d+">\[\d+\]<\/a>/);
    assert.match(html, /<li id="source-\d+"><a href=/);
  });
});

test("the directory is alphabetical by its visible English country names", async () => {
  await withGuides(async (root) => {
    const records = JSON.parse(await readFile(path.join(root, "licensing-countries.json"), "utf8"));
    const html = await readFile(path.join(root, "web", "licensing", "index.html"), "utf8");
    const slugs = [...html.matchAll(/<a href="\.\/([a-z-]+)\.html"><span lang="en">/g)]
      .map((match) => match[1]);
    const expected = records.toSorted((left, right) => left.name.localeCompare(right.name, "en"))
      .map((record) => record.slug);
    assert.deepEqual(slugs, expected);
    assert.match(html, /<span lang="en">Poland<\/span> <span class="licensing-directory-local" lang="pl" dir="auto">Polska<\/span>/);
  });
});

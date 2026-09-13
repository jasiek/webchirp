import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { repoRoot, webDir } from "../support/repo-paths.mjs";

// The generated pages are committed, so they can drift from the generator that
// wrote them and from the catalog they describe. These tests pin what a crawler
// and a visitor each need, which is the part that silently rots: a page with no
// title still renders, and a call to action pointing at a driver that has gone
// away still looks like a button.
const PAGES_DIR = path.join(webDir, "radios");

async function readPages() {
  const names = (await fs.readdir(PAGES_DIR)).filter((name) => name.endsWith(".html"));
  const pages = [];
  for (const name of names) {
    pages.push({ name, html: await fs.readFile(path.join(PAGES_DIR, name), "utf8") });
  }
  return pages;
}

async function readCatalogRadios() {
  const text = await fs.readFile(path.join(webDir, "radio-catalog.json"), "utf8");
  return JSON.parse(text).radios;
}

test("every model page carries the tags a search result is built from", async () => {
  const pages = await readPages();
  assert.ok(pages.length > 1, "no model pages were generated");

  for (const { name, html } of pages) {
    assert.match(html, /<title>[^<]+<\/title>/, `${name} has no title`);
    assert.match(html, /<meta name="description" content="[^"]+"/, `${name} has no description`);
    assert.match(html, /<link rel="canonical" href="https:\/\/[^"]+"/, `${name} has no canonical`);
    assert.match(html, /<h1>[^<]+<\/h1>/, `${name} has no h1`);
  }
});

test("each page is canonical to its own URL, never to another page's", async () => {
  const pages = await readPages();
  const seen = new Map();

  for (const { name, html } of pages) {
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
    assert.ok(canonical.endsWith(`/radios/${name}`), `${name} is canonical to ${canonical}`);
    assert.equal(seen.get(canonical), undefined, `${canonical} is claimed twice`);
    seen.set(canonical, name);
  }
});

test("every call to action names a radio the catalog still has", async () => {
  const pages = await readPages();
  const keys = new Set((await readCatalogRadios()).map((radio) => radio.key));

  for (const { name, html } of pages) {
    const cta = html.match(/href="\.\.\/index\.html\?radio=([^"]+)"/);
    if (name === "index.html") {
      assert.equal(cta, null, "the vendor index links to models, not to one radio");
      continue;
    }
    assert.ok(cta, `${name} has no call to action into the app`);
    const key = decodeURIComponent(cta[1]);
    assert.ok(keys.has(key), `${name} preselects ${key}, which is not in the catalog`);
  }
});

test("pages say what the driver says, not a shared default", async () => {
  const uv5r = await fs.readFile(path.join(PAGES_DIR, "baofeng-uv-5r.html"), "utf8");
  const bf888 = await fs.readFile(path.join(PAGES_DIR, "baofeng-bf-888.html"), "utf8");

  assert.match(uv5r, /128 memory channels, numbered 0 to 127/);
  assert.match(uv5r, /Channel names up to 7 characters/);
  assert.match(bf888, /16 memory channels, numbered 1 to 16/);
  assert.match(bf888, /Channel names up to 6 characters/);
  // The rebadge list is the main thing making one page's text unlike another's,
  // so a change that drops it would leave the set much closer to a template.
  assert.match(uv5r, /Retevis RT5R/);
});

test("the sitemap lists every generated page and nothing that is missing", async () => {
  const sitemap = await fs.readFile(path.join(webDir, "sitemap.xml"), "utf8");
  const pages = await readPages();
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

  for (const { name } of pages) {
    assert.ok(
      listed.some((url) => url.endsWith(`/radios/${name}`)),
      `${name} is missing from sitemap.xml`,
    );
  }
  for (const url of listed) {
    const relative = url.replace(/^https:\/\/[^/]+\//, "");
    if (!relative || !relative.endsWith(".html")) {
      continue;
    }
    const onDisk = path.join(webDir, relative);
    await fs.access(onDisk).catch(() => {
      assert.fail(`sitemap.xml lists ${url}, which is not in web/`);
    });
  }
});

test("robots.txt points crawlers at the sitemap on the deployed host", async () => {
  const robots = await fs.readFile(path.join(webDir, "robots.txt"), "utf8");
  const host = (await fs.readFile(path.join(repoRoot, "CNAME"), "utf8")).trim();

  assert.match(robots, /^User-agent: \*$/m);
  assert.ok(robots.includes(`Sitemap: https://${host}/sitemap.xml`), "sitemap URL is not the CNAME host");
});

test("the app links the generated pages, so a crawler can reach them", async () => {
  const index = await fs.readFile(path.join(webDir, "index.html"), "utf8");
  assert.match(index, /href="\.\/radios\/index\.html"/);
});

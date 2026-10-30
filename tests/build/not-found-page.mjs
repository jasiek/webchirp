// Guards web/404.html, which the host serves for any path that names no file.
// Without it Cloudflare Pages answers a missing path with index.html and a 200,
// so a mistyped or retired URL reads as a live page to a crawler. The page is
// served at the missing path, not at /404.html, which is what makes a relative
// URL on it wrong: both are asserted against the real build.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { JSDOM } from "jsdom";

import { REQUIRED_FILES, runBuild, writeTree } from "../support/dist-build.mjs";
import { webDir } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const PAGE = "404.html";

// Every URL on the page that the browser resolves against the page's own.
function localUrls(document) {
  return [...document.querySelectorAll("[href], [src]")]
    .map((el) => el.getAttribute("href") ?? el.getAttribute("src"))
    .filter((url) => !/^[a-z][a-z0-9+.-]*:/i.test(url));
}

test("the not-found page is kept out of search results", async () => {
  const { document } = new JSDOM(await readFile(path.join(webDir, PAGE), "utf8")).window;
  assert.equal(document.querySelector('meta[name="robots"]')?.getAttribute("content"), "noindex");
  assert.equal(document.querySelector('link[rel="canonical"]'), null, "a not-found page names no canonical URL");
});

test("a built not-found page loads its assets from any depth", async () => {
  const files = {
    [PAGE]: await readFile(path.join(webDir, PAGE), "utf8"),
    "styles.css": await readFile(path.join(webDir, "styles.css"), "utf8"),
  };
  await withTempDir("not-found-dist-", async (dir) => {
    await writeTree(path.join(dir, "web"), { ...REQUIRED_FILES, ...files });
    await runBuild(dir);
    const { document } = new JSDOM(await readFile(path.join(dir, "dist", PAGE), "utf8")).window;

    const urls = localUrls(document);
    assert.ok(urls.length > 0, "the page links to something of its own");
    for (const url of urls) {
      assert.ok(url.startsWith("/"), `${PAGE} uses ${url}, which breaks when served below the root`);
    }
    const stylesheet = document.querySelector('link[rel="stylesheet"]')?.getAttribute("href") ?? "";
    assert.match(stylesheet, /^\/styles\.[A-Z2-7]{8}\.css$/, "the stylesheet is the hashed build output");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { htmlPages, repoRoot, webDir } from "../support/repo-paths.mjs";

// Guards the self-referential absolute URLs on the static pages against the
// host drifting away from CNAME. sitemap.xml and robots.txt cannot drift --
// build-model-pages.mjs reads CNAME and writes them -- but these tags are
// hand-written strings that no build step rewrites, so moving the site leaves
// them naming the old domain. A canonical pointing at a host we no longer
// serve tells a crawler to index that one instead, and an og:image on a dead
// host renders every share as a blank card: both fail silently in a browser,
// which is why this is asserted rather than eyeballed.
const cname = fs.readFileSync(path.join(repoRoot, "CNAME"), "utf8").trim();

// Each tag that names this site by absolute URL. Pages differ in which ones
// they carry -- about.html has no twitter card -- so a tag missing everywhere
// is a failure but a tag missing on one page is not.
const SELF_REFERENTIAL = [
  { label: 'rel="canonical"', pattern: /<link rel="canonical" href="([^"]+)"/g },
  { label: "og:url", pattern: /<meta property="og:url" content="([^"]+)"/g },
  { label: "og:image", pattern: /<meta property="og:image" content="([^"]+)"/g },
  { label: "twitter:image", pattern: /<meta name="twitter:image" content="([^"]+)"/g },
];

function readPage(name) {
  return fs.readFileSync(path.join(webDir, name), "utf8");
}

test("CNAME names a host the pages can be checked against", () => {
  assert.ok(cname, "CNAME must name the deployed host");
  assert.doesNotThrow(
    () => new URL(`https://${cname}/`),
    `CNAME is ${cname}, which is not a usable host`,
  );
});

test("every absolute self-reference on a static page is on the CNAME host", () => {
  const seen = new Map(SELF_REFERENTIAL.map(({ label }) => [label, 0]));
  for (const page of htmlPages) {
    const html = readPage(page);
    for (const { label, pattern } of SELF_REFERENTIAL) {
      for (const [, value] of html.matchAll(pattern)) {
        seen.set(label, seen.get(label) + 1);
        assert.equal(
          new URL(value).host,
          cname,
          `${page} ${label} is ${value}, which is not on the CNAME host ${cname}`,
        );
      }
    }
  }
  // Without this the whole test passes vacuously the day a tag is renamed or
  // dropped, which is the same silent failure it exists to catch.
  for (const [label, count] of seen) {
    assert.ok(count > 0, `no page carries ${label}; the check above matched nothing`);
  }
});

test("each page declares its own canonical, not a shared one", () => {
  // Two pages sharing a canonical asks the crawler to drop one of them from
  // the index entirely, so the URLs have to differ as well as be present.
  const canonicals = htmlPages.map((page) => {
    const match = readPage(page).match(/<link rel="canonical" href="([^"]+)"/);
    assert.ok(match, `${page} has no canonical link`);
    return match[1];
  });
  assert.equal(
    new Set(canonicals).size,
    canonicals.length,
    `canonical URLs are not distinct: ${canonicals.join(", ")}`,
  );
});

// The per-model pages under web/radios/ are generated, not committed: both
// workflows run build:dist before npm test, and build:dist runs build:pages.
// So this file cannot read them off disk -- it runs the real script against a
// throwaway tree, the way tests/build/build-dist.mjs does, which also means
// what is under test is exactly what CI runs rather than a copy of its output.
//
// The catalog and features are the real ones, copied in, so the assertions
// about page copy are about what the drivers actually advertise. The fixture
// cases below build their own tiny catalog instead, because the states they
// cover (a radio too thin to describe, two radios colliding on one filename)
// do not exist in the real one and should not have to.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot, webDir } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const SCRIPT = path.join(repoRoot, "scripts", "build-model-pages.mjs");

// The script resolves every path from its cwd, so a temp tree holding these
// three inputs is a complete stand-in for the repo.
async function stageRealInputs(root) {
  await mkdir(path.join(root, "web"), { recursive: true });
  await copyFile(path.join(repoRoot, "CNAME"), path.join(root, "CNAME"));
  await copyFile(
    path.join(webDir, "radio-catalog.json"),
    path.join(root, "web", "radio-catalog.json"),
  );
  await copyFile(
    path.join(repoRoot, "radio-features.json"),
    path.join(root, "radio-features.json"),
  );
}

// A catalog and feature set of exactly the shape the real ones have, so a test
// can put one radio in a state the real catalog does not contain.
async function stageFixture(root, { radios, features, revision = "fixture" }) {
  await mkdir(path.join(root, "web"), { recursive: true });
  await writeFile(path.join(root, "CNAME"), "example.test\n", "utf8");
  await writeFile(
    path.join(root, "web", "radio-catalog.json"),
    JSON.stringify({ chirpRevision: revision, count: radios.length, radios }),
    "utf8",
  );
  await writeFile(
    path.join(root, "radio-features.json"),
    JSON.stringify({ chirpRevision: revision, features }),
    "utf8",
  );
}

function runGenerator(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT], { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Runs the generator against the real catalog and hands the callback the pages
// it wrote, keyed by filename.
async function withGeneratedPages(fn) {
  return withTempDir("webchirp-pages-", async (root) => {
    await stageRealInputs(root);
    const stdout = await runGenerator(root);
    const dir = path.join(root, "web", "radios");
    const pages = new Map();
    for (const name of await readdir(dir)) {
      pages.set(name, await readFile(path.join(dir, name), "utf8"));
    }
    return fn({ root, pages, stdout });
  });
}

const FEATURES = {
  memoryBounds: [0, 127],
  nameLength: 7,
  modes: ["FM", "NFM"],
  bands: [[136000000, 174000000]],
  toneModes: ["Tone", "TSQL"],
  powerLevels: { High: "5.0W" },
  hasSettings: true,
};

function fixtureRadio(overrides) {
  return {
    key: "alpha:AlphaRadio",
    module: "alpha",
    className: "AlphaRadio",
    vendor: "Baofeng",
    model: "Alpha",
    baudRate: 9600,
    isLiveRadio: false,
    ...overrides,
  };
}

test("every model page carries the tags a search result is built from", async () => {
  await withGeneratedPages(({ pages }) => {
    assert.ok(pages.size > 1, "no model pages were generated");

    for (const [name, html] of pages) {
      assert.match(html, /<title>[^<]+<\/title>/, `${name} has no title`);
      assert.match(html, /<meta name="description" content="[^"]+"/, `${name} has no description`);
      assert.match(html, /<link rel="canonical" href="https:\/\/[^"]+"/, `${name} has no canonical`);
      assert.match(html, /<h1>[^<]+<\/h1>/, `${name} has no h1`);
    }
  });
});

test("each page is canonical to its own URL, never to another page's", async () => {
  await withGeneratedPages(({ pages }) => {
    const seen = new Map();

    for (const [name, html] of pages) {
      const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
      assert.ok(canonical.endsWith(`/radios/${name}`), `${name} is canonical to ${canonical}`);
      assert.equal(seen.get(canonical), undefined, `${canonical} is claimed twice`);
      seen.set(canonical, name);
    }
  });
});

test("every call to action names a radio the catalog still has", async () => {
  await withGeneratedPages(async ({ root, pages }) => {
    const catalog = JSON.parse(
      await readFile(path.join(root, "web", "radio-catalog.json"), "utf8"),
    );
    const keys = new Set(catalog.radios.map((radio) => radio.key));

    for (const [name, html] of pages) {
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
});

test("pages say what the driver says, not a shared default", async () => {
  await withGeneratedPages(({ pages }) => {
    const uv5r = pages.get("baofeng-uv-5r.html");
    const bf888 = pages.get("baofeng-bf-888.html");

    assert.match(uv5r, /128 memory channels, numbered 0 to 127/);
    assert.match(uv5r, /Channel names up to 7 characters/);
    assert.match(bf888, /16 memory channels, numbered 1 to 16/);
    assert.match(bf888, /Channel names up to 6 characters/);
    // The rebadge list is the main thing making one page's text unlike
    // another's, so a change that drops it would leave the set much closer to
    // a template than it looks.
    assert.match(uv5r, /Retevis RT5R/);
  });
});

test("the sitemap lists every generated page and nothing that is missing", async () => {
  await withGeneratedPages(async ({ root, pages }) => {
    const sitemap = await readFile(path.join(root, "web", "sitemap.xml"), "utf8");
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

    for (const name of pages.keys()) {
      assert.ok(
        listed.some((url) => url.endsWith(`/radios/${name}`)),
        `${name} is missing from sitemap.xml`,
      );
    }
    // Only the model pages are generated here; index.html and about.html are
    // committed, so the sitemap may name them without this tree holding them.
    for (const url of listed) {
      const name = url.split("/radios/")[1];
      if (name) {
        assert.ok(pages.has(name), `sitemap.xml lists ${url}, which was not generated`);
      }
    }
  });
});

test("robots.txt points crawlers at the sitemap on the deployed host", async () => {
  await withGeneratedPages(async ({ root }) => {
    const robots = await readFile(path.join(root, "web", "robots.txt"), "utf8");
    const host = (await readFile(path.join(repoRoot, "CNAME"), "utf8")).trim();

    assert.match(robots, /^User-agent: \*$/m);
    assert.ok(
      robots.includes(`Sitemap: https://${host}/sitemap.xml`),
      "sitemap URL is not the CNAME host",
    );
  });
});

test("a radio whose driver describes it too thinly gets no page", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    await stageFixture(root, {
      radios: [fixtureRadio({}), fixtureRadio({ key: "beta:BetaRadio", model: "Beta" })],
      features: {
        "alpha:AlphaRadio": FEATURES,
        // A driver that cannot report its bands without an image: a page for it
        // would carry no fact a search could match (FINDINGS:
        // blank-instances-misreport-state).
        "beta:BetaRadio": { ...FEATURES, bands: [] },
      },
    });
    const stdout = await runGenerator(root);
    const written = await readdir(path.join(root, "web", "radios"));

    assert.deepEqual(written.sort(), ["baofeng-alpha.html", "index.html"]);
    assert.match(stdout, /beta:BetaRadio/, "the skipped radio is not named in the output");
  });
});

test("two radios that would share one filename fail the build", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // Slugs come from vendor and model, which the catalog does not guarantee
    // are unique across driver classes. Silently overwriting one page with
    // another's content is the failure this prevents.
    await stageFixture(root, {
      radios: [
        fixtureRadio({ model: "UV 5R" }),
        fixtureRadio({ key: "beta:BetaRadio", className: "BetaRadio", model: "UV-5R" }),
      ],
      features: { "alpha:AlphaRadio": FEATURES, "beta:BetaRadio": FEATURES },
    });

    await assert.rejects(runGenerator(root), /slug to baofeng-uv-5r/);
  });
});

test("features from another CHIRP revision fail the build", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // The two artifacts are written by one catalog build. Generating pages from
    // a mismatched pair would describe radios with another revision's
    // capabilities, which is worse than not generating them.
    await stageFixture(root, {
      radios: [fixtureRadio({})],
      features: { "alpha:AlphaRadio": FEATURES },
    });
    await writeFile(
      path.join(root, "radio-features.json"),
      JSON.stringify({ chirpRevision: "stale", features: { "alpha:AlphaRadio": FEATURES } }),
      "utf8",
    );

    await assert.rejects(runGenerator(root), /run npm run build:catalog first/);
  });
});

test("the app links the generated pages, so a crawler can reach them", async () => {
  const index = await readFile(path.join(webDir, "index.html"), "utf8");
  assert.match(index, /href="\.\/radios\/index\.html"/);
});

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
// four inputs is a complete stand-in for the repo.
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
  await copyFile(
    path.join(repoRoot, "radio-firmware.json"),
    path.join(root, "radio-firmware.json"),
  );
}

// A catalog and feature set of exactly the shape the real ones have, so a test
// can put one radio in a state the real catalog does not contain.
async function stageFixture(root, { radios, features, firmware, revision = "fixture" }) {
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
  // A build input like the other two, so a fixture that says nothing about
  // firmware still has to provide the file -- which is what makes its absence
  // in the real tree a build failure rather than pages that quietly lost a
  // section.
  await writeFile(
    path.join(root, "radio-firmware.json"),
    JSON.stringify(firmware || { vendors: {}, models: {} }),
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

// A listing page (the vendor directory, or one vendor's hub) carries the model
// list and no per-radio copy. Told apart by that list rather than by filename,
// because a hub is named after its vendor and so has no filename shape a test
// could match without restating the slug rules.
function isListingPage(html) {
  return html.includes('<ul class="radio-page-list">');
}

// The generator escapes page copy but not JSON-LD, so a test comparing the two
// has to put one through the same transform to compare like with like.
function escapeForHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
      // Listing pages -- the vendor directory and the vendor hubs -- send a
      // reader onward to a model rather than into the app with one preselected,
      // so the absence of a call to action is the correct shape for them.
      if (isListingPage(html)) {
        assert.equal(cta, null, `${name} is a listing page but preselects one radio`);
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

test("drivers that name the same radio share one page, not one each", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // Several CHIRP drivers can describe one physical radio -- firmware and
    // production variants -- and they slug alike because vendor and model are
    // all a slug has. A page each would be that radio described twice under two
    // URLs, so they merge, and the survivor is the driver saying the most.
    await stageFixture(root, {
      radios: [
        fixtureRadio({ model: "UV 5R" }),
        fixtureRadio({ key: "beta:BetaRadio", className: "BetaRadio", model: "UV-5R" }),
      ],
      features: {
        "alpha:AlphaRadio": { ...FEATURES, nameLength: 0, hasSettings: false },
        "beta:BetaRadio": FEATURES,
      },
    });
    const stdout = await runGenerator(root);
    const written = await readdir(path.join(root, "web", "radios"));

    assert.deepEqual(written.sort(), ["baofeng-uv-5r.html", "index.html"]);
    const page = await readFile(
      path.join(root, "web", "radios", "baofeng-uv-5r.html"),
      "utf8",
    );
    // Beta describes itself more fully, so beta is what the page says and is
    // what its call to action preselects.
    assert.match(page, /Channel names up to 7 characters/);
    assert.match(page, /radio=beta%3ABetaRadio/);
    // Reported representative first, which is the order the page lists them in.
    assert.match(stdout, /beta:BetaRadio \+ alpha:AlphaRadio/, "the merge is not reported");
  });
});

test("the stock driver speaks for a merged page, not the most capable one", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // CHIRP marks every non-stock driver in `variant`, so the unmarked one is
    // the radio as it ships -- the radio somebody searching the model name
    // owns. Ranking on detail instead would put the aftermarket firmware's
    // capabilities on the page and tell stock owners something false, which is
    // the real-world Quansheng UV-K5 case in miniature.
    await stageFixture(root, {
      radios: [
        fixtureRadio({ key: "stock:StockRadio", model: "UV-K5" }),
        fixtureRadio({
          key: "custom:CustomRadio",
          className: "CustomRadio",
          model: "UV-K5",
          variant: "aftermarket",
        }),
      ],
      features: {
        "stock:StockRadio": { ...FEATURES, memoryBounds: [1, 200], modes: ["FM"] },
        // Richer on every axis, and still not what the page is about.
        "custom:CustomRadio": { ...FEATURES, memoryBounds: [1, 999], modes: ["FM", "NFM", "AM"] },
      },
    });
    await runGenerator(root);
    const page = await readFile(
      path.join(root, "web", "radios", "baofeng-uv-k5.html"),
      "utf8",
    );

    assert.match(page, /200 memory channels/);
    assert.doesNotMatch(page, /999 memory channels/, "the page speaks for the aftermarket driver");
    assert.match(page, /radio=stock%3AStockRadio/);
  });
});

test("a merged page lists the variants it does not speak for", async () => {
  await withGeneratedPages(({ pages }) => {
    // A Leixen VV-898E holds 199 channels as stock and 99 as Dual Bank, so a
    // page stating only the first figure would be wrong for half its readers.
    const page = pages.get("leixen-vv-898e.html");

    assert.match(page, /199 channels/);
    assert.match(page, /99 channels/);
    assert.match(page, /VV-898E \(Dual Bank\)/);
    assert.match(page, /radio=leixen%3AVV898EDualBank/);
    // A model with one driver has nothing to disambiguate, so it gets no list.
    assert.doesNotMatch(pages.get("baofeng-uv-5r.html"), /do you have\?/);
  });
});

test("a vendor hub exists per vendor with more than one model, and lists them", async () => {
  await withGeneratedPages(({ pages }) => {
    const hub = pages.get("baofeng.html");
    assert.ok(hub, "no Baofeng hub was generated");
    assert.match(hub, /<h1>Baofeng programming software<\/h1>/);
    assert.match(hub, /href="\.\/baofeng-uv-5r\.html"/);
    assert.match(hub, /href="\.\/index\.html"/, "the hub does not link back to the directory");
    // Model pages point up at their own vendor's hub, which is what makes the
    // hub a real level of the site rather than a page only the directory knows.
    assert.match(pages.get("baofeng-uv-5r.html"), /href="\.\/baofeng\.html">All Baofeng radios/);
  });
});

test("the directory links every vendor, and no vendor is stranded", async () => {
  await withGeneratedPages(async ({ root, pages }) => {
    const index = pages.get("index.html");
    const catalog = JSON.parse(
      await readFile(path.join(root, "web", "radio-catalog.json"), "utf8"),
    );
    // Every vendor that got a page must be reachable from the directory in one
    // click; a vendor whose only route in is the sitemap is a vendor no reader
    // finds. Vendors are read back off the generated pages rather than off the
    // catalog, because the catalog also holds the radios that were skipped.
    const linked = new Set(
      [...index.matchAll(/<li><a href="\.\/([^"]+)\.html"/g)].map((match) => match[1]),
    );
    const reachable = new Set();
    for (const slug of linked) {
      const page = pages.get(`${slug}.html`);
      assert.ok(page, `the directory links ${slug}.html, which was not generated`);
      if (isListingPage(page)) {
        for (const match of page.matchAll(/<li><a href="\.\/([^"]+)\.html"/g)) {
          reachable.add(match[1]);
        }
      } else {
        reachable.add(slug);
      }
    }

    const vendors = new Set(catalog.radios.map((radio) => radio.vendor));
    assert.ok(linked.size > 1, "the directory lists one vendor or none");
    assert.ok(linked.size <= vendors.size, "the directory lists more vendors than exist");
    for (const [name, html] of pages) {
      if (name === "index.html" || isListingPage(html)) {
        continue;
      }
      assert.ok(
        reachable.has(name.replace(/\.html$/, "")),
        `${name} is reachable from the sitemap but not from the directory`,
      );
    }
  });
});

test("a vendor with a single model gets no hub of its own", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // A hub holding one link repeats that model page's subject, so the two
    // would compete for the same search with the hub carrying less. The
    // directory links straight to the model page instead.
    await stageFixture(root, {
      radios: [fixtureRadio({ vendor: "Solo", model: "One" })],
      features: { "alpha:AlphaRadio": FEATURES },
    });
    await runGenerator(root);
    const written = await readdir(path.join(root, "web", "radios"));

    assert.deepEqual(written.sort(), ["index.html", "solo-one.html"]);
    const index = await readFile(path.join(root, "web", "radios", "index.html"), "utf8");
    assert.match(index, /href="\.\/solo-one\.html"/);
    assert.match(
      await readFile(path.join(root, "web", "radios", "solo-one.html"), "utf8"),
      /href="\.\/index\.html">All supported radios/,
    );
  });
});


// --- Firmware answers -------------------------------------------------------
//
// radio-firmware.json is the one page input nobody generated: no CHIRP driver
// can say whether the radio it talks to takes new firmware. That makes it the
// input most able to go quietly wrong, so these check the two failure modes
// that matter -- a vendor-level fact stated as a per-model promise, and a
// section that renders with nothing in it.

test("a radio with a recorded firmware answer says so, in the page and in its structured data", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    await stageFixture(root, {
      radios: [fixtureRadio({ vendor: "Quansheng", model: "UV-K5" })],
      features: { "alpha:AlphaRadio": FEATURES },
      firmware: {
        vendors: {},
        models: {
          "Quansheng|UV-K5": {
            status: "community",
            url: "https://github.com/egzumer/uv-k5-firmware-custom",
            note: "CHIRP carries a driver for the egzumer firmware.",
          },
        },
      },
    });
    await runGenerator(root);
    const page = await readFile(
      path.join(root, "web", "radios", "quansheng-uv-k5.html"),
      "utf8",
    );

    assert.match(page, /<h2>Can I update the firmware on the UV-K5\?<\/h2>/);
    assert.match(page, /community-built firmware exists for it/);
    assert.match(page, /CHIRP carries a driver for the egzumer firmware\./);
    // The link names its destination rather than saying "click here", so a
    // reader can see where it goes before following it.
    assert.match(page, /href="https:\/\/github\.com\/egzumer\/uv-k5-firmware-custom"/);
    // The link is named for what it is: a community project, not a vendor's
    // firmware page. Labelling all four statuses alike is how a page ends up
    // saying "no firmware exists" above a link called "Firmware downloads".
    assert.match(page, /The firmware project at github\.com/);
    // Upload writes a codeplug, not firmware. A page that leaves that implicit
    // is a page somebody can misread into bricking a radio.
    assert.match(page, /WebCHIRP does not flash firmware/);

    // Structured data and visible text have to be the same sentence: Google
    // drops a FAQ answer that does not appear on the page.
    const jsonLd = JSON.parse(page.match(/<script type="application\/ld\+json">\n([\s\S]*?)\n    <\/script>/)[1]);
    const answers = jsonLd.mainEntity.map((entry) => entry.acceptedAnswer.text);
    const firmwareAnswer = answers.find((text) => text.includes("community-built"));
    assert.ok(firmwareAnswer, "the firmware answer is missing from the FAQ structured data");
    assert.ok(
      page.includes(escapeForHtml(firmwareAnswer.split(" WebCHIRP does not flash")[0])),
      "the structured answer is not the sentence the page shows",
    );
  });
});

test("a vendor-level answer stays a statement about the vendor, not a promise about one model", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // Icom publishes firmware for part of its range, so "Icom publishes a
    // firmware update for the IC-2100H" would be a per-model claim invented
    // from a range-level fact -- and a reader who cannot then find that file
    // has been sent on an errand by this page.
    await stageFixture(root, {
      radios: [fixtureRadio({ vendor: "Icom", model: "IC-2100H" })],
      features: { "alpha:AlphaRadio": FEATURES },
      firmware: {
        vendors: {
          Icom: { status: "official", url: "https://www.icomjapan.com/support/firmware_driver/", note: "" },
        },
        models: {},
      },
    });
    await runGenerator(root);
    const page = await readFile(path.join(root, "web", "radios", "icom-ic-2100h.html"), "utf8");

    assert.match(page, /not for every radio it has made/);
    assert.match(page, /whether the IC-2100H is one of them/);
    assert.doesNotMatch(
      page,
      /publishes a firmware update for the IC-2100H/,
      "a vendor-level fact was stated as a per-model promise",
    );
  });
});

test("a model entry overrides the vendor it belongs to", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // The case this whole shape exists for: Kenwood's amateur range takes
    // owner-installed firmware while its commercial TK-/NX- range does not, so
    // one answer for "Kenwood" would be wrong for one half or the other.
    await stageFixture(root, {
      radios: [
        fixtureRadio({ vendor: "Kenwood", model: "TH-D75" }),
        fixtureRadio({ key: "beta:BetaRadio", vendor: "Kenwood", model: "TK-3140" }),
      ],
      features: { "alpha:AlphaRadio": FEATURES, "beta:BetaRadio": FEATURES },
      firmware: {
        vendors: { Kenwood: { status: "service", url: null, note: "" } },
        models: {
          "Kenwood|TH-D75": { status: "official", url: "https://www.kenwood.com/", note: "" },
        },
      },
    });
    await runGenerator(root);
    const ham = await readFile(path.join(root, "web", "radios", "kenwood-th-d75.html"), "utf8");
    const commercial = await readFile(
      path.join(root, "web", "radios", "kenwood-tk-3140.html"),
      "utf8",
    );

    assert.match(ham, /publishes a firmware update for the TH-D75/);
    assert.match(commercial, /dealer or service centre/);
    assert.doesNotMatch(commercial, /publishes a firmware update/);
    // No url recorded, so no link -- rather than a link that goes nowhere.
    assert.doesNotMatch(commercial, /support at/);
  });
});

test("a radio nobody established an answer for gets no firmware section", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // A heading that then says "we could not find out" is worse than no
    // heading: it costs a reader a scroll and gives them nothing to act on.
    await stageFixture(root, {
      radios: [
        fixtureRadio({ vendor: "Zastone", model: "ZT-X6" }),
        fixtureRadio({ key: "beta:BetaRadio", vendor: "WLN", model: "KD-C1" }),
      ],
      features: { "alpha:AlphaRadio": FEATURES, "beta:BetaRadio": FEATURES },
      firmware: {
        vendors: { WLN: { status: "unknown", url: null, note: "" } },
        models: {},
      },
    });
    await runGenerator(root);
    const unrecorded = await readFile(
      path.join(root, "web", "radios", "zastone-zt-x6.html"),
      "utf8",
    );
    const unknown = await readFile(path.join(root, "web", "radios", "wln-kd-c1.html"), "utf8");

    assert.doesNotMatch(unrecorded, /Can I update the firmware/);
    assert.doesNotMatch(unknown, /Can I update the firmware/);
  });
});

test("a status the generator has no sentence for fails the build", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // The file is maintained by hand, so a typo in it is a question of when.
    // Failing here names the key; rendering it would put an empty section on
    // every page of that vendor and say nothing at all.
    await stageFixture(root, {
      radios: [fixtureRadio({ vendor: "Baofeng", model: "UV-5R" })],
      features: { "alpha:AlphaRadio": FEATURES },
      firmware: { vendors: { Baofeng: { status: "maybe", url: null, note: "" } }, models: {} },
    });
    await assert.rejects(
      runGenerator(root),
      /Baofeng.*status "maybe"/s,
      "a bogus status did not fail the build",
    );
  });
});

test("the real catalog's firmware answers reach the pages they belong to", async () => {
  await withGeneratedPages(async ({ pages }) => {
    const firmware = JSON.parse(
      await readFile(path.join(repoRoot, "radio-firmware.json"), "utf8"),
    );
    // Every model-level entry was researched for one specific radio, so an
    // entry whose page does not carry it is an entry keyed to a model the
    // catalog spells differently -- work done and then lost.
    for (const [key, entry] of Object.entries(firmware.models)) {
      // An unknown model entry exists to suppress its vendor's answer, not to
      // produce one, so it is correct for its page to stay silent.
      if (entry.status === "unknown") {
        continue;
      }
      const [vendor, model] = key.split("|");
      const name = `${vendor}-${model}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const page = pages.get(`${name}.html`);
      // A model can be absent because its driver describes itself too thinly
      // to get a page at all; that is not this test's business.
      if (!page) {
        continue;
      }
      assert.match(page, /<h2>Can I update the firmware/, `${key} has no firmware section`);
    }
  });
});

test("a vendor whose slug collides with a model page fails the build", async () => {
  await withTempDir("webchirp-pages-", async (root) => {
    // Hubs and model pages share one flat directory, so "Retevis RT5" as a
    // model of Acme and "Acme Retevis" as a vendor would both want
    // acme-retevis.html. Nothing in the catalog does this today; the build
    // fails rather than letting one silently overwrite the other.
    await stageFixture(root, {
      radios: [
        fixtureRadio({ vendor: "Acme", model: "Retevis" }),
        fixtureRadio({ key: "beta:BetaRadio", vendor: "Acme Retevis", model: "One" }),
        fixtureRadio({ key: "gamma:GammaRadio", vendor: "Acme Retevis", model: "Two" }),
      ],
      features: {
        "alpha:AlphaRadio": FEATURES,
        "beta:BetaRadio": FEATURES,
        "gamma:GammaRadio": FEATURES,
      },
    });

    await assert.rejects(runGenerator(root), /both want acme-retevis\.html/);
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

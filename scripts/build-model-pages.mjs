// Static per-model pages, one per catalogued radio, written into web/radios/.
//
// The app itself is a single shell that says nothing until Pyodide has booted,
// so a crawler sees almost no text and the site cannot answer the searches it
// exists to serve ("baofeng uv-5r programming software", "bf-888s driver").
// These pages carry that text instead, and every fact on them comes from the
// driver: radio-catalog.json says which radios exist and what they are called,
// radio-features.json (scripts/build-catalog.mjs) says what each one can do.
// Nothing here invents a capability, which is also what keeps 535 pages from
// being 535 copies of one template.
//
// Three page kinds come out of this, all in one flat directory: a model page
// per vendor-and-model, a vendor hub for every vendor with more than one of
// them, and radios/index.html as the directory of vendors.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.cwd();
const WEB_DIR = path.join(REPO_ROOT, "web");
const PAGES_DIR = path.join(WEB_DIR, "radios");
const CATALOG_PATH = path.join(WEB_DIR, "radio-catalog.json");
const FEATURES_PATH = path.join(REPO_ROOT, "radio-features.json");
const CNAME_PATH = path.join(REPO_ROOT, "CNAME");

// The USB-serial chips WebUSB drivers exist for (web/js/ch340-webusb.js and
// its siblings). Named on every page because "which driver do I install" is
// the single most common thing these searches ask, and the answer here is
// "none" -- but only because these four are handled in the browser.
const CABLE_CHIPSETS = "CH340, CP2102, PL2303 or FTDI";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Any label as one filename-safe token.
function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Vendor and model as one filename-safe token, which is the page's identity
// and the URL it already holds. Several drivers can land on one slug; mergeBySlug
// folds those into a single page rather than letting one overwrite another.
function slugFor(radio) {
  return slugify(`${radio.vendor}-${radio.model}`);
}

// A vendor hub's filename. Hubs sit in the same flat directory as the model
// pages so that introducing them moved no model page: GitHub Pages serves
// static files with no redirect rules available, so a URL that changes is a
// URL whose accumulated ranking starts again from zero.
function vendorSlugFor(vendor) {
  return slugify(vendor);
}

// Hz to a MHz figure a person would say out loud: 400000000 -> "400",
// 174997500 -> "174.9975". Trailing zeros go, because "136.0 MHz" reads like a
// precision the band edge does not have.
function toMHz(hz) {
  return String(Number((hz / 1e6).toFixed(4)));
}

function formatBands(bands) {
  return bands.map(([low, high]) => `${toMHz(low)}–${toMHz(high)} MHz`);
}

function formatPowerLevels(powerLevels) {
  return Object.entries(powerLevels).map(([label, watts]) => `${label} ${watts}`);
}

// The facts that differ radio to radio, as finished sentences. A radio that
// does not advertise something contributes no bullet rather than an empty one:
// a driver that cannot report its power levels blank is not a radio with no
// power levels (FINDINGS: blank-instances-misreport-state).
function specBullets(radio, features) {
  const bullets = [];
  const [low, high] = features.memoryBounds;
  const channels = high - low + 1;
  bullets.push(`${channels} memory channels, numbered ${low} to ${high}`);
  if (features.nameLength > 0) {
    bullets.push(`Channel names up to ${features.nameLength} characters`);
  }
  const power = formatPowerLevels(features.powerLevels);
  if (power.length) {
    bullets.push(`Transmit power: ${power.join(", ")}`);
  }
  if (features.modes.length) {
    bullets.push(`Modes: ${features.modes.join(", ")}`);
  }
  if (features.bands.length) {
    bullets.push(`Bands: ${formatBands(features.bands).join(", ")}`);
  }
  if (features.toneModes.length) {
    bullets.push(`Tone squelch: ${features.toneModes.join(", ")}`);
  }
  if (features.hasSettings) {
    bullets.push("Radio-wide settings, not just the channel list");
  }
  return bullets;
}

// Other names the same driver answers to. CHIRP records them because a rebrand
// ships the same codeplug under another badge, which means one page can truthfully
// tell a Retevis RT-5R owner that their radio is covered here.
function aliasLabels(radio) {
  const own = `${radio.vendor} ${radio.model}`;
  const labels = [];
  for (const alias of radio.aliases || []) {
    const label = `${alias.vendor} ${alias.model}`.trim();
    if (label !== own && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
}

// One page per vendor-and-model, even where several drivers answer to that
// name. Those are firmware or production variants of a single physical radio --
// uvk5:UVK5Radio, uvk5:OSFWUVK5Radio, uvk5:UVK5RestrictedRadio and
// uvk5_egzumer:UVK5RadioEgzumer are all a Quansheng UV-K5 -- so a page each
// would describe one radio four times under four URLs, which is duplicate
// content competing with itself for the same search.
//
// The survivor is the driver CHIRP left unmarked, because CHIRP names every
// non-stock one in `variant` ("Dual Bank", "egzumer", "V2") and the unmarked
// driver is therefore the radio as it ships -- which is the radio a reader
// arriving from a search for its model name owns. Picking the most detailed
// driver instead would have put the egzumer custom firmware's capabilities on
// the UV-K5 page, telling stock owners their radio does something it does not.
// A few models mark every driver and leave no stock one; those fall through to
// detail, then to key in codepoint order so a rebuild is byte-identical.
//
// The variants do not merely relabel one radio -- a Leixen VV-898E holds 199
// channels as stock and 99 as Dual Bank -- so variantsOf keeps them all and the
// page lists them under its own figures rather than quietly speaking for them.
function mergeBySlug(radios, features) {
  const groups = new Map();
  for (const radio of radios) {
    const slug = slugFor(radio);
    const group = groups.get(slug);
    if (group) {
      group.push(radio);
    } else {
      groups.set(slug, [radio]);
    }
  }

  const merged = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => {
      const byStock = Number(Boolean(a.variant)) - Number(Boolean(b.variant));
      if (byStock !== 0) {
        return byStock;
      }
      const byDetail =
        specBullets(b, features[b.key]).length - specBullets(a, features[a.key]).length;
      if (byDetail !== 0) {
        return byDetail;
      }
      // Codepoint order, not localeCompare: collation discounts the ':' and '_'
      // in a driver key, which made the previous tie-break land somewhere no
      // reader of this code would predict.
      return a.key < b.key ? -1 : 1;
    });
    // Rebadge names are the main thing making one page's text unlike another's,
    // so the merged page keeps every variant's aliases, not only the survivor's.
    const aliases = [];
    const seen = new Set();
    for (const radio of ranked) {
      for (const alias of radio.aliases || []) {
        const id = `${alias.vendor}|${alias.model}|${alias.variant ?? ""}`;
        if (!seen.has(id)) {
          seen.add(id);
          aliases.push(alias);
        }
      }
    }
    merged.push({ ...ranked[0], aliases, variants: variantsOf(ranked, features) });
  }
  return merged;
}

// The drivers behind one merged page, each as a label and the two facts that
// most often differ between them. Only built when there is more than one, so an
// unmerged radio carries no variant list and its page is unchanged.
function variantsOf(ranked, features) {
  if (ranked.length < 2) {
    return [];
  }
  return ranked.map((radio) => {
    const entry = features[radio.key];
    const [low, high] = entry.memoryBounds;
    const names =
      entry.nameLength > 0
        ? `names up to ${entry.nameLength} characters`
        : "no channel names";
    return {
      key: radio.key,
      // "(stock)" rather than a bare model name, so the unmarked driver reads as
      // a deliberate choice next to its marked siblings instead of looking like
      // the list repeated the heading by accident.
      label: `${radio.model} (${radio.variant || "stock"})`,
      detail: `${high - low + 1} channels, ${names}`,
    };
  });
}

function faqEntries(radio, features) {
  const name = `${radio.vendor} ${radio.model}`;
  const [low, high] = features.memoryBounds;
  return [
    {
      question: `Do I need to install a USB driver to program the ${name}?`,
      answer:
        `No. WebCHIRP talks to ${CABLE_CHIPSETS} programming cables from the browser, `
        + "so there is nothing to install on Windows, macOS or Linux.",
    },
    {
      question: `Do I need the ${radio.vendor} CPS software?`,
      answer:
        `No. WebCHIRP runs CHIRP's own ${name} driver in the browser, so it reads and `
        + "writes the same codeplug the desktop software does.",
    },
    {
      question: `How many channels does the ${name} hold?`,
      answer: `${high - low + 1}, numbered ${low} to ${high} in the channel table.`,
    },
  ];
}

// Google reads this, not the prose, when it decides whether a page answers a
// question directly. The answers are the same text the page shows, because a
// mismatch between the two is what gets structured data ignored.
function faqJsonLd(entries) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  });
}

function renderModelPage({ radio, features, siblings, index, baseUrl, vendorHref, vendorLabel }) {
  const name = `${radio.vendor} ${radio.model}`;
  const slug = slugFor(radio);
  const title = `${name} programming software`;
  const [low, high] = features.memoryBounds;
  const description =
    `Program a ${name} from your browser: ${high - low + 1} channels, `
    + "no CPS download and no USB driver install. Runs CHIRP's own driver.";
  const aliases = aliasLabels(radio);
  const faq = faqEntries(radio, features);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];

  const aliasSection = aliases.length
    ? `
        <h2>Also sold as</h2>
        <p>
          The same CHIRP driver covers these rebadges, so this page applies to them too:
          ${escapeHtml(aliases.join(" · "))}.
        </p>`
    : "";

  // What the figures above do not cover. CHIRP has more than one driver for
  // some models -- firmware revisions and production runs that hold different
  // numbers of channels -- and the page states the first one's figures, so the
  // rest have to be visible rather than implied. Each links into the app with
  // that driver already chosen, which is the only place the choice can be made.
  const variants = radio.variants || [];
  const variantSection = variants.length
    ? `
        <h2>Which ${escapeHtml(radio.model)} do you have?</h2>
        <p>
          CHIRP has ${variants.length} drivers for the ${escapeHtml(name)}, covering different
          firmware and production runs. The figures above are the
          ${escapeHtml(variants[0].label)}; open yours directly if it is one of the others.
        </p>
        <ul>
${variants
  .map(
    (variant) =>
      `          <li><a href="../index.html?radio=${encodeURIComponent(variant.key)}"`
      + `>${escapeHtml(variant.label)}</a> — ${escapeHtml(variant.detail)}</li>`,
  )
  .join("\n")}
        </ul>`
    : "";

  // Previous and next are this vendor's own neighbours rather than the whole
  // catalog's, so following them walks one manufacturer's range -- the path a
  // person comparing two radios takes, and the one that keeps a vendor's pages
  // linked to each other instead of to an unrelated vendor's.
  const relatedLinks = [
    previous ? `<a href="./${slugFor(previous)}.html">${escapeHtml(previous.model)}</a>` : "",
    `<a href="${vendorHref}">${escapeHtml(vendorLabel)}</a>`,
    next ? `<a href="./${slugFor(next)}.html">${escapeHtml(next.model)}</a>` : "",
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- Same analytics wiring as index.html; the module owns the production-host gate. -->
    <script type="module" src="../js/analytics.js"></script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} | WebCHIRP</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${baseUrl}/radios/${slug}.html" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="WebCHIRP" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${baseUrl}/radios/${slug}.html" />
    <meta property="og:image" content="${baseUrl}/images/social-preview.png" />
    <link rel="icon" href="../favicon.ico" sizes="any" />
    <link rel="manifest" href="../manifest.webmanifest" />
    <link rel="apple-touch-icon" href="../images/apple-touch-icon.png" />
    <meta name="theme-color" content="#0d5ea8" />
    <link rel="stylesheet" href="../styles.css" />
    <script type="application/ld+json">
${faqJsonLd(faq)}
    </script>
  </head>
  <body class="about-page">
    <main class="about-shell">
      <article class="about-card radio-page">
        <div class="about-header">
          <h1>${escapeHtml(title)}</h1>
          <a class="toolbar-link" href="../index.html">Open WebCHIRP</a>
        </div>
        <p>
          WebCHIRP programs the ${escapeHtml(name)} in your browser. It runs the
          <a href="https://chirp.danplanet.com/">CHIRP</a> project's own driver for this
          radio, so it reads and writes the same codeplug the desktop software does —
          without installing anything.
        </p>
        <p>
          <a class="radio-page-cta" href="../index.html?radio=${encodeURIComponent(radio.key)}"
            >Program my ${escapeHtml(radio.model)} now</a
          >
        </p>

        <h2>No driver install needed</h2>
        <p>
          ${escapeHtml(radio.vendor)} programming cables use a ${CABLE_CHIPSETS} USB-serial
          chip. WebCHIRP speaks to all four directly from the browser, so there is no driver
          package to download and no Windows version to match. Plug the cable in and pick the
          port when the browser asks.
        </p>

        <h2>What you can edit on the ${escapeHtml(radio.model)}</h2>
        <ul>
${specBullets(radio, features).map((line) => `          <li>${escapeHtml(line)}</li>`).join("\n")}
        </ul>
${aliasSection}${variantSection}
        <h2>How to program a ${escapeHtml(name)}</h2>
        <ol>
          <li>Plug the programming cable into the radio and the computer.</li>
          <li>Open WebCHIRP, check ${escapeHtml(name)} is selected, and press Download.</li>
          <li>Edit the channels, or pull in nearby repeaters from a directory.</li>
          <li>Press Upload to write the result back to the radio.</li>
        </ol>

        <h2>Questions</h2>
${faq
  .map(
    (entry) => `        <h3>${escapeHtml(entry.question)}</h3>
        <p>${escapeHtml(entry.answer)}</p>`,
  )
  .join("\n")}

        <p class="radio-page-related">${relatedLinks.join(" · ")}</p>
      </article>
    </main>
  </body>
</html>
`;
}

// One vendor's range. This is the page that answers "does WebCHIRP do Yaesu",
// a search no model page can win because none of them is about the vendor.
function renderVendorPage({ vendor, radios, baseUrl }) {
  const slug = vendorSlugFor(vendor);
  const title = `${vendor} programming software`;
  const description =
    `Program any of ${radios.length} ${vendor} radios from your browser — `
    + "no CPS download, no USB driver install.";
  const items = radios
    .map((radio) => {
      const label = `${radio.vendor} ${radio.model}`;
      return `          <li><a href="./${slugFor(radio)}.html">${escapeHtml(label)}</a></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- Same analytics wiring as index.html; the module owns the production-host gate. -->
    <script type="module" src="../js/analytics.js"></script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} | WebCHIRP</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${baseUrl}/radios/${slug}.html" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="WebCHIRP" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${baseUrl}/radios/${slug}.html" />
    <meta property="og:image" content="${baseUrl}/images/social-preview.png" />
    <link rel="icon" href="../favicon.ico" sizes="any" />
    <link rel="manifest" href="../manifest.webmanifest" />
    <link rel="apple-touch-icon" href="../images/apple-touch-icon.png" />
    <meta name="theme-color" content="#0d5ea8" />
    <link rel="stylesheet" href="../styles.css" />
  </head>
  <body class="about-page">
    <main class="about-shell">
      <article class="about-card radio-page">
        <div class="about-header">
          <h1>${escapeHtml(title)}</h1>
          <a class="toolbar-link" href="../index.html">Open WebCHIRP</a>
        </div>
        <p>
          Every ${escapeHtml(vendor)} radio WebCHIRP can program, each page saying what that
          radio holds and how to get a codeplug on and off it. A handful of models are missing
          because their driver cannot describe them until a radio is attached — search for
          yours in the app.
        </p>
        <ul class="radio-page-list">
${items}
        </ul>
        <p class="radio-page-related"><a href="./index.html">All manufacturers</a></p>
      </article>
    </main>
  </body>
</html>
`;
}

// The directory of vendors, and the one page the app links to. It lists makers
// rather than models: 535 model links on one page is a keyword list, while 62
// vendor links is a route to any of them in two clicks.
function renderIndexPage({ directory, radios, baseUrl }) {
  const title = "Radio programming software by manufacturer";
  const description =
    `WebCHIRP programs ${radios.length} radios from ${directory.length} manufacturers in your `
    + "browser — no CPS download, no USB driver install.";
  const items = directory
    .map((entry) => {
      const count = `${entry.count} ${entry.count === 1 ? "model" : "models"}`;
      return `          <li><a href="${entry.href}">${escapeHtml(entry.vendor)}</a> `
        + `<span class="radio-page-count">${count}</span></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- Same analytics wiring as index.html; the module owns the production-host gate. -->
    <script type="module" src="../js/analytics.js"></script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} | WebCHIRP</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${baseUrl}/radios/index.html" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="WebCHIRP" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${baseUrl}/radios/index.html" />
    <meta property="og:image" content="${baseUrl}/images/social-preview.png" />
    <link rel="icon" href="../favicon.ico" sizes="any" />
    <link rel="manifest" href="../manifest.webmanifest" />
    <link rel="apple-touch-icon" href="../images/apple-touch-icon.png" />
    <meta name="theme-color" content="#0d5ea8" />
    <link rel="stylesheet" href="../styles.css" />
  </head>
  <body class="about-page">
    <main class="about-shell">
      <article class="about-card radio-page">
        <div class="about-header">
          <h1>${escapeHtml(title)}</h1>
          <a class="toolbar-link" href="../index.html">Open WebCHIRP</a>
        </div>
        <p>
          Every manufacturer WebCHIRP can program, covering ${radios.length} radios in all.
          Pick yours to see its models, each with what that radio holds and how to get a
          codeplug on and off it.
        </p>
        <ul class="radio-page-list">
${items}
        </ul>
      </article>
    </main>
  </body>
</html>
`;
}

// robots.txt and sitemap.xml are written here rather than living as static
// files because this script is the only thing that knows which model pages
// exist; a hand-maintained sitemap would be wrong the first time the vendor
// list widens.
function renderSitemap({ radios, vendorSlugs, baseUrl }) {
  const urls = [
    `${baseUrl}/`,
    `${baseUrl}/about.html`,
    `${baseUrl}/radios/index.html`,
    ...vendorSlugs.map((slug) => `${baseUrl}/radios/${slug}.html`),
    ...radios.map((radio) => `${baseUrl}/radios/${slugFor(radio)}.html`),
  ];
  const entries = urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

function renderRobots(baseUrl) {
  return `User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const catalog = await readJson(CATALOG_PATH);
  const { features, chirpRevision } = await readJson(FEATURES_PATH);
  if (chirpRevision !== catalog.chirpRevision) {
    throw new Error(
      `radio-features.json is from CHIRP ${chirpRevision} but the catalog is from `
      + `${catalog.chirpRevision}; run npm run build:catalog first.`,
    );
  }
  const host = (await readFile(CNAME_PATH, "utf8")).trim();
  if (!host) {
    throw new Error("CNAME is empty; the pages need a canonical host.");
  }
  const baseUrl = `https://${host}`;

  const skipped = [];
  const describable = [];
  for (const radio of catalog.radios) {
    const entry = features[radio.key];
    // A radio whose driver cannot describe itself would get a page saying
    // nothing a search could match, which is exactly the thin content that
    // makes a generated set worth less than no set at all.
    if (!entry || !entry.bands.length || entry.memoryBounds[1] <= entry.memoryBounds[0]) {
      skipped.push(radio.key);
      continue;
    }
    describable.push(radio);
  }
  const radios = mergeBySlug(describable, features);

  const byVendor = new Map();
  for (const radio of radios) {
    const list = byVendor.get(radio.vendor);
    if (list) {
      list.push(radio);
    } else {
      byVendor.set(radio.vendor, [radio]);
    }
  }
  // Ordered by slug rather than by display name so the ordering is the same on
  // every machine: slugs are plain lowercase ASCII, where a vendor or model
  // name can carry characters whose collation depends on the host's locale.
  for (const list of byVendor.values()) {
    list.sort((a, b) => slugFor(a).localeCompare(slugFor(b), "en"));
  }
  const vendorNames = [...byVendor.keys()].sort((a, b) =>
    vendorSlugFor(a).localeCompare(vendorSlugFor(b), "en"),
  );

  // A vendor with a single model gets no hub. The hub would hold one link and
  // repeat that model page's own subject, so the two would compete for the same
  // search with the weaker of them carrying less. The directory links straight
  // to the model page in that case.
  const hubVendors = vendorNames.filter((vendor) => byVendor.get(vendor).length > 1);
  const hubSlugs = new Map(hubVendors.map((vendor) => [vendor, vendorSlugFor(vendor)]));

  // Hubs and model pages share one directory, so a vendor whose slug matched a
  // model page's would overwrite it. Nothing in the catalog does today; failing
  // here beats discovering it later as a page that quietly went missing.
  const modelSlugs = new Set(radios.map((radio) => slugFor(radio)));
  for (const [vendor, slug] of hubSlugs) {
    if (modelSlugs.has(slug)) {
      throw new Error(
        `The ${vendor} hub and a model page both want ${slug}.html. `
        + "One would overwrite the other.",
      );
    }
  }

  // Rebuilt from scratch, so a radio that leaves the catalog leaves the site
  // rather than lingering as a page the sitemap no longer lists.
  await rm(PAGES_DIR, { recursive: true, force: true });
  await mkdir(PAGES_DIR, { recursive: true });

  for (const vendor of vendorNames) {
    const siblings = byVendor.get(vendor);
    const hubSlug = hubSlugs.get(vendor);
    const vendorHref = hubSlug ? `./${hubSlug}.html` : "./index.html";
    const vendorLabel = hubSlug ? `All ${vendor} radios` : "All supported radios";
    for (const [index, radio] of siblings.entries()) {
      const html = renderModelPage({
        radio,
        features: features[radio.key],
        siblings,
        index,
        baseUrl,
        vendorHref,
        vendorLabel,
      });
      await writeFile(path.join(PAGES_DIR, `${slugFor(radio)}.html`), html, "utf8");
    }
    if (hubSlug) {
      await writeFile(
        path.join(PAGES_DIR, `${hubSlug}.html`),
        renderVendorPage({ vendor, radios: siblings, baseUrl }),
        "utf8",
      );
    }
  }

  const directory = vendorNames.map((vendor) => {
    const siblings = byVendor.get(vendor);
    const hubSlug = hubSlugs.get(vendor);
    return {
      vendor,
      count: siblings.length,
      href: hubSlug ? `./${hubSlug}.html` : `./${slugFor(siblings[0])}.html`,
    };
  });
  await writeFile(
    path.join(PAGES_DIR, "index.html"),
    renderIndexPage({ directory, radios, baseUrl }),
    "utf8",
  );
  await writeFile(
    path.join(WEB_DIR, "sitemap.xml"),
    renderSitemap({ radios, vendorSlugs: [...hubSlugs.values()], baseUrl }),
    "utf8",
  );
  await writeFile(path.join(WEB_DIR, "robots.txt"), renderRobots(baseUrl), "utf8");

  const merged = radios.filter((radio) => radio.variants.length > 1);
  const written = (await readdir(PAGES_DIR)).length;
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${written} pages to ${path.relative(REPO_ROOT, PAGES_DIR)}: ${radios.length} models `
    + `across ${vendorNames.length} vendors, ${hubVendors.length} of which got a hub`
    + `${merged.length ? `, merging ${merged.length} model(s) whose drivers share one name: ${merged.map((radio) => radio.variants.map((variant) => variant.key).join(" + ")).join("; ")}` : ""}`
    + `${skipped.length ? `, skipping ${skipped.length} radio(s) that describe themselves too thinly: ${skipped.join(", ")}` : ""}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

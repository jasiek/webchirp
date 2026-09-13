// Static per-model pages, one per catalogued radio, written into web/radios/.
//
// The app itself is a single shell that says nothing until Pyodide has booted,
// so a crawler sees almost no text and the site cannot answer the searches it
// exists to serve ("baofeng uv-5r programming software", "bf-888s driver").
// These pages carry that text instead, and every fact on them comes from the
// driver: radio-catalog.json says which radios exist and what they are called,
// radio-features.json (scripts/build-catalog.mjs) says what each one can do.
// Nothing here invents a capability, which is also what keeps 55 pages from
// being 55 copies of one template.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.cwd();
const WEB_DIR = path.join(REPO_ROOT, "web");
const PAGES_DIR = path.join(WEB_DIR, "radios");
const CATALOG_PATH = path.join(WEB_DIR, "radio-catalog.json");
const FEATURES_PATH = path.join(REPO_ROOT, "radio-features.json");
const CNAME_PATH = path.join(REPO_ROOT, "CNAME");

// Which vendors get pages. Deliberately a subset: the first wave covers the
// vendor the keyword research pointed at, so the shape of a real page can be
// judged before 554 of them exist. Widening this is the only change needed to
// cover more -- everything below is driven by the catalog.
const VENDORS = new Set(["Baofeng"]);

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

// Vendor and model as one filename-safe token. Collisions would silently
// overwrite a page, so the caller checks for them rather than trusting this.
function slugFor(radio) {
  return `${radio.vendor}-${radio.model}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function renderModelPage({ radio, features, siblings, index, baseUrl }) {
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

  const relatedLinks = [
    previous ? `<a href="./${slugFor(previous)}.html">${escapeHtml(previous.model)}</a>` : "",
    `<a href="./index.html">All ${escapeHtml(radio.vendor)} radios</a>`,
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
${aliasSection}
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

function renderIndexPage({ radios, baseUrl, vendors }) {
  const vendorList = vendors.join(", ");
  const title = `${vendorList} programming software`;
  const description =
    `Program any of ${radios.length} ${vendorList} radios from your browser — `
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
          Every ${escapeHtml(vendorList)} radio WebCHIRP can program, each with what it holds
          and how to get a codeplug on and off it. WebCHIRP supports many more models than
          these — search for yours in the app.
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
function renderSitemap({ radios, baseUrl }) {
  const urls = [
    `${baseUrl}/`,
    `${baseUrl}/about.html`,
    `${baseUrl}/radios/index.html`,
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
  const radios = [];
  for (const radio of catalog.radios) {
    if (!VENDORS.has(radio.vendor)) {
      continue;
    }
    const entry = features[radio.key];
    // A radio whose driver cannot describe itself would get a page saying
    // nothing a search could match, which is exactly the thin content that
    // makes a generated set worth less than no set at all.
    if (!entry || !entry.bands.length || entry.memoryBounds[1] <= entry.memoryBounds[0]) {
      skipped.push(radio.key);
      continue;
    }
    radios.push(radio);
  }

  const bySlug = new Map();
  for (const radio of radios) {
    const slug = slugFor(radio);
    if (bySlug.has(slug)) {
      throw new Error(
        `Two radios slug to ${slug}: ${bySlug.get(slug).key} and ${radio.key}. `
        + "One would overwrite the other's page.",
      );
    }
    bySlug.set(slug, radio);
  }

  // Rebuilt from scratch, so a radio that leaves the catalog leaves the site
  // rather than lingering as a page the sitemap no longer lists.
  await rm(PAGES_DIR, { recursive: true, force: true });
  await mkdir(PAGES_DIR, { recursive: true });

  for (const [index, radio] of radios.entries()) {
    const html = renderModelPage({
      radio,
      features: features[radio.key],
      siblings: radios,
      index,
      baseUrl,
    });
    await writeFile(path.join(PAGES_DIR, `${slugFor(radio)}.html`), html, "utf8");
  }

  const vendors = [...new Set(radios.map((radio) => radio.vendor))].sort();
  await writeFile(
    path.join(PAGES_DIR, "index.html"),
    renderIndexPage({ radios, baseUrl, vendors }),
    "utf8",
  );
  await writeFile(path.join(WEB_DIR, "sitemap.xml"), renderSitemap({ radios, baseUrl }), "utf8");
  await writeFile(path.join(WEB_DIR, "robots.txt"), renderRobots(baseUrl), "utf8");

  const written = (await readdir(PAGES_DIR)).length;
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${written} pages to ${path.relative(REPO_ROOT, PAGES_DIR)} for ${vendors.join(", ")}`
    + `${skipped.length ? `, skipping ${skipped.length} radio(s) that describe themselves too thinly: ${skipped.join(", ")}` : ""}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

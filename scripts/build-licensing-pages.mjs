// Build one static licensing guide per country from the curated source records.
// The English copy is retained in each page's source so translations can be checked.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const WEB = path.join(ROOT, "web");
const OUTPUT = path.join(WEB, "licensing");

// Escape curated text at the HTML boundary so names and translations stay text.
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Turn an ISO country code into regional-indicator characters for the flag.
function flagEmoji(code) {
  return [...code.toUpperCase()].map((letter) =>
    String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65)).join("");
}

// CLDR country names give each page a native-language place name by default.
function countryName(record) {
  return record.localName || new Intl.DisplayNames([record.locale], { type: "region" }).of(record.code)
    || record.name;
}

// Keep translations and source URLs out of markup until they have been validated.
function validate(records, locales) {
  const seen = new Set();
  for (const record of records) {
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(record.slug) || seen.has(record.slug)) {
      throw new Error(`Invalid or duplicate licensing slug: ${record.slug}`);
    }
    seen.add(record.slug);
    if (!/^[A-Z]{2}$/.test(record.code) || !locales[record.locale]) {
      throw new Error(`Invalid flag code or missing language: ${record.name}`);
    }
    for (const link of [record.authority, record.society, ...(record.sources || [])]) {
      if (!link?.name || !/^https?:\/\//.test(link.url)) {
        throw new Error(`Missing source name or HTTP URL: ${record.name}`);
      }
    }
    for (const key of ["process", "cost", "time", "requirements"]) {
      const fact = record[key];
      if (fact && (!fact.local || !fact.en || !fact.source)) {
        throw new Error(`Incomplete ${key} translation or citation: ${record.name}`);
      }
    }
    if (JSON.stringify(record).includes("-->")) {
      throw new Error(`HTML comment terminator in ${record.name}`);
    }
  }
}

// Use a sourced translation where available and explicit uncertainty otherwise.
function fact(record, key, copy, fallback) {
  return record[key]?.[copy] || fallback;
}

// Collect every cited URL once so claim markers can point to a stable list.
function sourceLinks(record) {
  const links = [record.authority, record.society, ...(record.sources || []),
    { name: "IARU", url: "https://www.iaru.org/reference/member-societies/" }];
  for (const key of ["process", "cost", "time", "requirements"]) {
    const source = record[key]?.source;
    if (source && !links.some((link) => link.url === source)) {
      links.push({ name: new URL(source).host, url: source });
    }
  }
  return links.filter((link, index) => links.findIndex((item) => item.url === link.url) === index);
}

// Render visible local copy and a complete English source comment from the same facts.
function renderCountry(record, local, english, baseUrl) {
  const title = `${local.title}: ${countryName(record)}`;
  const translated = {
    process: fact(record, "process", "local", local.defaultProcess),
    cost: fact(record, "cost", "local", local.unknownCost),
    time: fact(record, "time", "local", local.unknownTime),
    requirements: fact(record, "requirements", "local", local.defaultRequirements),
  };
  const en = {
    process: fact(record, "process", "en", english.defaultProcess),
    cost: fact(record, "cost", "en", english.unknownCost),
    time: fact(record, "time", "en", english.unknownTime),
    requirements: fact(record, "requirements", "en", english.defaultRequirements),
  };
  const description = `${title}. ${translated.process}`;
  const sources = sourceLinks(record);
  // Keep each fact beside the specific source that supports it.
  function citedFact(key) {
    const number = sources.findIndex((source) => source.url === record[key]?.source) + 1;
    return `${escapeHtml(translated[key])}${number ? ` <a class="licensing-cite" href="#source-${number}">[${number}]</a>` : ""}`;
  }
  const englishComment = [
    "English translation of visible guide:",
    `Title: ${english.title}: ${record.name}`,
    `Procedure: ${en.process}`,
    `Licensing authority: ${record.authority.name}`,
    `Cost: ${en.cost}`,
    `Processing time: ${en.time}`,
    `Additional requirements: ${en.requirements}`,
    `National amateur radio organization: ${record.society.name}`,
    `Sources: ${sources.map((link) => `${link.name} (${link.url})`).join("; ")}`,
    `Navigation: ${english.directory}; ${english.app}`,
    `Headings and links: ${english.how}; ${english.officialInstructions}; ${english.authority}; ${english.cost}; ${english.time}; ${english.requirements}; ${english.society}; ${english.sources}`,
  ].join("\n    ");
  return `<!doctype html>
<html lang="${escapeHtml(record.locale)}"${["ar", "fa", "he"].includes(record.locale) ? ' dir="rtl"' : ""}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} | WebCHIRP</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${baseUrl}/licensing/${record.slug}.html" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="WebCHIRP" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${baseUrl}/licensing/${record.slug}.html" />
    <meta property="og:image" content="${baseUrl}/images/social-preview.png" />
    <link rel="icon" href="../favicon.ico" sizes="any" />
    <link rel="stylesheet" href="../styles.css" />
    <script type="module" src="../js/analytics.js"></script>
  </head>
  <body class="about-page licensing-page">
    <!-- ${englishComment} -->
    <main class="about-shell">
      <article class="about-card">
        <div class="licensing-header">
          <span class="licensing-flag" role="img" aria-label="${escapeHtml(record.name)} flag">${flagEmoji(record.code)}</span>
          <div><h1>${escapeHtml(title)}</h1>
          <nav><a href="./index.html">${escapeHtml(local.directory)}</a> · <a href="../index.html">${escapeHtml(local.app)}</a></nav></div>
        </div>
        <section><h2>${escapeHtml(local.how)}</h2><p>${citedFact("process")}
          <a href="${escapeHtml(record.authority.url)}" rel="nofollow noopener">${escapeHtml(local.officialInstructions)}</a>.</p></section>
        <dl class="licensing-facts">
          <div><dt>${escapeHtml(local.authority)}</dt><dd><a href="${escapeHtml(record.authority.url)}" rel="nofollow noopener">${escapeHtml(record.authority.name)}</a></dd></div>
          <div><dt>${escapeHtml(local.cost)}</dt><dd>${citedFact("cost")}</dd></div>
          <div><dt>${escapeHtml(local.time)}</dt><dd>${citedFact("time")}</dd></div>
          <div><dt>${escapeHtml(local.requirements)}</dt><dd>${citedFact("requirements")}</dd></div>
          <div><dt>${escapeHtml(local.society)}</dt><dd><a href="${escapeHtml(record.society.url)}" rel="nofollow noopener">${escapeHtml(record.society.localName || record.society.name)}</a></dd></div>
        </dl>
        <section><h2>${escapeHtml(local.sources)}</h2><ol class="licensing-sources">${sources.map((source, index) =>
          `<li id="source-${index + 1}"><a href="${escapeHtml(source.url)}" rel="nofollow noopener">${escapeHtml(source.localName || source.name)}</a></li>`).join("")}</ol></section>
      </article>
    </main>
  </body>
</html>
`;
}

// Sort the English directory by its visible English country labels.
function renderIndex(records, baseUrl) {
  const links = records.toSorted((left, right) => left.name.localeCompare(right.name, "en"))
    .map((record) => {
      const nativeName = countryName(record);
      const localLabel = nativeName === record.name ? "" :
        ` <span class="licensing-directory-local" lang="${escapeHtml(record.locale)}" dir="auto">${escapeHtml(nativeName)}</span>`;
      return `<li><span class="licensing-flag" aria-hidden="true">${flagEmoji(record.code)}</span> <a href="./${record.slug}.html"><span lang="en">${escapeHtml(record.name)}</span>${localLabel}</a></li>`;
    }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Amateur radio licences by country | WebCHIRP</title>
  <meta name="description" content="Country guides to amateur radio licensing, fees, processing times and national societies." />
  <link rel="canonical" href="${baseUrl}/licensing/index.html" />
  <link rel="stylesheet" href="../styles.css" /><link rel="icon" href="../favicon.ico" sizes="any" />
  <script type="module" src="../js/analytics.js"></script></head>
<body class="about-page licensing-page"><main class="about-shell"><div class="about-card">
  <h1>Amateur radio licences by country</h1><p>Select a country for its licensing authority, cost, processing time, requirements and national amateur radio organization.</p>
  <ul class="licensing-directory">${links}</ul>
  <p><a href="../index.html">WebCHIRP app</a></p>
</div></main></body></html>\n`;
}

// Rebuild the guides and refresh their sitemap entries in the page build.
async function main() {
  const records = JSON.parse(await readFile(path.join(ROOT, "licensing-countries.json"), "utf8"));
  const locales = JSON.parse(await readFile(path.join(ROOT, "licensing-locales.json"), "utf8"));
  validate(records, locales);
  const baseUrl = `https://${(await readFile(path.join(ROOT, "CNAME"), "utf8")).trim()}`;
  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
  for (const record of records) {
    await writeFile(path.join(OUTPUT, `${record.slug}.html`),
      renderCountry(record, locales[record.locale], locales.en, baseUrl), "utf8");
  }
  await writeFile(path.join(OUTPUT, "index.html"), renderIndex(records, baseUrl), "utf8");
  const sitemap = path.join(WEB, "sitemap.xml");
  const xml = await readFile(sitemap, "utf8");
  if (!xml.includes("</urlset>")) {
    throw new Error("The model-page sitemap is missing its closing urlset tag.");
  }
  // A direct rerun of this generator must replace, not duplicate, its URLs.
  const withoutLicensing = xml.replace(/\s*<url><loc>[^<]*\/licensing\/[^<]*<\/loc><\/url>/g, "");
  const entries = ["index", ...records.map((record) => record.slug)].map((slug) =>
    `  <url><loc>${baseUrl}/licensing/${slug}.html</loc></url>`).join("\n");
  await writeFile(sitemap, withoutLicensing.replace("</urlset>", `${entries}\n</urlset>`), "utf8");
  console.log(`Wrote ${records.length} country licensing pages and an index.`);
}

await main();

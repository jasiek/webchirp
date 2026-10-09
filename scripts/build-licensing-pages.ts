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
function validate(records, locales, guides, cept) {
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
    if (JSON.stringify(record).includes("-->")) {
      throw new Error(`HTML comment terminator in ${record.name}`);
    }
    const guide = guides[record.slug];
    if (!guide) throw new Error(`No researched guide: ${record.name}`);
    const claims = [...(guide.steps || []), ...(guide.requirements || []),
      guide.cost, guide.time?.official, guide.time?.forum].filter(Boolean);
    if (claims.some((claim) => !claim.local || !claim.en || !/^https?:\/\//.test(claim.url)
      || (claim.additionalUrls || []).some((url) => !/^https?:\/\//.test(url)))) {
      throw new Error(`Incomplete researched claim: ${record.name}`);
    }
    if (guide.time?.forum && !/\b202[5-9]\b/.test(guide.time.forum.date || "")) {
      throw new Error(`Processing anecdote must be dated 2025 or later: ${record.name}`);
    }
    if (JSON.stringify(guide).includes("-->")) {
      throw new Error(`HTML comment terminator in researched guide: ${record.name}`);
    }
  }
  for (const group of [cept.members, cept.nonMemberImplementers,
    cept.territoriesUsingUs, cept.suspended]) {
    if (group.some((slug) => !seen.has(slug))) throw new Error("Unknown CEPT country slug");
  }
}

// Collect every cited URL once so claim markers can point to a stable list.
function sourceLinks(record, guide, cept) {
  const links = [record.authority, record.society,
    { name: "IARU", url: "https://www.iaru.org/reference/member-societies/" },
    { name: "CEPT", url: cept.membershipSource },
    { name: "CEPT T/R 61-01", url: cept.recommendationSource },
    { name: "CEPT T/R 61-01", url: cept.implementationSource }];
  for (const claim of [...(guide?.steps || []), ...(guide?.requirements || []),
    guide?.cost, guide?.time?.official, guide?.time?.forum].filter(Boolean)) {
    links.push({ name: new URL(claim.url).host,
      localName: claim.linkLabelLocal, enName: claim.linkLabelEn, url: claim.url });
    for (const url of claim.additionalUrls || []) {
      links.push({ name: new URL(url).host, url });
    }
  }
  if (cept.suspended.includes(record.slug)) {
    links.push({ name: "CEPT", url: cept.suspensionSource });
  }
  return links.filter((link, index) => links.findIndex((item) => item.url === link.url) === index);
}

// Distinguish CEPT membership from non-member adoption of its visitor recommendation.
function ceptStatus(record, cept, copy) {
  if (cept.members.includes(record.slug)) return copy.ceptMember;
  if (cept.nonMemberImplementers.includes(record.slug)) return copy.ceptImplementer;
  if (cept.territoriesUsingUs.includes(record.slug)) return copy.ceptUsTerritory;
  if (cept.suspended.includes(record.slug)) return copy.ceptSuspended;
  return copy.ceptOutside;
}

// Render one complete language view, with citation targets private to that view.
function renderLanguagePanel(record, guide, copy, language, cept, sources) {
  const english = language === "en";
  const key = english ? "en" : "local";
  const title = `${copy.how}: ${english ? record.name : countryName(record)}`;
  const translated = {
    cost: guide.cost?.[key] || copy.unknownCost,
    time: guide.time?.official?.[key] || guide.time?.forum?.[key] || copy.unknownTime,
  };
  const citationPrefix = english ? "source-en" : "source-native";
  // Number citations from the same URL list used by this view's source section.
  function citation(url) {
    const number = sources.findIndex((source) => source.url === url) + 1;
    return number ? ` <a class="licensing-cite" href="#${citationPrefix}-${number}">[${number}]</a>` : "";
  }
  // A claim may need separate citations for its fee or application components.
  function citations(claim) {
    return claim ? [claim.url, ...(claim.additionalUrls || [])].map(citation).join("") : "";
  }
  // Keep each fact beside the specific source that supports it.
  function citedFact(fact) {
    const claim = fact === "time" ? guide.time?.official || guide.time?.forum : guide[fact];
    return `${escapeHtml(translated[fact])}${citations(claim)}`;
  }
  const stepsHtml = guide.steps?.length
    ? `<ol class="licensing-steps">${guide.steps.map((step) => `<li>${escapeHtml(step[key])} <a href="${escapeHtml(step.url)}" rel="nofollow noopener">${escapeHtml((english ? step.linkLabelEn : step.linkLabelLocal) || copy.officialInstructions)}</a>${citations(step)}</li>`).join("")}</ol>${guide.procedureStatus === "partial" ? `<p class="licensing-gap">${escapeHtml(copy.unverifiedSteps)}</p>` : ""}`
    : `<p>${escapeHtml(copy.unverifiedSteps)} <a href="${escapeHtml(record.authority.url)}" rel="nofollow noopener">${escapeHtml(copy.officialInstructions)}</a>.</p>`;
  const requirementsHtml = guide.requirements?.length
    ? `<ul>${guide.requirements.map((item) => `<li>${escapeHtml(item[key])}${citations(item)}</li>`).join("")}</ul>`
    : escapeHtml(copy.unverifiedRequirements);
  const timeHtml = guide.time?.official || guide.time?.forum
    ? [guide.time?.official && `<p><strong>${escapeHtml(copy.officialTime)}:</strong> ${escapeHtml(guide.time.official[key])}${citations(guide.time.official)}</p>`,
      guide.time?.forum && `<p><strong>${escapeHtml(copy.reportedTime)}:</strong> ${escapeHtml(guide.time.forum[key])}${citations(guide.time.forum)}</p>`,
      !guide.time?.forum && `<p class="licensing-gap">${escapeHtml(copy.noRecentReport)}</p>`].filter(Boolean).join("")
    : `${citedFact("time")} <p class="licensing-gap">${escapeHtml(copy.noRecentReport)}</p>`;
  const authorityName = english ? record.authority.enName || record.authority.name : record.authority.name;
  const societyName = english ? record.society.enName || record.society.name :
    record.society.localName || record.society.name;
  const languageCode = english ? "en" : record.locale;
  return `<div class="licensing-language-panel" data-licensing-panel="${english ? "en" : "native"}" data-page-title="${escapeHtml(title)} | WebCHIRP" lang="${escapeHtml(languageCode)}" dir="${["ar", "fa", "he"].includes(languageCode) ? "rtl" : "ltr"}"${english ? " hidden" : ""}>
        <div class="licensing-header">
          <span class="licensing-flag" role="img" aria-label="${escapeHtml(record.name)} flag">${flagEmoji(record.code)}</span>
          <div><h1>${escapeHtml(title)}</h1>
          <nav><a href="./index.html">${escapeHtml(copy.directory)}</a> · <a href="../index.html">${escapeHtml(copy.app)}</a></nav></div>
        </div>
        <section><h2>${escapeHtml(copy.officialInstructions)}</h2>${stepsHtml}</section>
        <dl class="licensing-facts">
          <div><dt>${escapeHtml(copy.authority)}</dt><dd><a href="${escapeHtml(record.authority.url)}" rel="nofollow noopener">${escapeHtml(authorityName)}</a></dd></div>
          <div><dt>${escapeHtml(copy.cost)}</dt><dd>${citedFact("cost")}</dd></div>
          <div><dt>${escapeHtml(copy.time)}</dt><dd>${timeHtml}</dd></div>
          <div><dt>${escapeHtml(copy.requirements)}</dt><dd>${requirementsHtml}</dd></div>
          <div><dt>${escapeHtml(copy.society)}</dt><dd><a href="${escapeHtml(record.society.url)}" rel="nofollow noopener">${escapeHtml(societyName)}</a></dd></div>
        </dl>
        <section><h2>${escapeHtml(copy.cept)}</h2><p>${escapeHtml(ceptStatus(record, cept, copy))}${citation(cept.members.includes(record.slug) ? cept.membershipSource : cept.implementationSource)}${citation(cept.recommendationSource)}${cept.suspended.includes(record.slug) ? citation(cept.suspensionSource) : ""}</p></section>
        <section><h2>${escapeHtml(copy.sources)}</h2><ol class="licensing-sources">${sources.map((source, index) =>
          `<li id="${citationPrefix}-${index + 1}"><a href="${escapeHtml(source.url)}" rel="nofollow noopener">${escapeHtml((english ? source.enName : source.localName) || source.name)}</a></li>`).join("")}</ol></section>
      </div>`;
}

// Render both language views while keeping the native one as the static default.
function renderCountry(record, guide, local, english, cept, baseUrl) {
  const title = `${local.how}: ${countryName(record)}`;
  const description = `${title}. ${guide?.steps?.[0]?.local || local.unverifiedSteps}`;
  const nativeLanguage = new Intl.DisplayNames([record.locale], { type: "language" }).of(record.locale);
  const sources = sourceLinks(record, guide, cept);
  const en = {
    process: english.unverifiedSteps,
    cost: guide.cost?.en || english.unknownCost,
    requirements: english.unverifiedRequirements,
  };
  const ceptEnglish = ceptStatus(record, cept, english);
  const englishComment = [
    "English translation of visible guide:",
    `Title: ${english.how}: ${record.name}`,
    `Procedure: ${guide?.steps?.length ? guide.steps.map((step, index) => `${index + 1}. ${step.en} (${step.url})`).join(" ") : en.process}${guide.procedureStatus === "partial" ? ` ${english.unverifiedSteps}` : ""}`,
    `Licensing authority: ${record.authority.enName || record.authority.name}`,
    `Cost: ${en.cost}`,
    `Official processing time: ${guide?.time?.official?.en || english.unknownTime}`,
    `Recent applicant report: ${guide?.time?.forum?.en || english.noRecentReport}`,
    `Additional requirements: ${guide?.requirements?.length ? guide.requirements.map((item) => item.en).join(" ") : en.requirements}`,
    `CEPT status: ${ceptEnglish}`,
    `National amateur radio organization: ${record.society.enName || record.society.name}`,
    `Sources: ${sources.map((link) => `${link.name} (${link.url})`).join("; ")}`,
    `Navigation: ${english.directory}; ${english.app}`,
    `Headings and links: ${english.how}; ${english.officialInstructions}; ${english.authority}; ${english.cost}; ${english.time}; ${english.requirements}; ${english.cept}; ${english.society}; ${english.sources}`,
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
    <script type="module" src="../js/analytics.ts"></script>
    ${record.locale === "en" ? "" : '<script type="module" src="../js/licensing-language.ts"></script>'}
  </head>
  <body class="about-page licensing-page">
    <!-- ${englishComment} -->
    <main class="about-shell">
      <article class="about-card">
        ${record.locale === "en" ? "" : `<div class="licensing-language-switch" role="group" aria-label="Language">
          <button type="button" data-licensing-language="native" aria-pressed="true" aria-label="${escapeHtml(nativeLanguage)}" title="${escapeHtml(nativeLanguage)}">${flagEmoji(record.code)}</button>
          <button type="button" data-licensing-language="en" aria-pressed="false" aria-label="English" title="English">🇬🇧</button>
        </div>`}
        ${renderLanguagePanel(record, guide, local, "native", cept, sources)}
        ${record.locale === "en" ? "" : renderLanguagePanel(record, guide, english, "en", cept, sources)}
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
  <script type="module" src="../js/analytics.ts"></script></head>
<body class="about-page licensing-page"><main class="about-shell"><div class="about-card">
  <h1>Amateur radio licences by country</h1><p>Select a country for its licensing authority, cost, processing time, requirements and national amateur radio organization.</p>
  <ul class="licensing-directory">${links}</ul>
  <p><a href="../index.html">WebCHIRP app</a></p>
</div></main></body></html>\n`;
}

// Keep the research audit outside web/ so it is never linked or included in the sitemap.
function renderResearchSummary(records, guides, cept) {
  const sorted = records.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  const status = (value) => value ? "Found" : "Missing";
  const rows = sorted.map((record) => {
    const guide = guides[record.slug];
    const stepCount = guide?.steps?.length || 0;
    const requirementCount = guide?.requirements?.length || 0;
    const procedure = guide?.procedureStatus === "partial" ?
      `Partial (${stepCount} ${stepCount === 1 ? "step" : "steps"})` :
      `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
    const cost = guide?.cost ? (guide.costStatus === "partial" ? "Partial" : "Found") : "Missing";
    const ceptValue = cept.members.includes(record.slug) ? "Member" :
      cept.nonMemberImplementers.includes(record.slug) ? "Implements T/R 61-01" :
        cept.territoriesUsingUs.includes(record.slug) ? "US territory; US arrangement" :
        cept.suspended.includes(record.slug) ? "Suspended" : "Outside / not listed";
    return `| ${record.name} | ${procedure} | ${cost} | ${status(guide?.time?.official)} | ${status(guide?.time?.forum)} | ${requirementCount} ${requirementCount === 1 ? "item" : "items"} | ${ceptValue} |`;
  });
  const found = (test) => sorted.filter((record) => test(guides[record.slug])).length;
  return `# Amateur radio licensing research coverage

Reviewed: ${cept.reviewedAt}. This audit is deliberately outside the published website. "Found" means a sourced claim is present in the country guide; it does not promise that the quoted fee or estimate will stay current. "Partial" means a documented step or fee component exists but the full route or fixed total is unverified. "Missing" means the requested evidence could not be verified, not that the fee or wait is zero. The forum column accepts only first-hand reports dated 2025 onward.

| Country or territory | Official procedure | Cost | Official time | 2025+ forum time | Official requirements | CEPT status |
| --- | ---: | --- | --- | --- | ---: | --- |
${rows.join("\n")}

## Coverage

- Sourced steps: ${found((guide) => guide?.steps?.length)} of ${sorted.length}; full procedure not verified for ${found((guide) => guide?.procedureStatus === "partial")}.
- Sourced cost: ${found((guide) => guide?.cost)} of ${sorted.length}; ${found((guide) => guide?.costStatus === "partial")} have only a component or variable total.
- Official processing or exam timeline: ${found((guide) => guide?.time?.official)} of ${sorted.length}.
- Applicant processing reports dated 2025 onward: ${found((guide) => guide?.time?.forum)} of ${sorted.length}.
- Official additional requirements: ${found((guide) => guide?.requirements?.length)} of ${sorted.length}.
- CEPT membership and T/R 61-01 implementation: checked for all ${sorted.length} against [ECO's current membership list](${cept.membershipSource}) and [T/R 61-01 implementation table](${cept.implementationSource}).

The forum column is intentionally narrow: an official service target does not count as a first-hand processing report, and an undated or pre-2025 post is excluded. A cost known only from an older, conflicting page is excluded. Country pages cite the specific forms, guidance and fee sources next to each claim.

## Procedure gaps

${sorted.filter((record) => guides[record.slug]?.procedureStatus === "partial")
    .map((record) => `- **${record.name}:** ${guides[record.slug].procedureGap}`).join("\n")}
`;
}

// Rebuild the guides and refresh their sitemap entries in the page build.
async function main() {
  const records = JSON.parse(await readFile(path.join(ROOT, "licensing-countries.json"), "utf8"));
  const locales = JSON.parse(await readFile(path.join(ROOT, "licensing-locales.json"), "utf8"));
  const guideCopy: Record<string, Record<string, unknown>> = JSON.parse(
    await readFile(path.join(ROOT, "licensing-guide-copy.json"), "utf8"),
  );
  const guides = JSON.parse(await readFile(path.join(ROOT, "licensing-guide-details.json"), "utf8"));
  const cept = JSON.parse(await readFile(path.join(ROOT, "licensing-cept.json"), "utf8"));
  for (const [language, copy] of Object.entries(guideCopy)) {
    locales[language] = { ...locales[language], ...copy };
  }
  validate(records, locales, guides, cept);
  const baseUrl = `https://${(await readFile(path.join(ROOT, "CNAME"), "utf8")).trim()}`;
  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
  for (const record of records) {
    const local = { ...locales.en, ...locales[record.locale] };
    await writeFile(path.join(OUTPUT, `${record.slug}.html`),
      renderCountry(record, guides[record.slug], local, locales.en, cept, baseUrl), "utf8");
  }
  await writeFile(path.join(OUTPUT, "index.html"), renderIndex(records, baseUrl), "utf8");
  await writeFile(path.join(ROOT, "LICENSING_RESEARCH_SUMMARY.md"),
    renderResearchSummary(records, guides, cept), "utf8");
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

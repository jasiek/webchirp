import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceRoot, outputRoot] = process.argv.slice(2);
if (!sourceRoot || !outputRoot) throw new Error("Usage: node build-licensing-wiki.mjs SOURCE_ROOT OUTPUT_ROOT");
const output = path.resolve(outputRoot);
if (output !== path.join(path.resolve(sourceRoot), "wiki")) {
  throw new Error("Wiki output must be the source repository's wiki directory");
}

// Read the same reviewed data that builds the country landing pages.
async function readJson(name) {
  return JSON.parse(await readFile(path.join(sourceRoot, name), "utf8"));
}

const [records, locales, guideCopy, guides, cept] = await Promise.all([
  readJson("licensing-countries.json"),
  readJson("licensing-locales.json"),
  readJson("licensing-guide-copy.json"),
  readJson("licensing-guide-details.json"),
  readJson("licensing-cept.json"),
]);
const wikiBase = "https://github.com/jasiek/webchirp/wiki";
const sorted = records.toSorted((a, b) => a.name.localeCompare(b.name, "en"));

// Preserve the country's localized display name used by the website.
function countryName(record) {
  return record.localName || new Intl.DisplayNames([record.locale], { type: "region" }).of(record.code) || record.name;
}

// Encode the two-letter country code as a flag for the Home index and title.
function flagEmoji(code) {
  return [...code.toUpperCase()].map((letter) =>
    String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65)).join("");
}

// Keep source URLs as explicit wiki citations beside each claim.
function link(label, url) {
  if (!/^https?:\/\//.test(url) || url.includes(">")) throw new Error(`Invalid wiki URL: ${url}`);
  return `[${String(label).replace(/[\\\[\]]/g, "\\$&")}](<${url}>)`;
}

// Keep supplementary fee sources beside the component they document.
function claimLinks(claim, firstLabel) {
  if (!claim) return "";
  const urls = [claim.url, ...(claim.additionalUrls || [])];
  return urls.map((url, index) => link(index === 0 ? firstLabel : new URL(url).hostname, url)).join(" · ");
}

// Explain CEPT status without treating temporary visitor rights as a resident licence.
function ceptStatus(record, copy) {
  if (cept.members.includes(record.slug)) return copy.ceptMember;
  if (cept.nonMemberImplementers.includes(record.slug)) return copy.ceptImplementer;
  if (cept.territoriesUsingUs.includes(record.slug)) return copy.ceptUsTerritory;
  if (cept.suspended.includes(record.slug)) return copy.ceptSuspended;
  return copy.ceptOutside;
}

// Mirror the localized guide in Markdown and retain its English verification comment.
function renderCountry(record) {
  const guide = guides[record.slug];
  if (!guide || !guide.steps?.length) throw new Error(`Missing procedure: ${record.slug}`);
  const local = { ...locales.en, ...locales[record.locale], ...guideCopy[record.locale] };
  const en = { ...locales.en, ...guideCopy.en };
  const title = `${flagEmoji(record.code)} ${local.how}: ${countryName(record)}`;
  const sources = new Map();
  // Deduplicate the source list while keeping links beside their claims.
  const addSource = (name, url) => { if (!sources.has(url)) sources.set(url, name); };
  addSource(record.authority.name, record.authority.url);
  addSource(record.society.name, record.society.url);
  addSource("IARU member societies", "https://www.iaru.org/reference/member-societies/");
  addSource("CEPT membership", cept.membershipSource);
  addSource("CEPT T/R 61-01", cept.recommendationSource);
  addSource("CEPT implementation", cept.implementationSource);
  if (cept.suspended.includes(record.slug)) addSource("CEPT suspension", cept.suspensionSource);
  for (const claim of [...guide.steps, ...(guide.requirements || []), guide.cost,
    guide.time?.official, guide.time?.forum].filter(Boolean)) {
    addSource(claim.linkLabelLocal || new URL(claim.url).hostname, claim.url);
    for (const url of claim.additionalUrls || []) addSource(new URL(url).hostname, url);
  }
  const stepLines = guide.steps.map((step, index) =>
    `${index + 1}. ${step.local} ${claimLinks(step, step.linkLabelLocal || local.officialInstructions)}`);
  if (guide.procedureStatus === "partial") stepLines.push(`\n${local.unverifiedSteps}`);
  const cost = guide.cost
    ? `${guide.cost.local} ${claimLinks(guide.cost, local.sources)}`
    : local.unknownCost;
  const time = [];
  if (guide.time?.official) {
    time.push(`**${local.officialTime}:** ${guide.time.official.local} ${claimLinks(guide.time.official, local.sources)}`);
  } else {
    time.push(local.unknownTime);
  }
  if (guide.time?.forum) {
    time.push(`**${local.reportedTime}:** ${guide.time.forum.local} ${claimLinks(guide.time.forum, local.sources)}`);
  } else {
    time.push(local.noRecentReport);
  }
  const requirements = guide.requirements?.length
    ? guide.requirements.map((item) => `- ${item.local} ${claimLinks(item, local.sources)}`).join("\n")
    : local.unverifiedRequirements;
  const ceptLinks = [
    link("CEPT membership", cept.membershipSource),
    link("T/R 61-01", cept.recommendationSource),
    link("Implementation", cept.implementationSource),
    ...(cept.suspended.includes(record.slug) ? [link("Suspension", cept.suspensionSource)] : []),
  ].join(" · ");
  const englishComment = [
    "English translation of the visible guide:",
    `Title: ${en.how}: ${record.name}`,
    `Procedure: ${guide.steps.map((step, index) => `${index + 1}. ${step.en} (${step.url})`).join(" ")}${guide.procedureStatus === "partial" ? ` ${en.unverifiedSteps}` : ""}`,
    `Licensing authority: ${record.authority.enName || record.authority.name}`,
    `Cost: ${guide.cost?.en || en.unknownCost}`,
    `Official processing time: ${guide.time?.official?.en || en.unknownTime}`,
    `Applicant report since 2025: ${guide.time?.forum?.en || en.noRecentReport}`,
    `Additional requirements: ${guide.requirements?.length ? guide.requirements.map((item) => item.en).join(" ") : en.unverifiedRequirements}`,
    `CEPT status: ${ceptStatus(record, en)}`,
    `National amateur radio organization: ${record.society.enName || record.society.name}`,
  ].join("\n");
  if (englishComment.includes("-->")) throw new Error(`Invalid English comment: ${record.slug}`);
  return [
    `# ${title}`,
    "",
    link(local.directory, `${wikiBase}/Home`),
    "",
    `_${cept.reviewedAt}_`,
    "",
    `## ${local.officialInstructions}`,
    "",
    stepLines.join("\n"),
    "",
    `## ${local.authority}`,
    "",
    link(record.authority.localName || record.authority.name, record.authority.url),
    "",
    `## ${local.cost}`,
    "",
    cost,
    "",
    `## ${local.time}`,
    "",
    time.join("\n\n"),
    "",
    `## ${local.requirements}`,
    "",
    requirements,
    "",
    `## ${local.cept}`,
    "",
    ceptStatus(record, local),
    "",
    ceptLinks,
    "",
    `## ${local.society}`,
    "",
    link(record.society.localName || record.society.name, record.society.url),
    "",
    `## ${local.sources}`,
    "",
    [...sources].map(([url, name]) => `- ${link(name, url)}`).join("\n"),
    "",
    "<!--",
    englishComment,
    "-->",
    "",
  ].join("\n");
}

// Recreate the generated-only directory so removed countries cannot linger.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const record of sorted) {
  await writeFile(path.join(output, `${record.slug}.md`), renderCountry(record), "utf8");
}
const home = [
  "# Amateur radio licensing by country",
  "",
  `Research reviewed ${cept.reviewedAt}. Choose a country for official application steps, current fee evidence, processing information, additional requirements, CEPT visitor guidance, and the national amateur radio organization. Missing evidence is identified on the relevant page.`,
  "",
  ...sorted.map((record) => `- ${flagEmoji(record.code)} ${link(record.name, `${wikiBase}/${record.slug}`)}`),
  "",
].join("\n");
await writeFile(path.join(output, "Home.md"), home, "utf8");
console.log(`Wrote ${sorted.length} country wiki pages and Home.md to ${output}`);

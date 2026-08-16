// Turns a finished loopback run into a pre-filled GitHub issue URL.
//
// The page this serves is used at a bench and, increasingly, on a phone — where
// selecting a report out of a <pre>, switching apps and pasting it into a form
// is the whole reason a failure goes unreported. One tap has to be enough, so
// everything the maintainer would otherwise ask for rides in the URL.

import { detectBrowserVersion } from "./ui/format.js";

export const ISSUE_TEMPLATE_NAME = "adapter_loopback_report.yml";
export const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";
// GitHub answers an over-long prefill URL with HTTP 414 instead of the form, and
// an issue form reads query params only — there is no POST prefill to fall back
// on. Same backstop the app's bug reporter uses, for the same reason.
export const ISSUE_URL_LIMIT = 6000;

const TAIL_TRIM_NOTE = "<report truncated - use Copy report for the full run>";

function passTrimNote(count) {
  return `<${count} passing cases trimmed - use Copy report for the full run>`;
}

function isPassLine(line) {
  return /^PASS\b/.test(line);
}

// Trim by relevance rather than by age: a failing run at 5 baud rates is mostly
// PASS lines, and those are the lines a maintainer reads last. Dropping them
// keeps every failure plus the header and the totals, which is what the report
// is for. Only if that still overruns is the report cut at the end, and either
// cut says so rather than passing for a complete run.
export function fitLoopbackReport(report, { measure, limit }) {
  const lines = String(report ?? "").split("\n");
  if (measure(lines.join("\n")) <= limit) {
    return lines.join("\n");
  }

  const passes = lines.filter(isPassLine).length;
  const withoutPasses = lines.filter((line) => !isPassLine(line));
  const trimmed = passes > 0 ? [...withoutPasses, passTrimNote(passes)] : withoutPasses;
  if (measure(trimmed.join("\n")) <= limit) {
    return trimmed.join("\n");
  }

  // Measure with the note already attached, so the note itself can never be what
  // pushes the URL back over the limit.
  let kept = [];
  for (const line of trimmed) {
    if (measure([...kept, line, TAIL_TRIM_NOTE].join("\n")) > limit) {
      break;
    }
    kept.push(line);
  }
  return [...kept, TAIL_TRIM_NOTE].join("\n");
}

// detectOperatingSystem() in format.js answers for the app's bug-report
// dropdown, whose options stop at Linux/macOS/Windows/Other — and Android says
// "Linux" in its user agent, so a phone would report as a Linux desktop. This
// page is the one people run on a phone, so it needs the handset named.
export function detectPlatform(userAgent) {
  const ua = String(userAgent || "");
  if (/\bAndroid\b/i.test(ua)) {
    return "Android";
  }
  if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) {
    return "iOS / iPadOS";
  }
  if (/\bCrOS\b/.test(ua)) {
    return "ChromeOS";
  }
  if (/Windows/i.test(ua)) {
    return "Windows";
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return "macOS";
  }
  if (/Linux|X11/i.test(ua)) {
    return "Linux";
  }
  return "Other";
}

export function buildLoopbackIssueTitle({ adapter, summary }) {
  const failed = Number(summary?.failed) || 0;
  const outcome = failed > 0
    ? `${failed} ${failed === 1 ? "case" : "cases"} failed`
    : "all cases passed";
  return `Adapter loopback: ${outcome} on ${adapter || "an unnamed adapter"}`;
}

// `report` is the text the Copy report button hands over, so the issue carries
// exactly what the person filing it can see on screen.
export function buildLoopbackIssueUrl({
  report,
  adapter,
  summary,
  version,
  userAgent = "",
  limit = ISSUE_URL_LIMIT,
}) {
  const buildUrl = (body) => {
    const params = new URLSearchParams({
      template: ISSUE_TEMPLATE_NAME,
      title: buildLoopbackIssueTitle({ adapter, summary }).slice(0, 240),
      // Its own field as well as a line in the report: the report can be
      // trimmed, and a version that only survives sometimes is worse than
      // useless when a fix has to be checked against the code that ran.
      webchirp_version: version || "unknown",
      adapter: adapter || "Unknown adapter",
      platform: detectPlatform(userAgent),
      browser_and_version: detectBrowserVersion(userAgent),
      // The template renders this field as a code block already, so no fences.
      loopback_report: body,
    });
    return `${ISSUE_NEW_URL}?${params.toString()}`;
  };

  return buildUrl(fitLoopbackReport(report, {
    measure: (body) => buildUrl(body).length,
    limit,
  }));
}

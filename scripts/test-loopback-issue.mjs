import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ISSUE_TEMPLATE_NAME,
  ISSUE_URL_LIMIT,
  buildLoopbackIssueTitle,
  buildLoopbackIssueUrl,
  detectPlatform,
} from "../web/js/loopback-issue.js";

// A pre-filled issue URL is only useful if GitHub serves the form: over-long
// URLs come back as HTTP 414, and a field name the template does not declare is
// silently dropped. Both failures look like "the button did nothing useful" to
// whoever is stood at a bench with a broken adapter, so both are pinned here.
const TEMPLATE = fs.readFileSync(
  path.join(process.cwd(), ".github", "ISSUE_TEMPLATE", ISSUE_TEMPLATE_NAME),
  "utf8",
);

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)"
  + " Chrome/128.0.6613.99 Mobile Safari/537.36";

function reportWith({ passes = 0, failures = 0, detail = "byte 3 differed" } = {}) {
  const lines = [
    "WebCHIRP: 7749974 (updated 2026-08-07)",
    "Adapter: WCH CH340/CH341 (WebUSB driver) — USB 0x1a86:0x7523",
    `Browser: ${ANDROID_UA}`,
    "Baud rates: 9600, 38400, 115200",
    "Control lines bridged: no",
    "",
  ];
  for (let index = 0; index < passes; index += 1) {
    lines.push(`PASS  Echo round trip @ ${9600 + index}`);
  }
  for (let index = 0; index < failures; index += 1) {
    lines.push(`FAIL  Echo round trip @ ${9600 + index} — ${detail}`);
  }
  lines.push(`${passes} passed, ${failures} failed, 0 skipped`);
  return lines.join("\n");
}

function fieldsOf(url) {
  return new URL(url).searchParams;
}

test("the URL names a template that exists and only fields it declares", () => {
  const params = fieldsOf(buildLoopbackIssueUrl({
    report: reportWith({ passes: 3 }),
    adapter: "WCH CH340/CH341 (WebUSB driver)",
    summary: { passed: 3, failed: 0, skipped: 0 },
    version: "7749974 (updated 2026-08-07)",
    userAgent: ANDROID_UA,
  }));

  // `template` and `title` are GitHub's own; everything else must be an id the
  // form declares, or the value is dropped without a word.
  for (const name of params.keys()) {
    if (name === "template" || name === "title") {
      continue;
    }
    assert.match(TEMPLATE, new RegExp(`^\\s+id: ${name}$`, "m"), `template has no field "${name}"`);
  }
  assert.equal(params.get("template"), ISSUE_TEMPLATE_NAME);
});

test("the environment a maintainer would ask for rides along", () => {
  const params = fieldsOf(buildLoopbackIssueUrl({
    report: reportWith({ passes: 2, failures: 1 }),
    adapter: "WCH CH340/CH341 (WebUSB driver) — USB 0x1a86:0x7523",
    summary: { passed: 2, failed: 1, skipped: 0 },
    version: "7749974 (updated 2026-08-07)",
    userAgent: ANDROID_UA,
  }));

  assert.equal(params.get("webchirp_version"), "7749974 (updated 2026-08-07)");
  assert.equal(params.get("adapter"), "WCH CH340/CH341 (WebUSB driver) — USB 0x1a86:0x7523");
  assert.equal(params.get("platform"), "Android");
  assert.equal(params.get("browser_and_version"), "Chrome 128.0.6613.99");
  assert.ok(params.get("loopback_report").includes("FAIL  Echo round trip @ 9600"));
});

test("a phone reports as a phone, not as the Linux its user agent claims", () => {
  assert.equal(detectPlatform(ANDROID_UA), "Android");
  assert.equal(
    detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari"),
    "iOS / iPadOS",
  );
  assert.equal(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0"), "Linux");
  assert.equal(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows");
  assert.equal(detectPlatform(""), "Other");
});

test("the title counts the failures, so the issue list is readable", () => {
  assert.equal(
    buildLoopbackIssueTitle({ adapter: "FTDI (WebUSB driver)", summary: { failed: 1 } }),
    "Adapter loopback: 1 case failed on FTDI (WebUSB driver)",
  );
  assert.equal(
    buildLoopbackIssueTitle({ adapter: "FTDI (WebUSB driver)", summary: { failed: 4 } }),
    "Adapter loopback: 4 cases failed on FTDI (WebUSB driver)",
  );
  assert.equal(
    buildLoopbackIssueTitle({ adapter: "FTDI (WebUSB driver)", summary: { failed: 0 } }),
    "Adapter loopback: all cases passed on FTDI (WebUSB driver)",
  );
});

test("a short report is sent whole, with no trim note", () => {
  const report = reportWith({ passes: 4, failures: 1 });
  const body = fieldsOf(buildLoopbackIssueUrl({
    report,
    adapter: "FTDI (WebUSB driver)",
    summary: { passed: 4, failed: 1, skipped: 0 },
    userAgent: ANDROID_UA,
  })).get("loopback_report");

  assert.equal(body, report);
  assert.ok(!body.includes("trimmed"), "a report that fits must not be trimmed");
});

test("an over-long run drops passing cases first and keeps every failure", () => {
  const url = buildLoopbackIssueUrl({
    report: reportWith({ passes: 400, failures: 3 }),
    adapter: "FTDI (WebUSB driver)",
    summary: { passed: 400, failed: 3, skipped: 0 },
    userAgent: ANDROID_UA,
  });
  const body = fieldsOf(url).get("loopback_report");

  assert.ok(url.length <= ISSUE_URL_LIMIT, `expected within ${ISSUE_URL_LIMIT} chars, got ${url.length}`);
  assert.equal((body.match(/^FAIL/gm) || []).length, 3, "every failure must survive");
  assert.ok(!body.includes("PASS"), "passing cases are what gets dropped");
  assert.match(body, /400 passing cases trimmed/);
  assert.ok(body.includes("400 passed, 3 failed, 0 skipped"), "the totals still say how many passed");
  assert.ok(body.includes("Adapter: WCH"), "the header must survive the trim");
});

test("a run that is all failures is cut at the end and says so", () => {
  // Nothing left to drop by relevance: the backstop has to cut the report
  // itself rather than let GitHub answer 414.
  const url = buildLoopbackIssueUrl({
    report: reportWith({ failures: 300, detail: "expected 0xA5 0x5A, read 0xFF 0xFF" }),
    adapter: "FTDI (WebUSB driver)",
    summary: { passed: 0, failed: 300, skipped: 0 },
    userAgent: ANDROID_UA,
  });
  const body = fieldsOf(url).get("loopback_report");

  assert.ok(url.length <= ISSUE_URL_LIMIT, `expected within ${ISSUE_URL_LIMIT} chars, got ${url.length}`);
  assert.match(body, /report truncated/);
  assert.ok(body.includes("Adapter: WCH"), "the header must survive the trim");
  assert.ok(body.includes("WebCHIRP: 7749974"), "the version must survive the trim");
  assert.ok(body.includes("FAIL  Echo round trip @ 9600"), "the first failures must survive");
});

test("one pathological line cannot push the URL past the backstop", () => {
  const url = buildLoopbackIssueUrl({
    report: `Adapter: FTDI\nFAIL  Echo round trip — read back ${"A1B2C3D4 ".repeat(2000)}`,
    adapter: "FTDI (WebUSB driver)",
    summary: { passed: 0, failed: 1, skipped: 0 },
    userAgent: ANDROID_UA,
  });

  assert.ok(url.length <= ISSUE_URL_LIMIT, `expected within ${ISSUE_URL_LIMIT} chars, got ${url.length}`);
  assert.match(fieldsOf(url).get("loopback_report"), /report truncated/);
});

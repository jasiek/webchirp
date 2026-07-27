import assert from "node:assert/strict";
import test from "node:test";

import { createIssueReporter } from "../web/js/ui/issue-report.js";

// The debug excerpt is capped at a line count, with a URL-length backstop:
// GitHub answers an over-long issue-prefill URL with HTTP 414 rather than the
// form, and there is no POST prefill to fall back on. These tests pin the line
// cap, the backstop, and the fact that either kind of cut is disclosed in the
// report rather than passing for a complete log.
const URL_LIMIT = 6000;
const TAIL_LINES = 40;

function makeReporter({ debugLines = [], lastErrorSummary = "" } = {}) {
  const state = {
    selectedRadio: { vendor: "Yaesu", model: "FT-60R" },
    lastUsbVendorId: "0x10C4",
    lastUsbProductId: "0xEA60",
    runtimeInfo: { chirpRevision: "1a2b3c4d" },
  };
  const log = {
    latestDebugTail: (lineCount) => debugLines.slice(-lineCount).join("\n"),
    getLastErrorSummary: () => lastErrorSummary,
    logDebug: () => {},
  };
  return createIssueReporter({ state, log });
}

function stampedLine(index, text) {
  const seconds = String(index % 60).padStart(2, "0");
  const minutes = String(Math.floor(index / 60) % 60).padStart(2, "0");
  return `[2026-07-27T12:${minutes}:${seconds}.123Z] ${text}`;
}

function actualBehaviorOf(url) {
  const params = new URL(url).searchParams;
  return params.get("actual_behavior");
}

test("a long session is cut to the last N lines and says so", () => {
  const debugLines = Array.from({ length: 400 }, (_, index) =>
    stampedLine(index, `SERIAL wrote 64 bytes in frame ${index} of the clone stream`),
  );
  const body = actualBehaviorOf(makeReporter({ debugLines }).buildIssueUrl());
  const excerpt = body.split("```")[1].trim().split("\n");

  assert.equal(excerpt.length, TAIL_LINES + 1, "N lines plus the trim note");
  assert.match(excerpt[0], /earlier debug lines trimmed/);
  assert.ok(excerpt.at(-1).includes("frame 399"), "newest line must survive");
  assert.ok(!body.includes("frame 359 "), `only the last ${TAIL_LINES} lines ride along`);
});

test("one pathological line cannot push the URL past the backstop", () => {
  // A single hex dump can outweigh the whole line budget, which is why the line
  // cap alone is not enough to keep the URL inside GitHub's limit.
  const debugLines = Array.from({ length: 10 }, (_, index) =>
    stampedLine(index, `SERIAL read block ${index}: ${"A1B2C3D4 ".repeat(500)}`),
  );
  const url = makeReporter({ debugLines }).buildIssueUrl();

  assert.ok(
    url.length <= URL_LIMIT,
    `expected URL within ${URL_LIMIT} chars, got ${url.length}`,
  );
  assert.match(actualBehaviorOf(url), /earlier debug lines trimmed/);
});

test("a short log is reported in full, with no truncation note", () => {
  const debugLines = [
    stampedLine(1, "STATUS Connected to radio."),
    stampedLine(2, "DOWNLOAD ERROR Traceback: boom"),
  ];
  const body = actualBehaviorOf(
    makeReporter({ debugLines, lastErrorSummary: "DOWNLOAD ERROR Traceback: boom" }).buildIssueUrl(),
  );

  assert.ok(!body.includes("trimmed"), "short logs must not be trimmed");
  assert.ok(body.includes("STATUS Connected to radio."));
  assert.ok(body.includes("DOWNLOAD ERROR Traceback: boom"));
});

test("log stamps are compacted to the time of day", () => {
  const debugLines = [stampedLine(5, "STATUS Ready.")];
  const body = actualBehaviorOf(makeReporter({ debugLines }).buildIssueUrl());

  assert.ok(body.includes("[12:00:05] STATUS Ready."), body);
  assert.ok(!body.includes("2026-07-27"), "the date adds no signal to a report");
});

test("an empty debug panel says so instead of emitting an empty block", () => {
  const body = actualBehaviorOf(makeReporter().buildIssueUrl());

  assert.ok(body.includes("<no debug logs captured>"));
});

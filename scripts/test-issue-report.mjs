import assert from "node:assert/strict";
import test from "node:test";

import { createIssueReporter } from "../web/js/ui/issue-report.js";

// GitHub answers an over-long issue-prefill URL with HTTP 414 rather than the
// form, and there is no POST prefill to fall back on, so the reporter has to
// keep the generated URL inside its own budget no matter how big the debug
// panel has grown. These tests pin that budget and the trimming order.
const URL_LIMIT = 6000;

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

test("a huge debug log still yields a URL within the budget", () => {
  const debugLines = Array.from({ length: 400 }, (_, index) =>
    stampedLine(index, `SERIAL wrote 64 bytes in frame ${index} of the clone stream`),
  );
  const url = makeReporter({ debugLines }).buildIssueUrl();

  assert.ok(
    url.length <= URL_LIMIT,
    `expected URL within ${URL_LIMIT} chars, got ${url.length}`,
  );
  assert.match(actualBehaviorOf(url), /earlier debug lines trimmed/);
});

test("trimming keeps the newest lines and drops the oldest", () => {
  const debugLines = Array.from({ length: 400 }, (_, index) =>
    stampedLine(index, `SERIAL frame ${index} padding ${"x".repeat(60)}`),
  );
  const body = actualBehaviorOf(makeReporter({ debugLines }).buildIssueUrl());

  assert.ok(body.includes("SERIAL frame 399 "), "newest line must survive");
  assert.ok(!body.includes("SERIAL frame 0 "), "oldest line must be dropped");
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

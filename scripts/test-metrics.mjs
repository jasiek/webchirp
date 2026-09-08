import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FLOWS, OUTCOMES, recordFlow } from "../web/js/ui/metrics.js";
import { METRIC_ATTRIBUTES, initSentry, resetSentryForTests } from "../web/js/sentry.js";
import { makeWindow } from "./test-support/fake-window.mjs";
import { jsDir } from "./test-support/repo-paths.mjs";

// The vocabulary the UI records flows in. web/js/sentry.js owns the vendor
// wiring and the redaction, and is covered in scripts/test-sentry.mjs; what
// matters here is that the two questions these metrics exist to answer -- which
// flows are broken, and which radios fail inside them -- stay answerable by a
// group-by rather than needing a union of per-flow series.

// Fake SDK with only the surface captureMetric() reaches.
function makeSdk() {
  const recorded = [];
  return {
    recorded,
    metrics: {
      count: (name, value, opts) => recorded.push({ type: "count", name, value, ...opts }),
      distribution: (name, value, opts) => recorded.push({ type: "distribution", name, value, ...opts }),
    },
    init() {},
    withScope() {},
    captureException() {},
  };
}

async function withSdk(fn) {
  resetSentryForTests();
  const sdk = makeSdk();
  await initSentry(makeWindow(), { loadSdk: async () => sdk });
  try {
    await fn(sdk);
  } finally {
    resetSentryForTests();
  }
}

test("a flow with a duration records both a count and a distribution", async () => {
  await withSdk(async (sdk) => {
    recordFlow(
      FLOWS.RADIO_DOWNLOAD,
      OUTCOMES.FAILED,
      { radio: "Baofeng UV-5R", radio_module: "uv5r", error_kind: "checksum" },
      4200,
    );
    assert.deepEqual(sdk.recorded.map((m) => m.name), ["flow.completed", "flow.duration"]);
    // Both carry the same dimensions, so a dashboard can put the failure rate
    // and the time it took to fail on one filter.
    for (const metric of sdk.recorded) {
      assert.equal(metric.attributes.flow, "radio_download");
      assert.equal(metric.attributes.outcome, "failed");
      assert.equal(metric.attributes.radio, "Baofeng UV-5R");
    }
    assert.equal(sdk.recorded[1].value, 4200);
    assert.equal(sdk.recorded[1].unit, "millisecond");
  });
});

test("a flow whose duration is not ours to answer for records only a count", async () => {
  await withSdk(async (sdk) => {
    // A file import is bounded by the user's disk, and a serial connect by how
    // long they take to pick a port in the browser's chooser. Timing either
    // measures the user, not the app.
    recordFlow(FLOWS.CODEPLUG_IMPORT, OUTCOMES.OK, { format: "img" });
    assert.deepEqual(sdk.recorded.map((m) => m.name), ["flow.completed"]);
  });
});

test("a non-numeric duration is omitted rather than sent as NaN", async () => {
  await withSdk(async (sdk) => {
    recordFlow(FLOWS.APP_START, OUTCOMES.OK, {}, Number.NaN);
    assert.deepEqual(sdk.recorded.map((m) => m.name), ["flow.completed"]);
  });
});

test("an unknown flow name is dropped rather than opening a new series", async () => {
  await withSdk(async (sdk) => {
    // A typo at a call site has to cost one missing metric, not quietly add a
    // second series to the dashboard that looks like real data.
    recordFlow("radio_downlod", OUTCOMES.FAILED, {});
    assert.equal(sdk.recorded.length, 0);
  });
});

test("blocked is its own outcome, distinct from failed", () => {
  // An upload stopped by preflight validation is the app working. Counting it
  // as a failure would bury the transfers that genuinely broke underneath the
  // codeplugs CHIRP correctly refused.
  assert.notEqual(OUTCOMES.BLOCKED, OUTCOMES.FAILED);
  assert.equal(new Set(Object.values(OUTCOMES)).size, Object.values(OUTCOMES).length);
});

test("every flow is a distinct name", () => {
  assert.equal(new Set(Object.values(FLOWS)).size, Object.values(FLOWS).length);
});

// Pull the top-level keys out of the attribute object of every `recordFlow(...)`
// call, so the coverage check below reads the calls themselves rather than a
// hand-kept list. Same shape as the trackEvent scanner in
// scripts/test-ga-dimensions.mjs, and it relies on the same thing: the object
// has to be a literal at the call site, not a variable holding one.
function recordedAttributes(source) {
  const names = new Set();
  for (
    let start = source.indexOf("recordFlow(");
    start !== -1;
    start = source.indexOf("recordFlow(", start + 1)
  ) {
    let depth = 0;
    let objectStart = -1;
    for (let index = start + "recordFlow".length; index < source.length; index += 1) {
      const char = source[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      } else if (char === "{" && depth === 1) {
        objectStart = index;
        break;
      }
    }
    if (objectStart === -1) {
      continue;
    }
    let braces = 0;
    for (let index = objectStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") {
        braces += 1;
      } else if (char === "}") {
        braces -= 1;
        if (braces === 0) {
          break;
        }
      } else if (braces === 1 && /[A-Za-z_]/.test(char) && /[{,\s]/.test(source[index - 1])) {
        const key = source.slice(index).match(/^[A-Za-z_]\w*(?=\s*:)/);
        if (key) {
          names.add(key[0]);
        }
      }
    }
  }
  return names;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

test("the scanner finds the attributes a recordFlow call actually sends", () => {
  assert.deepEqual([...recordedAttributes('recordFlow(F.A, O.B, { a: 1, b: "x" });')], ["a", "b"]);
  assert.deepEqual([...recordedAttributes("recordFlow(F.A, O.B);")], []);
  assert.deepEqual([...recordedAttributes("recordFlow(F.A, O.B, { a: 1 }, ms);")], ["a"]);
});

test("every attribute the app records is on the allowlist", () => {
  const declared = new Set([...METRIC_ATTRIBUTES, "flow", "outcome"]);
  const sent = new Set();
  for (const file of sourceFiles(jsDir)) {
    for (const name of recordedAttributes(fs.readFileSync(file, "utf8"))) {
      sent.add(name);
    }
  }

  assert.ok(sent.size > 0, "found no recordFlow attributes — the scanner is broken, not the app");
  const undeclared = [...sent].filter((name) => !declared.has(name));
  assert.deepEqual(
    undeclared,
    [],
    "these attributes are recorded but not in METRIC_ATTRIBUTES, so web/js/sentry.js drops them "
      + `and the flow looks like it never ran: ${undeclared.join(", ")}`,
  );
});

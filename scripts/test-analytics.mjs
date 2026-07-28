import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  channelCountBucket,
  classifyErrorKind,
  codeplugParams,
  errorTypeName,
  firstIssueColumn,
  radioEventParams,
  trackEvent,
} from "../web/js/ui/analytics.js";

const HTML = fs.readFileSync(path.join(process.cwd(), "web", "index.html"), "utf8");

// The bootstrap in index.html is the only thing standing between the shared
// measurement ID and every copy of this app that is not the production site, so
// these tests read the page itself rather than trusting that the guard is still
// there. A dev server or a fork's Pages site reporting into the same property
// is silent when it happens and unfixable afterwards — GA4 does not let you
// delete events you wish you had not collected.
function analyticsBootstrap() {
  const block = (HTML.match(/<script>[\s\S]*?<\/script>/g) || [])
    .find((script) => script.includes("G-80DP6MQ180"));
  assert.ok(block, "index.html no longer contains the analytics bootstrap");
  return block;
}

function allowedHosts() {
  return Array.from(analyticsBootstrap().matchAll(/location\.hostname === '([^']+)'/g))
    .map((match) => match[1])
    .sort();
}

test("the analytics tag is never loaded unconditionally", () => {
  // A plain <script src=…googletagmanager…> would run everywhere regardless of
  // what the inline bootstrap below it decides.
  assert.equal(
    /<script[^>]*src="https:\/\/www\.googletagmanager\.com/.test(HTML),
    false,
    "the gtag loader must be created inside the host check, not as a static tag",
  );
});

test("everything touching GA sits behind the host check", () => {
  const block = analyticsBootstrap();
  const guardAt = block.indexOf("if (location.hostname");
  assert.ok(guardAt >= 0, "the bootstrap no longer guards on location.hostname");
  // Both the config call and the loader must come after the guard opens.
  assert.ok(block.indexOf("G-80DP6MQ180") > guardAt);
  assert.ok(block.indexOf("googletagmanager") > guardAt);
});

test("only the production host is allowed to report", () => {
  assert.deepEqual(allowedHosts(), ["codeplug.org", "www.codeplug.org"]);
});

// Run the real bootstrap out of index.html against a stubbed page. Asserting on
// the text only proves the guard is spelled right; this proves it still does
// its job on the production host, which is the failure that would go unnoticed
// — nobody checks that analytics arrived, only that it did not.
function runBootstrap(hostname) {
  const body = analyticsBootstrap().replace(/^<script>/, "").replace(/<\/script>$/, "");
  const appended = [];
  const priorWindow = globalThis.window;
  // The bootstrap is a classic inline script: window is the global object and
  // `window.gtag = …` is what makes the bare gtag() calls below it resolve.
  globalThis.window = globalThis;
  globalThis.location = { hostname };
  globalThis.document = {
    createElement: () => ({}),
    head: { appendChild: (element) => appended.push(element) },
  };
  try {
    (0, eval)(body);
    return {
      appended,
      calls: (globalThis.dataLayer || []).map((args) => Array.from(args)),
      gtagDefined: typeof globalThis.gtag === "function",
    };
  } finally {
    for (const key of ["dataLayer", "gtag", "gtagScript", "location", "document"]) {
      delete globalThis[key];
    }
    if (priorWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = priorWindow;
    }
  }
}

test("the bootstrap configures and loads GA on the production host", () => {
  const { appended, calls, gtagDefined } = runBootstrap("codeplug.org");
  assert.equal(gtagDefined, true);
  assert.equal(appended.length, 1, "the gtag loader script was not appended");
  assert.match(appended[0].src, /googletagmanager\.com\/gtag\/js\?id=G-80DP6MQ180$/);
  assert.equal(appended[0].async, true);
  assert.deepEqual(calls.at(-1), ["config", "G-80DP6MQ180"]);
});

test("the bootstrap does nothing at all off the production host", () => {
  for (const hostname of ["localhost", "127.0.0.1", "jasiek.github.io", "codeplug.org.evil.com"]) {
    const { appended, calls, gtagDefined } = runBootstrap(hostname);
    assert.equal(gtagDefined, false, `${hostname} defined gtag`);
    assert.deepEqual(appended, [], `${hostname} requested the gtag loader`);
    assert.deepEqual(calls, [], `${hostname} queued analytics calls`);
  }
});

test("the allowlist covers the domain the site is actually served from", () => {
  // CNAME is what GitHub Pages serves the app on. If the domain ever moves and
  // the allowlist is not moved with it, analytics goes silent — which is the
  // failure that would otherwise take months to notice.
  const cname = fs.readFileSync(path.join(process.cwd(), "CNAME"), "utf8").trim();
  assert.ok(
    allowedHosts().includes(cname),
    `CNAME is ${cname}, which the index.html allowlist does not include`,
  );
});

// A Pyodide failure reaches the UI as the Python traceback string wrapped in a
// JS Error, so the interesting content sits in the middle of error.stack: the
// first line is the generic "Traceback" banner and the last lines are JS stack
// frames. These fixtures keep that shape.
function pythonError(exceptionLine) {
  const error = new Error(`Traceback (most recent call last):\n  File "<exec>", line 1, in <module>\n${exceptionLine}`);
  error.stack = `Error: ${error.message}\n    at invokeRuntimeMethod (runtime-rpc.js:1:1)`;
  return error;
}

test("classifyErrorKind maps radio failures onto the fixed vocabulary", () => {
  assert.equal(
    classifyErrorKind(pythonError("chirp.errors.RadioError: Radio did not respond")),
    "no_response",
  );
  assert.equal(
    classifyErrorKind(pythonError("chirp.errors.RadioError: Incorrect model ID, got 0x1234")),
    "ident_mismatch",
  );
  assert.equal(
    classifyErrorKind(new Error("The device has been lost.")),
    "serial_disconnect",
  );
  assert.equal(
    classifyErrorKind(new Error("Serial read timed out after 3s")),
    "timeout",
  );
  assert.equal(classifyErrorKind(new Error("Checksum mismatch in block 4")), "checksum");
});

test("classifyErrorKind falls back to other rather than leaking the message", () => {
  assert.equal(classifyErrorKind(new Error("something nobody anticipated")), "other");
  assert.equal(classifyErrorKind(null), "other");
});

test("errorTypeName reads the exception type from either error shape", () => {
  // Python names its exception on the last line, below the JS frames that the
  // wrapping Error appends.
  assert.equal(
    errorTypeName(pythonError("chirp.errors.RadioError: Radio did not respond")),
    "RadioError",
  );
  assert.equal(errorTypeName(new TypeError("x is not a function")), "TypeError");
  assert.equal(errorTypeName(new Error("plain")), "Error");
  // The traceback banner ends in a colon too, and must not be read as a type.
  assert.equal(errorTypeName("Traceback (most recent call last):"), "");
  assert.equal(errorTypeName("no colon here at all"), "");
});

test("radioEventParams sends driver identity and nothing else", () => {
  assert.deepEqual(
    radioEventParams({
      vendor: "Baofeng",
      model: "UV-5R",
      module: "chirp.drivers.uv5r",
      className: "BaofengUV5R",
      // Fields that exist on catalog entries but must never be reported.
      key: "uv5r",
      baudRate: 9600,
    }),
    {
      radio_make: "Baofeng",
      radio_model: "UV-5R",
      radio_module: "chirp.drivers.uv5r",
      radio_class: "BaofengUV5R",
    },
  );
  assert.deepEqual(radioEventParams(null), {});
});

test("firstIssueColumn reports a column name, never a rejected value", () => {
  assert.equal(
    firstIssueColumn([
      { rowIndex: 2, column: "", message: "no column" },
      { rowIndex: 3, column: "Frequency", message: "444.000 out of range" },
    ]),
    "Frequency",
  );
  assert.equal(firstIssueColumn([]), "");
  assert.equal(firstIssueColumn(undefined), "");
});

test("channelCountBucket covers each range at its boundaries", () => {
  assert.equal(channelCountBucket(0), "0");
  assert.equal(channelCountBucket(1), "1-16");
  assert.equal(channelCountBucket(16), "1-16");
  assert.equal(channelCountBucket(17), "17-128");
  assert.equal(channelCountBucket(128), "17-128");
  assert.equal(channelCountBucket(129), "129-512");
  assert.equal(channelCountBucket(512), "129-512");
  assert.equal(channelCountBucket(513), "512+");
});

test("channelCountBucket refuses to invent a bucket for a non-count", () => {
  assert.equal(channelCountBucket(-1), "unknown");
  assert.equal(channelCountBucket(1.5), "unknown");
  assert.equal(channelCountBucket(NaN), "unknown");
  assert.equal(channelCountBucket(undefined), "unknown");
});

test("codeplugParams reports the editor's scale and provenance", () => {
  assert.deepEqual(
    codeplugParams({ currentRows: new Array(200).fill({}), codeplugSource: "img" }),
    { channel_count: 200, channel_count_bucket: "129-512", codeplug_source: "img" },
  );
  // Before anything has been loaded there is no provenance to report, and an
  // empty editor must not be reported as a zero-channel codeplug someone made.
  assert.deepEqual(
    codeplugParams({ currentRows: [], codeplugSource: "" }),
    { channel_count: 0, channel_count_bucket: "0", codeplug_source: "unknown" },
  );
  assert.deepEqual(
    codeplugParams(undefined),
    { channel_count: 0, channel_count_bucket: "0", codeplug_source: "unknown" },
  );
});

test("trackEvent is inert without gtag and survives a throwing one", () => {
  assert.equal(globalThis.gtag, undefined);
  assert.doesNotThrow(() => trackEvent("radio_download", { radio_make: "Baofeng" }));

  const sent = [];
  globalThis.gtag = (...args) => sent.push(args);
  try {
    trackEvent("radio_download_success", { duration_ms: 12 });
    assert.deepEqual(sent, [["event", "radio_download_success", { duration_ms: 12 }]]);

    // Content blockers commonly replace gtag with a stub that throws; a clone
    // must not fail because its telemetry did.
    globalThis.gtag = () => {
      throw new Error("blocked");
    };
    assert.doesNotThrow(() => trackEvent("radio_download_failure", {}));
  } finally {
    delete globalThis.gtag;
  }
});

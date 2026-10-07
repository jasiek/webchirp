import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTracingOptions, scrubTraceSpan } from "../../web/js/sentry-tracing.js";
import { resolveRepeaterApiBase } from "../../web/js/datasources.js";
import { fakeSentryTracing } from "../support/fake-sentry-tracing.mjs";

// Inspect both policies: sampling fewer spans alone does not remove preflights.
function assertTarget(options, url, expected) {
  const integration = options.integrations.find(({ name }) => name === "BrowserTracing");
  assert.equal(options.tracePropagationTargets.some((target) => target.test(url)), expected, url);
  assert.equal(integration.options.shouldCreateSpanForRequest(url), expected, url);
}

test("only directory endpoints get tracing headers or spans, at 10% sampling", () => {
  const options = createTracingOptions(fakeSentryTracing);
  assert.equal(options.tracesSampleRate, 0.1);
  for (const [url, expected] of [
    ["https://api.codeplug.org/repeaterbook?lat=51.5074", true],
    ["https://api.codeplug.org/przemienniki/meta", true],
    ["https://api.codeplug.org/irts", true],
    ["https://api.codeplug.org/cities?q=London", false],
    ["https://api.codeplug.org/lookup/M0ABC", false],
    ["https://api.codeplug.org/repeaterbook/extra", false],
    ["https://api.codeplug.org", false],
    ["https://api.codeplug.org.evil.example/repeaterbook", false],
    ["https://api.codeplug.org@evil.example/repeaterbook", false],
    ["https://evil.example/?next=https://api.codeplug.org/repeaterbook", false],
    ["http://api.codeplug.org/repeaterbook", false],
    ["https://api.codeplug.org:8443/repeaterbook", false],
    ["https://cdn.jsdelivr.net/npm/pyodide", false],
    ["https://api-beta.rsgb.online/locator/IO82MM", false],
    ["./version.json", false],
  ]) assertTarget(options, url, expected);
});

test("tracing follows the configured HTTPS API base and blank-base IRTS fallback", () => {
  const doc = { querySelector: () => ({ getAttribute: () => "https://proxy.example:8443/api.v1" }) };
  const options = createTracingOptions(fakeSentryTracing, resolveRepeaterApiBase(doc));
  assertTarget(options, "https://proxy.example:8443/api.v1/repeaterbook?q=secret", true);
  assertTarget(options, "https://proxy.example:8443/apiXv1/repeaterbook", false);
  assertTarget(options, "https://proxy.example:8443/api.v1/cities?q=secret", false);
  assertTarget(options, "https://api.codeplug.org/repeaterbook", false);
  const span = options.beforeSendSpan({ attributes: {
    "sentry.op": "http.client", "url.full": "https://proxy.example:8443/api.v1/repeaterbook?q=secret",
  } });
  assert.equal(span.name, "https://proxy.example:8443/api.v1/repeaterbook");
  const blank = createTracingOptions(fakeSentryTracing, "");
  assertTarget(blank, "https://api.codeplug.org/irts", true);
  assertTarget(blank, "https://api.codeplug.org/repeaterbook", false);
  for (const base of ["http://proxy.example", "invalid", "https://user:pass@proxy.example", "https://proxy.example/?q=secret"]) {
    assert.deepEqual(createTracingOptions(fakeSentryTracing, base).tracePropagationTargets, [], base);
  }
});

test("span privacy removes query and inherited user data without renaming parent segments", () => {
  const span = scrubTraceSpan({
    trace_id: "a".repeat(32), span_id: "b".repeat(16), parent_span_id: "c".repeat(16), is_segment: false,
    name: "GET https://api.codeplug.org/repeaterbook?latitude=51.5074#private",
    attributes: {
      "url.full": "https://api.codeplug.org/repeaterbook?latitude=51.5074#private",
      "http.method": "GET", "http.response.status_code": 200,
      "http.query": "?latitude=51.5074", "http.fragment": "private",
      "http.request.header.referer": "https://codeplug.org/?q=home",
      "user.email": "person@example.org", "sentry.segment.name": "M0ABC",
      "sentry.segment.id": "c".repeat(16), "sentry.op": "http.client",
    },
    links: [{ trace_id: "d".repeat(32), span_id: "e".repeat(16), attributes: { secret: "home" } }],
  });
  assert.equal(span.trace_id, "a".repeat(32));
  assert.equal(span.parent_span_id, "c".repeat(16));
  assert.equal(span.name, "GET https://api.codeplug.org/repeaterbook");
  assert.equal(span.attributes["sentry.segment.id"], "c".repeat(16));
  assert.equal(span.attributes["sentry.segment.name"], undefined);
  assert.doesNotMatch(JSON.stringify(span), /M0ABC|51\.5074|private|home|person@example/);
  const root = scrubTraceSpan({ ...span, is_segment: true });
  assert.equal(root.attributes["sentry.segment.name"], root.name);
  for (const url of ["invalid", "https://api.codeplug.org/lookup/M0ABC", "https://other.example/repeaterbook"]) {
    assert.equal(scrubTraceSpan({ attributes: { "sentry.op": "http.client", url } }).name, "[url]");
  }
  const unsupported = scrubTraceSpan({ name: "private user action", attributes: { "sentry.op": "ui.action" } });
  assert.equal(unsupported.attributes["url.full"], undefined);
  assert.doesNotMatch(unsupported.name, /private/);
});

test("public SDK fetch instrumentation is verified in an isolated subprocess", () => {
  const fetchBefore = globalThis.fetch;
  const consoleBefore = console.log;
  const result = execFileSync(process.execPath, [fileURLToPath(new URL("../support/sentry-tracing-sdk.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 15000,
  });
  assert.match(result, /SDK tracing checks passed/);
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(console.log, consoleBefore);
});

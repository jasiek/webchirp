import test from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/browser";
import { instrumentFetchRequest } from "@sentry/core/browser";
import { createTracingOptions, scrubTraceSpan } from "../../web/js/sentry-tracing.js";
import { fakeSentryTracing } from "../support/fake-sentry-tracing.mjs";

test("trace headers and request spans are restricted to the first-party HTTPS API", () => {
  let integrationOptions;
  const options = createTracingOptions({
    ...fakeSentryTracing,
    browserTracingIntegration(value) { integrationOptions = value; return { name: "BrowserTracing" }; },
  });
  for (const [url, expected] of [
    ["https://api.codeplug.org/cities?q=London", true],
    ["https://api.codeplug.org:443/lookup/M0ABC", true],
    ["https://api.codeplug.org", true],
    ["https://api.codeplug.org.evil.example/cities", false],
    ["https://api.codeplug.org@evil.example/cities", false],
    ["https://evil.example/?next=https://api.codeplug.org/cities", false],
    ["http://api.codeplug.org/cities", false],
    ["https://api.codeplug.org:8443/cities", false],
    ["https://cdn.jsdelivr.net/npm/pyodide", false],
    ["https://api-beta.rsgb.online/locator/IO82MM", false],
    ["https://codeplug.org/version.json", false],
    ["./version.json", false],
  ]) {
    assert.equal(options.tracePropagationTargets.some((target) => target.test(url)), expected, url);
    assert.equal(integrationOptions.shouldCreateSpanForRequest(url), expected, url);
  }
  assert.equal(integrationOptions.instrumentPageLoad, false);
  assert.equal(integrationOptions.instrumentNavigation, false);
});

test("span privacy removes lookup paths, queries, referrers and inherited user attributes", () => {
  const span = scrubTraceSpan({
    trace_id: "a".repeat(32), span_id: "b".repeat(16), parent_span_id: "c".repeat(16),
    name: "GET https://api.codeplug.org/lookup/M0ABC?latitude=51.5074#private",
    attributes: {
      "url.full": "https://api.codeplug.org/lookup/M0ABC?latitude=51.5074#private",
      "http.method": "GET", "http.response.status_code": 200,
      "http.query": "?latitude=51.5074", "http.fragment": "private",
      "http.request.header.referer": "https://codeplug.org/?q=home",
      "user.email": "person@example.org", "sentry.segment.name": "M0ABC",
      "sentry.op": "http.client", "sentry.release": "webchirp@123abc",
    },
    links: [{ trace_id: "d".repeat(32), span_id: "e".repeat(16), attributes: { secret: "home" } }],
  });
  assert.equal(span.trace_id, "a".repeat(32));
  assert.equal(span.parent_span_id, "c".repeat(16));
  assert.equal(span.name, "GET https://api.codeplug.org/lookup/[callsign]");
  assert.equal(span.attributes["http.response.status_code"], 200);
  assert.equal(span.attributes["sentry.release"], "webchirp@123abc");
  assert.doesNotMatch(JSON.stringify(span), /M0ABC|51\.5074|private|home|person@example/);
  for (const route of ["/cities", "/repeaterbook/meta", "/przemienniki", "/irts/meta"]) {
    assert.equal(scrubTraceSpan({ attributes: { url: "https://api.codeplug.org" + route + "?q=secret" } }).name,
      "https://api.codeplug.org" + route);
  }
  assert.equal(scrubTraceSpan({ attributes: { url: "https://api.codeplug.org/new/private" } }).name,
    "https://api.codeplug.org/[path]");
});

test("the real SDK links a parentless API fetch to its emitted span without leaking baggage data", async () => {
  const envelopes = [];
  const options = createTracingOptions(Sentry);
  const client = Sentry.init({
    ...options,
    dsn: "https://public@example.com/1", sendDefaultPii: false,
    enableMetrics: false, enableLogs: false, autoSessionTracking: false,
    transport: () => ({
      send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); },
      flush: () => Promise.resolve(true),
    }),
  });
  try {
    const url = "https://api.codeplug.org/lookup/M0ABC?q=London&lat=51.5074";
    const data = {
      args: [url, { headers: { Accept: "application/json" } }],
      fetchData: { method: "GET", url }, startTimestamp: Date.now(),
    };
    const spans = {};
    const target = (value) => options.tracePropagationTargets.some((pattern) => pattern.test(value));
    const span = instrumentFetchRequest(data, target, target, spans);
    const headers = new Headers(data.args[1].headers);
    const context = span.spanContext();
    assert.equal(headers.get("sentry-trace"), context.traceId + "-" + context.spanId + "-1");
    assert.equal(headers.get("Accept"), "application/json");
    assert.match(headers.get("baggage"), /sentry-trace_id=/);
    assert.doesNotMatch(decodeURIComponent(headers.get("baggage")), /M0ABC|London|51\.5074/);
    instrumentFetchRequest({ ...data, endTimestamp: Date.now(), response: new Response("{}") }, target, target, spans);
    await client.flush();
    const emitted = envelopes.flatMap(([, items]) => items)
      .filter(([header]) => header.type === "span")
      .flatMap(([, payload]) => payload.items);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].trace_id, context.traceId);
    assert.equal(emitted[0].span_id, context.spanId);
    assert.doesNotMatch(JSON.stringify(envelopes), /M0ABC|London|51\.5074/);
  } finally {
    await client.close();
    Sentry.getCurrentScope().setClient(undefined);
  }
});

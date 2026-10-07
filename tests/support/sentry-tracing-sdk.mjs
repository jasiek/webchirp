// Run only in a child process: closing a Sentry client does not undo its global
// instrumentation. Exercise the declared browser SDK through its public API.
import assert from "node:assert/strict";
import { createTracingOptions } from "../../web/js/sentry-tracing.js";

const requests = [];
globalThis.location = { href: "https://codeplug.org/", origin: "https://codeplug.org" };
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  requests.push(request);
  return new Response("{}", { status: request.url.includes("fail=1") ? 500 : 200 });
};
const Sentry = await import("@sentry/browser");
const envelopes = [];
const client = Sentry.init({
  ...createTracingOptions(Sentry),
  dsn: "https://public@example.com/1", sendDefaultPii: false,
  enableMetrics: false, enableLogs: false, autoSessionTracking: false,
  transport: () => ({
    send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); },
    flush: () => Promise.resolve(true),
  }),
});
try {
  // Choose a sampled trace deterministically while keeping the production rate.
  const scope = Sentry.getCurrentScope();
  scope.setPropagationContext({ ...scope.getPropagationContext(), sampleRand: 0 });
  await fetch("https://api.codeplug.org/repeaterbook?q=London&lat=51.5074", { headers: { Accept: "application/json" } });
  await fetch(new Request("https://api.codeplug.org/irts?fail=1", { headers: { Accept: "application/json" } }));
  for (const url of ["https://api.codeplug.org/cities?q=London", "https://api.codeplug.org/lookup/M0ABC", "https://other.example/repeaterbook"]) {
    await fetch(url);
    assert.equal(requests.at(-1).headers.has("sentry-trace"), false);
    assert.equal(requests.at(-1).headers.has("baggage"), false);
  }
  Sentry.startSpan({ name: "private user action", op: "ui.action" }, () => {});
  Sentry.startSpan({ name: "private unnamed operation" }, () => {});
  await Sentry.startSpan({ name: "parent?q=secret", attributes: {
    "sentry.op": "http.client", "url.full": "https://api.codeplug.org/przemienniki?q=secret",
  } }, async () => {
    await fetch("https://api.codeplug.org/przemienniki/meta");
    Sentry.startSpan({ name: "private child operation" }, () => {});
  });
  await client.flush();
  const emitted = envelopes.flatMap(([, items]) => items)
    .filter(([header]) => header.type === "span").flatMap(([, payload]) => payload.items);
  assert.equal(emitted.length, 4);
  const tracedRequests = requests.filter((request) => request.headers.has("sentry-trace"));
  assert.equal(tracedRequests.length, 3);
  for (const request of tracedRequests) {
    assert.ok(emitted.some((span) => request.headers.get("sentry-trace") === span.trace_id + "-" + span.span_id + "-1"));
    assert.match(request.headers.get("baggage"), /sentry-trace_id=/);
    assert.doesNotMatch(decodeURIComponent(request.headers.get("baggage")), /M0ABC|London|51\.5074|secret/);
  }
  assert.equal(requests[0].headers.get("Accept"), "application/json");
  assert.equal(requests[1].headers.get("Accept"), "application/json");
  assert.ok(emitted.some((span) => span.status === "error"));
  const child = emitted.find((span) => !span.is_segment);
  assert.ok(child);
  assert.equal(child.attributes["sentry.segment.name"], undefined);
  assert.ok(emitted.some((span) => span.span_id === child.parent_span_id && span.is_segment));
  assert.doesNotMatch(JSON.stringify(envelopes), /M0ABC|London|51\.5074|secret|private/);
  console.log("SDK tracing checks passed");
} finally {
  await client.close();
}

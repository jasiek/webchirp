// API tracing stays separate from error reporting so its own telemetry pipeline
// has an explicit privacy boundary. No SDK is imported before the host gate.
const API_TARGET = /^https:\/\/api\.codeplug\.org(?::443)?(?:\/|$)/;
const API_PATH = /^\/(?:cities|(?:irts|przemienniki|repeaterbook)(?:\/meta)?)\/?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const TRACE_ATTRIBUTES = new Set([
  "http.response.status_code", "http.status_code",
  "sentry.op", "sentry.origin", "sentry.source", "sentry.sample_rate",
  "sentry.segment.id", "sentry.trace_lifecycle", "sentry.environment", "sentry.release",
  "sentry.sdk.name", "sentry.sdk.version", "sentry.sdk.integrations",
]);

// Keep only known route shapes: query strings and lookup callsigns are user data.
function traceUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://api.codeplug.org") return "[url]";
    const route = url.pathname.startsWith("/lookup/")
      ? "/lookup/[callsign]"
      : API_PATH.test(url.pathname) ? url.pathname : "/[path]";
    return url.origin + route;
  } catch {
    return "[url]";
  }
}

// Streamed spans bypass beforeSend. Rebuild attributes after SDK enrichment so
// raw URLs, query/fragment attributes, referrers and scope user data cannot leak.
export function scrubTraceSpan(span) {
  const original = span.attributes || {};
  const url = traceUrl(original["url.full"] || original["http.url"] || original.url);
  const method = original["http.request.method"] || original["http.method"];
  span.name = (METHODS.has(method) ? method + " " : "") + url;
  span.attributes = Object.fromEntries(
    Object.entries(original).filter(([key]) => TRACE_ATTRIBUTES.has(key)),
  );
  span.attributes["url.full"] = url;
  span.attributes["sentry.segment.name"] = span.name;
  if (METHODS.has(method)) span.attributes["http.request.method"] = method;
  // No span-link attributes are needed to join frontend and backend trace IDs.
  if (span.links) {
    span.links = span.links.map(({ trace_id, span_id, sampled }) => ({ trace_id, span_id, sampled }));
  }
  return span;
}

// Use the SDK's request instrumentation and header propagation. Streaming lets
// API requests produce spans even long after the page-load transaction ended.
export function createTracingOptions(sdk) {
  return {
    tracesSampleRate: 1,
    traceLifecycle: "stream",
    tracePropagationTargets: [API_TARGET],
    integrations: [{
      name: "ApiTracePrivacy",
      // Baggage is built before beforeSendSpan, and its transaction name can
      // contain a lookup callsign. Omit it from both headers and envelopes.
      setup(client) {
        client.on("createDsc", (context) => { delete context.transaction; });
      },
    }, sdk.spanStreamingIntegration(), sdk.browserTracingIntegration({
      instrumentPageLoad: false,
      instrumentNavigation: false,
      enableLongTask: false,
      enableLongAnimationFrame: false,
      enableInp: false,
      enableHTTPTimings: false,
      shouldCreateSpanForRequest: (url) => API_TARGET.test(url),
    })],
    beforeSendSpan: sdk.withStreamedSpan(scrubTraceSpan),
  };
}

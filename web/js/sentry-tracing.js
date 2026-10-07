// API tracing has its own telemetry pipeline and privacy boundary. No SDK is
// imported before the production host gate in web/js/sentry.js.
import { buildRepeaterEndpoints, DEFAULT_REPEATER_API_BASE } from "./datasources.js";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const TRACE_ATTRIBUTES = new Set([
  "http.response.status_code", "http.status_code",
  "sentry.op", "sentry.origin", "sentry.source", "sentry.sample_rate",
  "sentry.segment.id", "sentry.trace_lifecycle", "sentry.environment", "sentry.release",
  "sentry.sdk.name", "sentry.sdk.version", "sentry.sdk.integrations",
]);

// Match only directory endpoints from the deployment-owned API configuration.
// Cities and callsign hovers stay simple GETs, without tracing preflights or spans.
function traceTargets(apiBase) {
  const endpoints = buildRepeaterEndpoints(apiBase);
  return [endpoints.przemienniki, endpoints.repeaterbook, endpoints.irts]
    .filter(Boolean)
    .flatMap(({ apiUrl, metaUrl }) => [apiUrl, metaUrl])
    .flatMap((endpoint) => {
      try {
        const url = new URL(endpoint);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return [];
        const canonical = url.origin + url.pathname;
        const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return [{ canonical, pattern: new RegExp("^" + escaped + "(?:[?#]|$)") }];
      } catch {
        return [];
      }
    });
}

// Replace request URLs with an exact configured endpoint, dropping user query
// values and refusing unknown paths rather than guessing which parts are safe.
function traceUrl(value, targets) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return "[url]";
    const canonical = url.origin + url.pathname;
    return targets.find((target) => target.canonical === canonical)?.canonical || "[url]";
  } catch {
    return "[url]";
  }
}

// Streamed spans bypass beforeSend. Rebuild attributes after SDK enrichment;
// retain parent IDs, but never replace an inherited segment name with a child name.
export function scrubTraceSpan(span, targets = traceTargets(DEFAULT_REPEATER_API_BASE)) {
  const original = span.attributes || {};
  span.attributes = Object.fromEntries(
    Object.entries(original).filter(([key]) => TRACE_ATTRIBUTES.has(key)),
  );
  if (original["sentry.op"] === "http.client") {
    const url = traceUrl(original["url.full"] || original["http.url"] || original.url, targets);
    const method = original["http.request.method"] || original["http.method"];
    span.name = (METHODS.has(method) ? method + " " : "") + url;
    span.attributes["url.full"] = url;
    if (METHODS.has(method)) span.attributes["http.request.method"] = method;
  } else {
    // ignoreSpans excludes these before creation. Fail closed if a future SDK
    // still delivers one, without falsely labelling it as an HTTP request.
    span.name = "[unsupported operation]";
  }
  if (span.is_segment) span.attributes["sentry.segment.name"] = span.name;
  // No span-link attributes are needed to join frontend and backend trace IDs.
  if (span.links) {
    span.links = span.links.map(({ trace_id, span_id, sampled }) => ({ trace_id, span_id, sampled }));
  }
  return span;
}

// Streaming records directory requests made after page load. Sample 10% of traces
// and suppress unsupported span types before they reach the HTTP-only sanitizer.
export function createTracingOptions(sdk, apiBase = DEFAULT_REPEATER_API_BASE) {
  const targets = traceTargets(apiBase);
  return {
    tracesSampleRate: 0.1,
    traceLifecycle: "stream",
    tracePropagationTargets: targets.map(({ pattern }) => pattern),
    ignoreSpans: [
      { op: /^(?!http\.client$)/ },
      // Automatic HTTP instrumentation supplies this attribute. Untyped and
      // manually created spans need their own policy before we support them.
      { attributes: { "sentry.op": undefined } },
    ],
    integrations: [{
      name: "ApiTracePrivacy",
      // Baggage is built before beforeSendSpan; omit unsanitized transaction
      // names from both outgoing headers and envelope headers.
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
      shouldCreateSpanForRequest: (url) => traceUrl(url, targets) !== "[url]",
    })],
    beforeSendSpan: sdk.withStreamedSpan((span) => scrubTraceSpan(span, targets)),
  };
}

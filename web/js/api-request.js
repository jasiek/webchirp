import { traceApiRequest } from "./sentry.js";

// Run every directory, city and callsign exchange through one body-aware path.
// The consumer owns HTTP validation and reading the body; telemetry ends only
// after that work settles. Injected fetches use the same path in headless tests.
export function apiRequest(input, init, consume, fetchImpl = (...args) => globalThis.fetch(...args)) {
  return traceApiRequest(input, async (traceHeaders) => {
    let options = init;
    try {
      if (Object.keys(traceHeaders).length) {
        const headers = new Headers(init?.headers ?? input?.headers);
        for (const [name, value] of Object.entries(traceHeaders)) {
          headers.set(name, value);
        }
        options = { ...init, headers };
      }
    } catch {
      // Malformed telemetry must not affect the request's original options.
    }
    const response = await fetchImpl(input, options);
    return consume(response);
  });
}

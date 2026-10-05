// Delivery diagnostics only: never collect cookies or arbitrary response headers.
const DELIVERY_HEADERS = Object.freeze([
  "server", "via", "x-served-by", "x-cache", "x-cache-hits",
  "cf-ray", "cf-cache-status", "x-fastly-request-id",
  "x-github-request-id", "x-github-edge-region", "x-proxy-cache",
  "x-cdn", "x-via", "cdn-pullzone", "x-gcore-id",
]);

// Observe readable static-asset responses without consuming bodies or changing
// errors. The caller owns the production gate and the Sentry breadcrumb buffer.
export function installCdnResponseBreadcrumbs(win, record) {
  const originalFetch = win.fetch;
  if (typeof originalFetch !== "function") return () => {};
  const origin = win.location.origin || `https://${win.location.hostname}`;
  // Keep diagnostics out of the fetch result path: malformed input, inaccessible
  // headers or a broken telemetry callback must not break an application request.
  function observe(input, response) {
    try {
      const url = new URL(typeof input === "string" ? input : input.url || String(input), origin);
      const localAsset = url.origin === origin && (
        /^\/(?:python|chirp|extra_drivers|js)\//.test(url.pathname)
        || /^\/(?:radio-catalog(?:-quansheng-unofficial)?|version)\.json$/.test(url.pathname)
      );
      const cdnAsset = url.origin === "https://cdn.jsdelivr.net";
      if (!localAsset && !cdnAsset) return;
      const headers = {};
      for (const name of DELIVERY_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value.slice(0, 512);
      }
      record({
        category: "http.cdn",
        type: "http",
        level: "info",
        timestamp: Date.now() / 1000,
        data: { url: url.origin + url.pathname, status_code: response.status, ...headers },
      });
    } catch {
      // Observability is best effort, including CORS-filtered headers.
    }
  }
  // Wrap the existing fetch (including Sentry instrumentation, if installed)
  // and preserve its receiver, arguments, response object and rejection reason.
  function observedFetch(...args) {
    return originalFetch.apply(this, args).then((response) => {
      observe(args[0], response);
      return response;
    });
  }
  win.fetch = observedFetch;
  // Do not remove a wrapper another library installed after ours.
  return () => { if (win.fetch === observedFetch) win.fetch = originalFetch; };
}

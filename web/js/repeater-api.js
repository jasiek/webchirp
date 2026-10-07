// Base URL of the API that fronts przemienniki.net, repeaterbook.com and IRTS.
// The first two upstreams don't send browser CORS headers, so their query
// features depend on a proxy that adds them. api.codeplug.org restricts its
// CORS allowlist to this app's own production origins -- https://codeplug.org
// and https://webchirp.org, exact-match and https-only -- so forks hosted
// elsewhere can point
// this at their own proxy or leave it blank to disable those two sources. IRTS
// remains available through the default API when the override is blank.
// Overridable per-deployment via a <meta name="webchirp-repeater-api-base">
// tag (see index.html and buildRepeaterEndpoints).
export const DEFAULT_REPEATER_API_BASE = "https://api.codeplug.org";

const REPEATER_API_BASE_META = "webchirp-repeater-api-base";

// Resolve the repeater API base for this deployment. A
// <meta name="webchirp-repeater-api-base"> tag overrides the built-in default:
// its content (a proxy base URL, or blank to disable the online-query
// features) wins when the tag is present; without the tag the default applies.
// Shared rather than owned by the query modal, because the hover map reads the
// same deployment setting and the two must not disagree about it.
export function resolveRepeaterApiBase() {
  const meta = document.querySelector(`meta[name="${REPEATER_API_BASE_META}"]`);
  if (meta) {
    return String(meta.getAttribute("content") || "").trim();
  }
  return DEFAULT_REPEATER_API_BASE;
}


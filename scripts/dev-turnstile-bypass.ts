// npm run dev against the production API: RepeaterBook queries need a
// Turnstile token, and the dev page builds in no site key, so the API's
// TURNSTILE_BYPASS_TOKEN stands in for one. scripts/dev-server.ts reads it from
// the same environment variable the API does and writes it into each page's
// <meta name="webchirp-turnstile-bypass-token"> as it serves it; the page sends
// it as "Authorization: Bearer <token>" (web/js/turnstile.ts). Nothing else
// fills that tag, so dist/ always ships it blank.

export const TURNSTILE_BYPASS_TOKEN_META = "webchirp-turnstile-bypass-token";

// The API refuses to start with a token of any other length.
const TOKEN_LENGTH = 32;
// RFC 6750's b64token, the characters a Bearer credential may hold. None of
// them needs escaping in an HTML attribute.
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

const BLANK_META = new RegExp(`<meta name="${TURNSTILE_BYPASS_TOKEN_META}" content="" />`);

// The token from env, or "" when it is unset. One the API would refuse, or
// that would not survive as a Bearer credential, fails here rather than as a
// 403 on the first query.
export function readTurnstileBypassToken(env: NodeJS.ProcessEnv): string {
  const token = (env.TURNSTILE_BYPASS_TOKEN || "").trim();
  if (!token) {
    return "";
  }
  if (token.length !== TOKEN_LENGTH) {
    throw new Error(`TURNSTILE_BYPASS_TOKEN must be ${TOKEN_LENGTH} characters, got ${token.length}`);
  }
  if (!BEARER_TOKEN.test(token)) {
    throw new Error("TURNSTILE_BYPASS_TOKEN is not a Bearer token");
  }
  return token;
}

// html with its blank bypass-token tag filled in; a page without the tag is
// returned unchanged.
export function fillTurnstileBypassToken(html: string, token: string): string {
  return html.replace(BLANK_META, `<meta name="${TURNSTILE_BYPASS_TOKEN_META}" content="${token}" />`);
}

// npm run dev against the production API: RepeaterBook queries need a
// Turnstile token, and the dev page builds in no site key, so the API's
// TURNSTILE_BYPASS_TOKEN stands in for one -- without ever reaching the page.
// With the token set, scripts/dev-server.ts serves pages whose
// <meta name="webchirp-repeater-api-base"> names its own DEV_API_PROXY_PATH
// instead of the API, and forwards every request there to the API, adding
// "Authorization: Bearer <token>" to RepeaterBook's. The page behaves as a
// build with no site key does -- no widget, no token header -- so nothing the
// page runs can read the token, and dist/ has nothing to leave out. Without the
// token the page talks to the API directly, as the deployed site does.

import type { IncomingMessage, ServerResponse } from "node:http";

export const DEV_API_PROXY_PATH = "/dev-api";

// The API refuses to start with a token of any other length.
const TOKEN_LENGTH = 32;
// RFC 6750's b64token, the characters a Bearer credential may hold.
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

const API_BASE_META = /<meta name="webchirp-repeater-api-base" content="([^"]*)" \/>/;

// The API routes whose requests carry the token: only RepeaterBook's asks.
const BEARER_ROUTE = /^\/repeaterbook(\/|\?|$)/;

// The response headers passed back to the page. The body is re-sent decoded,
// so the API's own encoding and length do not apply to it.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"];

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

// The API base html names, or "" when it has no such tag.
export function readApiBase(html: string): string {
  return html.match(API_BASE_META)?.[1]?.trim() || "";
}

// html with its API base pointed at the proxy on origin (http://host:port); a
// page without the tag is returned unchanged.
export function pointApiBaseAtProxy(html: string, origin: string): string {
  return html.replace(
    API_BASE_META,
    `<meta name="webchirp-repeater-api-base" content="${origin}${DEV_API_PROXY_PATH}" />`,
  );
}

// The API route a request for requestUrl asks for -- its path and query below
// the proxy, such as "/repeaterbook?country=gb" -- or null when requestUrl is
// not under the proxy.
export function proxiedApiRoute(requestUrl: string): string | null {
  const route = requestUrl.startsWith(DEV_API_PROXY_PATH) ? requestUrl.slice(DEV_API_PROXY_PATH.length) : null;
  return route !== null && /^(\/|\?|$)/.test(route) ? route : null;
}

// Forwards req for route to the API at apiBase and answers res with the API's
// status, headers and body, adding the token to a RepeaterBook request. The
// route is matched as the page asked for it, so an API mounted below a path
// (https://proxy.example/api) gets the token too. An API that cannot be
// reached answers 502, as a gateway would.
export async function forwardApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  route: string,
  token: string,
): Promise<void> {
  const target = `${apiBase.replace(/\/+$/, "")}${route}`;
  const headers: Record<string, string> = {};
  const accept = req.headers.accept;
  if (accept) {
    headers.accept = accept;
  }
  if (BEARER_ROUTE.test(route)) {
    headers.authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(target, { method: req.method, headers });
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`The dev server could not reach ${new URL(target).origin}: ${String(error)}`);
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.statusCode = response.status;
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
  res.setHeader("Content-Length", body.length);
  res.end(req.method === "HEAD" ? undefined : body);
}

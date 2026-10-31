// HTTP status failures, named so reporting can tell a host outage from a
// missing file without reading the sentence.
//
// GitHub Pages, which served the app when this was written, answered a 502 or
// 503 now and then for a file that was there a moment later; whether Cloudflare
// Pages, which serves it now, does the same is not known, and the rule is the
// same either way. fetchOk() (web/js/python-sources.ts)
// used to throw a plain Error for every status, and the runtime bootstrap
// reported each one as a crash -- a host hiccup filed as a bug, once per
// visitor who hit it. A 404 is different: it is the deploy answering that a
// file is not there, which is a bug in the deploy and stays reported.
//
// Dependency-free on purpose, like web/js/serial-errors.ts: web/js/sentry.ts
// imports it to recognize the failure, and the service worker imports it to
// decide when to fall back to its cached copy.

// The name an outage status carries, recognized by isIgnoredError
// (web/js/sentry.ts).
export const SERVER_OUTAGE = "ServerOutageError";

// Whether an HTTP status says the server could not answer just now (a 5xx,
// a request timeout, rate limiting) rather than giving an answer.
export function isServerOutageStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// The error a fetch helper throws for a response that is not ok. An outage
// status gets SERVER_OUTAGE as its name; any other keeps the plain Error name,
// so it is reported as before. The message is unchanged either way, because
// the debug panel prints it.
export function createHttpStatusError(url: string, status: number): Error {
  const error = new Error(`Failed to fetch ${url}: ${status}`);
  if (isServerOutageStatus(status)) {
    error.name = SERVER_OUTAGE;
  }
  return error;
}

// Recognize a host outage by the name createHttpStatusError gave it.
export function isServerOutage(error: unknown): boolean {
  return error instanceof Error && error.name === SERVER_OUTAGE;
}

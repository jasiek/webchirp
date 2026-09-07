// A bounded deadline for the online repeater-directory requests.
//
// Every one of them leaves the browser for a host this app does not control: a
// CORS proxy for przemienniki.net and RepeaterBook, api.codeplug.org for IRTS,
// api-beta.rsgb.online for RSGB/ETCC. A host that accepts the connection and
// then never answers is the failure mode fetch() handles worst — the promise
// neither resolves nor rejects until the browser's own network timeout fires,
// which for a stalled connection is around 300 s in Chrome. For that whole time
// the query modal sits disabled reading "Querying...", with nothing in the
// debug panel, and a slow directory is indistinguishable from a dead one.

// One deadline for every directory request, deliberately in a single place so
// the sources cannot drift apart. Long enough for a cold proxy to answer, short
// enough that a hung host reads as an ordinary error rather than a five-minute
// stall — and short enough to stay inside the user's patience, since the modal
// is unusable while a query is in flight.
export const REPEATER_REQUEST_TIMEOUT_MS = 10000;

// Render the deadline the way the user should read it. Seconds are the natural
// unit for the shipped value; the millisecond form only shows up when a test or
// a caller passes a sub-second deadline, where "0 s" would be a lie.
function describeDeadline(timeoutMs) {
  return timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
}

// Run one directory request under a deadline and turn the abort into an error a
// user can read. `run` is given an AbortSignal to hand to fetch(), and must also
// read the response body inside the callback: fetch() resolves as soon as the
// response *headers* arrive, so a host that answers 200 and then stalls mid-body
// is only bounded if the read happens inside this window too.
//
// The deadline is enforced with an AbortSignal rather than a Promise.race
// because a race leaves the underlying connection open and still streaming. A
// signal is also the one mechanism that adds nothing to the request — it is not
// a header, so a simple CORS request stays simple and the OPTIONS preflight that
// api-beta.rsgb.online answers with 405 is never provoked (see web/js/rsgb.js).
//
// AbortSignal.timeout() would express the deadline in one line, and its
// TimeoutError reason would attribute the abort just as well as signal.aborted
// does here. It is not used for one reason: its timer is internal to the
// platform, so no test can move it. Node's t.mock.timers (and every equivalent
// in a browser test runner) can only intercept a global setTimeout, so a
// deadline built on AbortSignal.timeout() can be tested only by really waiting
// out the real duration — which means the shipped value is untestable and the
// tests would have to assert some short value the production code never uses.
// Building the deadline out of setTimeout + AbortController costs four lines
// and lets test-ui-repeater-modal.mjs drive the real REPEATER_REQUEST_TIMEOUT_MS
// over a mocked clock. It also keeps the module working on Chrome 89-102, which
// has Web Serial but not AbortSignal.timeout (Chrome 103).
//
// signal.aborted is true only when this deadline fired, so the caller's own
// failures keep their own messages while a genuine timeout gets a sentence
// naming what stalled. That sentence says "timed out" on purpose —
// classifyErrorKind() in web/js/ui/analytics.js matches it to report the failure
// as a timeout rather than "other".
export async function withRequestTimeout(label, run, timeoutMs = REPEATER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${describeDeadline(timeoutMs)}: the server accepted the request but never answered.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

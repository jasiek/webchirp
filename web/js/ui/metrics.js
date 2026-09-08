// The UI's side of Sentry metrics: the vocabulary of user flows, and the one
// entry point every feature module records through.
//
// This module is to web/js/sentry.js what web/js/ui/analytics.js is to
// web/js/analytics.js. The generic module owns the production-host gate, the
// pre-load buffer and the attribute allowlist; this one owns what the app
// actually has to say. Feature modules import recordFlow() and nothing else, so
// none of them has to know whether reporting is switched on.
//
// Two metrics carry all of it, rather than one metric per flow:
//
//   flow.completed -- a counter, one per flow that reached an end
//   flow.duration  -- a distribution in milliseconds, recorded only where the
//                     duration is ours to answer for
//
// Both are dimensioned by flow and outcome instead of baking either into the
// metric name, which is what makes each of the two questions this exists to
// answer a single query: group flow.completed by flow to see which flows are
// breaking, then filter to one flow and group by radio to see which radios fail
// inside it. Separate per-flow metrics would need a union to answer either, and
// would not compare across flows at all.
//
// These metrics do not replace the GA events at the same call sites. GA answers
// how the app is used; this answers what share of attempts fail, on which
// driver, and is the half worth alerting on.

import { captureMetric } from "../sentry.js";

// Every flow that reports an outcome, as a closed set. A typo at a call site
// then costs one missing metric rather than quietly opening a second series in
// Sentry that looks like real data -- the same failure CUSTOM_DIMENSIONS guards
// against on the GA side, where an undeclared parameter is collected and shown
// nowhere.
export const FLOWS = Object.freeze({
  APP_START: "app_start",
  SERIAL_CONNECT: "serial_connect",
  RADIO_DOWNLOAD: "radio_download",
  RADIO_UPLOAD: "radio_upload",
  CODEPLUG_IMPORT: "codeplug_import",
  REPEATER_QUERY: "repeater_query",
  RUNTIME: "runtime",
});

// How a flow ended. "blocked" is deliberately not "failed": an upload stopped
// by preflight validation is the app doing its job, and counting it as a
// failure would bury the transfers that genuinely broke under the codeplugs
// CHIRP correctly refused. "crashed" is the runtime dying underneath whatever
// was in flight, which belongs to no single flow.
export const OUTCOMES = Object.freeze({
  OK: "ok",
  FAILED: "failed",
  BLOCKED: "blocked",
  CRASHED: "crashed",
});

const FLOW_NAMES = new Set(Object.values(FLOWS));

// Record how one flow ended. durationMs is optional: pass it for the flows this
// app is answerable for -- a clone, a runtime boot -- and omit it where the
// number would measure the user's disk or the user's own hesitation instead.
//
// Attributes are filtered against the allowlist in web/js/sentry.js, so a
// caller may pass the same parameter bag it hands trackEvent(): the values that
// are not dimensions (a raw channel count, a duration) are dropped there rather
// than having to be stripped at every call site.
export function recordFlow(flow, outcome, attributes = {}, durationMs) {
  if (!FLOW_NAMES.has(flow)) {
    return;
  }
  const dimensions = { flow, outcome, ...attributes };
  captureMetric("flow.completed", { type: "count", value: 1, attributes: dimensions });
  if (Number.isFinite(durationMs)) {
    captureMetric("flow.duration", {
      type: "distribution",
      value: durationMs,
      unit: "millisecond",
      attributes: dimensions,
    });
  }
}

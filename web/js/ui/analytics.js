// The UI's side of analytics: the parameters every event site builds, and the
// one import path the UI modules reach gtag through.
//
// trackEvent lives in web/js/analytics.js, which the two pages load directly —
// it owns the production-host gate, the vendor tag and the launch context, and
// is inert wherever gtag is absent (off-domain, behind a blocker, in the
// headless tests). It is re-exported here so a UI module never has to know
// which side of that line it is on.
//
// Two rules govern what may be sent:
//   - No user data. Never a file name, a channel name or comment, a frequency,
//     a search term or a coordinate. Every value below is a CHIRP driver
//     identifier, a fixed enum, or a bucketed count.
//   - Bounded cardinality. GA4 drops high-cardinality parameters, so free-form
//     text — error messages above all — is mapped onto a small fixed vocabulary
//     before it is sent, rather than reported verbatim. Anything sent also has
//     to be declared in CUSTOM_DIMENSIONS, or GA collects it and shows it
//     nowhere; scripts/test-ga-dimensions.mjs fails the build if it is not.

import { errorDetails } from "./format.js";

export { trackEvent } from "../analytics.js";

// The driver identity every radio-scoped event carries. Vendor/model answer
// "which radios do people own", module/class answer "which CHIRP driver ran",
// and the two differ often enough (one driver serves many models) to be worth
// sending both.
export function radioEventParams(radio) {
  if (!radio) {
    return {};
  }
  return {
    radio_make: String(radio.vendor || ""),
    radio_model: String(radio.model || ""),
    radio_module: String(radio.module || ""),
    radio_class: String(radio.className || ""),
  };
}

// Codeplug sizes as a handful of ranges. A raw count is a metric GA4 can only
// average; a bucket is a dimension every report can group by, which is what
// answers "how big are the codeplugs people actually work with" — and so which
// sizes the channel grid has to stay usable at.
export function channelCountBucket(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0) {
    return "unknown";
  }
  if (n === 0) {
    return "0";
  }
  if (n <= 16) {
    return "1-16";
  }
  if (n <= 128) {
    return "17-128";
  }
  if (n <= 512) {
    return "129-512";
  }
  return "512+";
}

// Scale and provenance of whatever is currently in the editor. Provenance is
// the part that is not derivable from anything else: it says whether the
// codeplug someone is about to write to a radio came off that radio, out of a
// file, or from the sample.
export function codeplugParams(state) {
  const count = Array.isArray(state?.currentRows) ? state.currentRows.length : 0;
  return {
    channel_count: count,
    channel_count_bucket: channelCountBucket(count),
    codeplug_source: state?.codeplugSource || "unknown",
  };
}

// Failure causes worth telling apart in reporting, matched against the whole
// error detail rather than its first line: a Pyodide failure arrives as a
// Python traceback whose first line is always "Traceback (most recent call
// last):" and whose cause is on the last. First match wins, so the specific
// patterns come before the general ones.
const ERROR_KINDS = [
  ["port_not_selected", /no port selected|no device selected|notfounderror/i],
  ["permission_denied", /notallowederror|securityerror|permission denied|access denied/i],
  ["serial_disconnect", /device has been lost|device lost|port is (?:closed|already open)|networkerror/i],
  ["no_response", /did not respond|not responding|no response|no data received/i],
  ["timeout", /timed out|timeout/i],
  ["ident_mismatch", /\bident\b|magic|incorrect model|wrong radio|model mismatch/i],
  ["checksum", /checksum|\bcrc\b/i],
  ["driver_unsupported", /unsupported|not supported/i],
  ["runtime_unavailable", /runtime api client is not initialized|loadpyodide|\bwasm\b/i],
];

export function classifyErrorKind(error) {
  const detail = errorDetails(error);
  for (const [kind, pattern] of ERROR_KINDS) {
    if (pattern.test(detail)) {
      return kind;
    }
  }
  return "other";
}

// The exception type behind a failure. Type names are a naturally bounded
// vocabulary, so sending one keeps the granularity that error_kind's fixed list
// throws away — an unrecognized failure still reports as, say, RadioError
// rather than collapsing into "other" with nothing to go on.
//
// Scans from the end because a Python traceback names its exception on the last
// line, while a JS error names it on the first and is followed by stack frames.
export function errorTypeName(error) {
  const lines = errorDetails(error)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // "chirp.errors.RadioError: Radio did not respond" -> RadioError.
    const name = lines[i].match(/^([\w.]+)\s*:/)?.[1]?.split(".").pop();
    if (name && /(?:Error|Exception)$/.test(name)) {
      return name;
    }
  }
  return "";
}

// The column of the first preflight issue, for reporting which fields block
// uploads most often. Column names come from CHIRP's own schema, so they are a
// bounded set; the rejected value itself is never sent.
export function firstIssueColumn(issues) {
  for (const issue of issues || []) {
    const column = String(issue?.column || "");
    if (column) {
      return column;
    }
  }
  return "";
}

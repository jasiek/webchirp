// Google Analytics event reporting. gtag() itself is loaded by index.html; this
// module is the only place the rest of the UI is allowed to reach it.
//
// Analytics is best-effort telemetry: gtag is absent in the headless tests,
// blocked outright for a good share of real users, and must never be able to
// break the operation it is reporting on. Every send is therefore guarded and a
// throwing gtag is swallowed.
//
// Two rules govern what may be sent:
//   - No user data. Never a file name, a channel name or comment, a frequency,
//     a search term or a coordinate. Every value below is a CHIRP driver
//     identifier, a fixed enum, or a bucketed count.
//   - Bounded cardinality. GA4 drops high-cardinality parameters, so free-form
//     text — error messages above all — is mapped onto a small fixed vocabulary
//     before it is sent, rather than reported verbatim.

import { errorDetails } from "./format.js";

export function trackEvent(name, params = {}) {
  const gtag = globalThis.gtag;
  if (typeof gtag !== "function") {
    return;
  }
  try {
    gtag("event", String(name), params);
  } catch {
    // A blocked or half-initialized gtag must not turn into a failed clone.
  }
}

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

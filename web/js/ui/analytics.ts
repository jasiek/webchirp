// The UI's side of analytics: the parameters every event site builds, and the
// one import path the UI modules reach gtag through.
//
// trackEvent lives in web/js/analytics.ts, which the two pages load directly —
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
//     nowhere; tests/channels/ga-dimensions.mjs fails the build if it is not.

import { errorDetails } from "./format.ts";
import { isRuntimeCallError, jsErrorName } from "../runtime-errors.ts";
import { isPortSelectionCancelled } from "../serial-errors.ts";
import type { CatalogRadio, RowIssue, SettingIssue } from "../runtime-rpc.ts";
import type { UiState } from "./state.ts";

export { trackEvent } from "../analytics.ts";

// The driver identity every radio-scoped event carries. radio answers "which
// radios do people own", module/class answer "which CHIRP driver ran", and the
// two differ often enough (one driver serves many models) to be worth sending
// both.
export function radioEventParams(
  radio: Pick<CatalogRadio, "vendor" | "model" | "module" | "className"> | null | undefined,
): Record<string, string> {
  if (!radio) {
    return {};
  }
  return {
    radio: [radio.vendor, radio.model].filter(Boolean).map(String).join(" "),
    radio_module: String(radio.module || ""),
    radio_class: String(radio.className || ""),
  };
}

// Codeplug sizes as a handful of ranges. A raw count is a metric GA4 can only
// average; a bucket is a dimension every report can group by, which is what
// answers "how big are the codeplugs people actually work with" — and so which
// sizes the channel grid has to stay usable at.
export function channelCountBucket(count: unknown): string {
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
export function codeplugParams(
  state: Pick<UiState, "currentRows" | "codeplugSource"> | null | undefined,
): { channel_count: number; channel_count_bucket: string; codeplug_source: string } {
  const count = Array.isArray(state?.currentRows) ? state.currentRows.length : 0;
  return {
    channel_count: count,
    channel_count_bucket: channelCountBucket(count),
    codeplug_source: state?.codeplugSource || "unknown",
  };
}

// Failure causes the browser names with a JS error name. The port chooser and
// the serial transport report through DOMException names, so these are read
// off the error -- or, for a failure that came back through Python, off the JS
// error the JsException carried (jsErrorName, web/js/runtime-errors.ts) --
// rather than searched for in text. A dismissed chooser is the bridge's named
// cancellation once translated and a raw NotFoundError before it is.
const JS_ERROR_KINDS = new Map([
  ["NotFoundError", "port_not_selected"],
  ["NotAllowedError", "permission_denied"],
  ["SecurityError", "permission_denied"],
  ["NetworkError", "serial_disconnect"],
]);

// Failure causes that exist only as wording: a CHIRP driver says "Radio did
// not respond" with a bare RadioError, and a checksum or ident failure has no
// class of its own either, so for these the sentence is all there is. They are
// matched against what the failure said -- a runtime failure's message and the
// JS error under it, never its traceback, whose file and function names
// ("timeout.py", "_do_ident") would otherwise match patterns meant for the
// sentence. First match wins, so the specific patterns come before the general
// ones.
const TEXT_ERROR_KINDS: Array<[string, RegExp]> = [
  ["permission_denied", /permission (?:was )?denied|access denied/i],
  ["serial_disconnect", /device has been lost|device lost|port is (?:closed|already open)/i],
  ["no_response", /did not respond|not responding|no response|no data received/i],
  ["timeout", /timed out|timeout/i],
  ["ident_mismatch", /\bident\b|magic|incorrect model|wrong radio|model mismatch/i],
  ["checksum", /checksum|\bcrc\b/i],
  ["driver_unsupported", /unsupported|not supported/i],
  ["runtime_unavailable", /runtime api client is not initialized|loadpyodide|\bwasm\b/i],
];

// What a failure said, for TEXT_ERROR_KINDS: a runtime failure's message, the
// messages of the Python exceptions it was chained from -- a driver that
// re-raises "Block failed checksum!" as "Failed to read block" has said
// checksum -- and the JS error it wraps; or any other error's full detail.
function classifiableText(error: unknown): string {
  if (isRuntimeCallError(error)) {
    const causes = (error.pythonCauses || []).map((cause) => `${cause.type}: ${cause.message}`);
    if (error.jsCause) {
      causes.push(`${error.jsCause.name}: ${error.jsCause.message}`);
    }
    return [error.message, ...causes].join("\n");
  }
  return errorDetails(error);
}

// Map a failure onto the fixed error_kind vocabulary: by type first, then, for
// the causes that have no type, by what the failure said.
export function classifyErrorKind(error: unknown): string {
  if (isPortSelectionCancelled(error)) {
    return "port_not_selected";
  }
  const byName = JS_ERROR_KINDS.get(jsErrorName(error));
  if (byName) {
    return byName;
  }
  const text = classifiableText(error);
  for (const [kind, pattern] of TEXT_ERROR_KINDS) {
    if (pattern.test(text)) {
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
// A runtime failure names its Python class and a JS error its own name. The
// one text fallback is for a Python failure that never crossed rpc_dispatch: a
// PythonError raised while seeding the runtime, before the dispatcher exists,
// reaches here as the original PythonError (web/js/runtime-rpc.ts) whose text
// names the exception on the traceback's last line.
export function errorTypeName(error: unknown): string {
  if (isRuntimeCallError(error)) {
    return error.pythonType;
  }
  const detail = errorDetails(error);
  if (detail.includes("Traceback (most recent call last):")) {
    const lines = detail
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      // A JS/Pyodide wrapper prefix on the traceback header is not the Python
      // exception type. Skip it when no recognized exception follows.
      if (/^(?:[\w.]+:\s*)*Traceback \(most recent call last\):$/.test(lines[i])) {
        continue;
      }
      // Include the fixed built-in Python exceptions without Error/Exception
      // suffixes, even when they have no message; never accept arbitrary text.
      const name = lines[i].match(/^([\w.]+)(?:\s*:|$)/)?.[1]?.split(".").pop();
      if (name && /(?:(?:Error|Exception)$|^(?:StopIteration|StopAsyncIteration|KeyboardInterrupt|SystemExit|GeneratorExit)$)/.test(name)) {
        return name;
      }
    }
    return "";
  }
  const name = typeof (error as Error | null)?.name === "string" ? (error as Error).name : "";
  return /(?:Error|Exception)$/.test(name) ? name : "";
}

// The column of the first preflight issue, for reporting which fields block
// uploads most often. Column names come from CHIRP's own schema, so they are a
// bounded set; the rejected value itself is never sent.
export function firstIssueColumn(
  issues: ReadonlyArray<RowIssue | SettingIssue | null> | null | undefined,
): string {
  for (const issue of issues || []) {
    const column = String((issue && "column" in issue ? issue.column : "") || "");
    if (column) {
      return column;
    }
  }
  return "";
}

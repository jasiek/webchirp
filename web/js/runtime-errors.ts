// The JS side of web/python/webchirp_bridge/runtime_errors.py: what a runtime
// failure can be recognised as once it has crossed the Pyodide boundary.
//
// rpc_dispatch (web/python/webchirp_bridge/rpc.py) never raises across the
// boundary; a failed call comes back as an envelope of fields describing the
// Python exception, and web/js/rpc-dispatch.ts turns that envelope into the
// RuntimeCallError below. Every classifier here tests those fields, so the
// Python class names are the contract and they are stated once, in this module,
// rather than at each call site.

import { errorDetails } from "./error-details.ts";

/**
 * One exception the failed call was chained from (`__cause__`/`__context__`),
 * nearest first.
 */
export interface PythonCause {
  /** The exception's class name. */
  type: string;
  /** `str(exc)`. */
  message: string;
}

/**
 * The JS error under a Python `JsException`: what a rejected JS call raised
 * inside Python, by its own name and message.
 */
export interface JsCause {
  name: string;
  message: string;
}

/**
 * The `error` half of a failed envelope, as `rpc_error_envelope`
 * (web/python/webchirp_bridge/rpc.py) builds it. Every field is optional here
 * because the constructor below tolerates a partial one (tests build them by
 * hand), not because Python ever leaves one out.
 */
export interface RpcErrorFields {
  /** The Python class name. */
  type?: string;
  /** Every class above it, up to BaseException. */
  bases?: string[];
  /** The module that defines the class. */
  module?: string;
  /** `str(exc)` alone. */
  message?: string;
  /** The full formatted traceback. */
  traceback?: string;
  causes?: Partial<PythonCause>[];
  js?: Partial<JsCause> | null;
}

// A Python exception that crossed rpc_dispatch, as a JS Error. name is the
// Python class name, so Sentry titles and groups the event by it and a stack
// trace reads "RadioError: Radio did not respond"; message is str(exc) alone,
// the sentence a user can be shown. The rest is what the envelope carried:
// pythonBases (every class above it, up to BaseException), pythonModule, the
// full pythonTraceback the debug panel prints, pythonCauses ({type, message}
// of each exception it was chained from, nearest first), jsCause ({name,
// message} of the JS error behind a JsException, or null) and the rpcMethod
// that failed.
export class RuntimeCallError extends Error {
  pythonType: string;
  pythonBases: readonly string[];
  pythonModule: string;
  pythonTraceback: string;
  pythonCauses: readonly Readonly<PythonCause>[];
  jsCause: Readonly<JsCause> | null;
  rpcMethod: string;

  /**
   * @param envelope A failed envelope's `error` object.
   * @param options `method`: the RPC method that failed.
   */
  constructor(envelope: RpcErrorFields = {}, { method = "" }: { method?: string } = {}) {
    super(String(envelope.message ?? ""));
    this.name = String(envelope.type || "RuntimeCallError");
    this.pythonType = String(envelope.type || "");
    this.pythonBases = Object.freeze((envelope.bases || []).map(String));
    this.pythonModule = String(envelope.module || "");
    this.pythonTraceback = String(envelope.traceback || "");
    this.pythonCauses = Object.freeze((envelope.causes || []).map((cause) => Object.freeze({
      type: String(cause?.type || ""),
      message: String(cause?.message || ""),
    })));
    this.jsCause = envelope.js
      ? Object.freeze({ name: String(envelope.js.name || ""), message: String(envelope.js.message || "") })
      : null;
    this.rpcMethod = String(method || "");
  }
}

// Whether an error is a Python failure that came through rpc_dispatch. Tested
// by its fields rather than instanceof: the fields are what every classifier
// below reads, and they survive a caller that copies the error onto a plain
// object.
export function isRuntimeCallError(error: any): error is RuntimeCallError {
  return typeof error?.pythonType === "string" && error.pythonType !== ""
    && Array.isArray(error?.pythonBases);
}

// Whether error is a Python exception of class typeName or of any subclass of
// it: the class itself is checked first, then every base the envelope listed.
// This is the whole replacement for the regexes that used to look for a class
// name somewhere in a traceback's text.
/**
 * @param typeName A Python class name, e.g. "RadioError".
 */
export function isPythonError(error: any, typeName: string): error is RuntimeCallError {
  if (!isRuntimeCallError(error)) {
    return false;
  }
  return error.pythonType === typeName || error.pythonBases.includes(typeName);
}

// The name of the JS error at the bottom of a failure: the one a rejected JS
// call raised inside Python (a JsException's jsCause), or, for an error that
// never crossed the runtime, its own name. The port chooser and the serial
// transport report what happened through DOMException names, so this is what
// a classifier reads to recognise them wherever they surfaced.
export function jsErrorName(error: any): string {
  if (isRuntimeCallError(error)) {
    return error.jsCause?.name || "";
  }
  return typeof error?.name === "string" ? error.name : "";
}

// A step the user has not taken yet, rather than something that went wrong:
// pressing Upload before anything has been downloaded is the case this exists
// for. The message is already the instruction that fixes it, which is why the
// UI answers with a modal (web/js/ui/notice-modal.js) instead of a traceback in
// the debug panel, and why the event never reaches Sentry (isIgnoredError,
// web/js/sentry.js). A subclass of RuntimePreconditionError is one too.
export function isUserPreconditionFailure(error: any): error is RuntimeCallError {
  return isPythonError(error, "RuntimePreconditionError");
}

// The sentence to show a user for a failure -- "No cached radio image for this
// model. Download from radio first, then upload." rather than the twenty lines
// of traceback that carry it. For a runtime failure that is the Python
// message, which the envelope sends on its own (the class name is not in it);
// an exception raised with no message falls back to its class name. Anything
// else -- a JS Error, a bare string -- is its own first line, so a caller never
// has to ask which kind of failure it is holding.
export function runtimeErrorSentence(error: any): string {
  if (isRuntimeCallError(error)) {
    return error.message.trim() || error.pythonType;
  }
  const text = String(error?.message || error || "").trim();
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "Unknown error";
}

// A line of Error.stack that names a frame, in either syntax browsers write:
// V8's "    at fn (url:line:col)", or SpiderMonkey's and JavaScriptCore's
// "fn@url:line:col" (with "fn@[native code]" for a builtin). Only V8 opens the
// stack with an "Error: message" headline, and that matches neither, so
// filtering on this drops the headline in Chrome and keeps every frame in
// Firefox and Safari, whose stacks are nothing but frames.
const JS_STACK_FRAME = /^\s+at\s|@(?:\S+:\d+:\d+|\[native code\])$/;

// Full detail of a failure for the debug panel. A runtime failure prints one
// "RadioError: Radio did not respond" line, then its Python traceback -- the
// frames that say where CHIRP broke -- then the JS frames of the call that
// asked for it; anything else prints its own stack or message. The first line
// is shaped like a JS stack's so that everything reading a detail's first line
// (errorSummary in web/js/ui/format.js, the Report Bug prefill in
// web/js/ui/debug-log.js) gets the cause rather than "Traceback (most recent
// call last):", which is what they got while the traceback was the message.
// CLAUDE.md requires the whole of it to reach the panel.
export function runtimeErrorDetail(error: any): string {
  if (isRuntimeCallError(error)) {
    const jsFrames = String(error.stack || "")
      .split("\n")
      .filter((line) => JS_STACK_FRAME.test(line));
    const headline = `${error.name}: ${runtimeErrorSentence(error).split("\n")[0]}`;
    return [headline, error.pythonTraceback.trimEnd(), ...jsFrames].join("\n");
  }
  return errorDetails(error);
}

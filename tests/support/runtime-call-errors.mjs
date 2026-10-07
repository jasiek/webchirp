// Runtime failures as the browser receives them, for tests that do not boot
// Pyodide.
//
// rpc_dispatch (web/python/webchirp_bridge/rpc.py) answers a failed call with
// an error envelope, and unwrapRpcEnvelope (web/js/rpc-dispatch.mjs) turns it
// into a RuntimeCallError. The helpers here go through that same unwrap, so a
// fake-DOM or classifier test holds exactly the error the real dispatcher
// would have thrown -- and a change to the envelope's shape breaks them too.

import { unwrapRpcEnvelope } from "../../web/js/rpc-dispatch.mjs";

// The bases rpc_error_envelope sends for the classes the tests use, nearest
// first, as Python's MRO lists them (object left out). The chirp.errors ones
// follow chirp/chirp/errors.py.
const EXCEPTION_BASES = ["Exception", "BaseException"];
const SPECIFIC_RADIO_ERROR_BASES = ["SpecificRadioError", "RadioError", ...EXCEPTION_BASES];
export const PYTHON_BASES = Object.freeze({
  RadioError: EXCEPTION_BASES,
  InvalidDataError: EXCEPTION_BASES,
  InvalidValueError: EXCEPTION_BASES,
  InvalidMemoryLocation: EXCEPTION_BASES,
  UnsupportedToneError: EXCEPTION_BASES,
  ImageDetectFailed: EXCEPTION_BASES,
  ImageMetadataInvalidModel: EXCEPTION_BASES,
  RadioNoContactLikelyK1: SPECIFIC_RADIO_ERROR_BASES,
  RadioNoResponse: SPECIFIC_RADIO_ERROR_BASES,
  RadioFixedBanks: SPECIFIC_RADIO_ERROR_BASES,
  FrozenMemoryError: ["TypeError", ...EXCEPTION_BASES],
  RuntimeUnsupportedError: ["RadioError", ...EXCEPTION_BASES],
  ImageDetectionError: ["RuntimeUnsupportedError", "RadioError", ...EXCEPTION_BASES],
  RuntimePreconditionError: ["RuntimeUnsupportedError", "RadioError", ...EXCEPTION_BASES],
  JsException: ["JsProxy", ...EXCEPTION_BASES],
  ValueError: EXCEPTION_BASES,
});

// The module each class is defined in, which is what the traceback's last
// line and the envelope's module field name.
function defaultModule(type) {
  if (/^Runtime|^ImageDetectionError$/.test(type)) {
    return "webchirp_bridge.runtime_errors";
  }
  if (type === "JsException") {
    return "pyodide.ffi";
  }
  if (type === "ValueError") {
    return "builtins";
  }
  return "chirp.errors";
}

// A formatted traceback ending on the exception, the way Python prints one:
// frames first, then the module-qualified class and its message.
export function pythonTraceback(type, message, module = defaultModule(type), file = "clone.py") {
  const qualified = module === "builtins" ? type : `${module}.${type}`;
  return [
    "Traceback (most recent call last):",
    '  File "/webchirp_runtime/webchirp_bridge/rpc.py", line 214, in rpc_dispatch',
    "    result = await _call_rpc_method(method, params_json, callback)",
    `  File "/webchirp_runtime/webchirp_bridge/${file}", line 216, in upload_selected_radio`,
    "    return _upload_selected_radio_sync(resolve_session(session_id), rows, settings_groups)",
    `${qualified}: ${message}`,
    "",
  ].join("\n");
}

// The error envelope rpc_error_envelope would build for one exception.
export function errorEnvelope(type, message, { module, bases, traceback, causes = [], js = null } = {}) {
  const resolvedModule = module ?? defaultModule(type);
  return {
    type,
    bases: bases ?? PYTHON_BASES[type] ?? EXCEPTION_BASES,
    module: resolvedModule,
    message,
    traceback: traceback ?? pythonTraceback(type, message, resolvedModule),
    causes,
    js,
  };
}

// The RuntimeCallError the dispatcher throws for that envelope, produced by the
// dispatcher's own unwrap rather than by constructing the class directly.
export function runtimeCallError(type, message, options = {}, method = "upload_selected_radio") {
  try {
    unwrapRpcEnvelope(method, { ok: false, error: errorEnvelope(type, message, options) });
  } catch (error) {
    return error;
  }
  throw new Error("unwrapRpcEnvelope did not throw for a failed envelope");
}

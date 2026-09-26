// The JS half of the RPC contract with the Python runtime.
//
// Python exposes one callable in the Pyodide globals, rpc_dispatch
// (web/python/webchirp_bridge/rpc.py), which takes a method name, one JSON
// object of named parameters and an optional JS callback, and returns the
// result as JSON text. RPC_METHODS below is the JS copy of that contract: every
// method the runtime may be asked for and the parameter names it takes, under
// the Python spelling. A call is checked against it before it crosses the
// boundary, so a misnamed parameter fails here with the method named rather
// than as a TypeError inside Python -- and nothing is ever written into the
// interpreter's globals to pass an argument, which is what the string-built
// expressions this replaced did. tests/channels/rpc-contract.mjs proves this
// table and the Python one agree.
//
// A plain .mjs rather than .js so tests/support/radio-harness.mjs and the
// contract test can import it without the CDN resolve hook that
// web/js/runtime-rpc.js needs.

// The one parameter that is not JSON: a JS function, passed to rpc_dispatch as
// its third argument and bound in Python under this name. Mirrors
// CALLBACK_PARAM in web/python/webchirp_bridge/rpc.py.
export const RPC_CALLBACK_PARAM = "callback";

// Every runtime method and its parameters, in the order the Python function
// declares them. Grouped by owning module; the order is only for reading.
export const RPC_METHODS = Object.freeze({
  // web/python/webchirp_bridge/chirp_loader.py
  ensure_radio_module: Object.freeze(["module_short_name"]),
  import_all_driver_modules: Object.freeze(["module_short_names", RPC_CALLBACK_PARAM]),
  list_registered_radios: Object.freeze(["module_short_names"]),
  list_radio_features: Object.freeze(["module_short_names"]),
  // web/python/webchirp_bridge/session.py -- every radio-bound method below
  // takes the session_id these two hand out and take back.
  open_session: Object.freeze(["module_name", "class_name"]),
  close_session: Object.freeze(["session_id"]),
  // web/python/webchirp_bridge/column_metadata.py
  get_default_schema: Object.freeze([]),
  get_radio_column_metadata: Object.freeze(["session_id"]),
  // web/python/webchirp_bridge/channel_rows.py
  parse_csv: Object.freeze(["csv_text"]),
  normalize_rows: Object.freeze(["rows", "session_id"]),
  // web/python/webchirp_bridge/row_validation.py
  validate_rows_for_upload: Object.freeze(["rows", "session_id"]),
  // web/python/webchirp_bridge/channel_extra.py
  get_channel_extra: Object.freeze(["session_id", "location"]),
  // web/python/webchirp_bridge/radio_settings.py
  get_radio_settings: Object.freeze(["session_id"]),
  validate_radio_settings: Object.freeze(["session_id", "settings_groups"]),
  // web/python/webchirp_bridge/images.py
  read_image_metadata_base64: Object.freeze(["image_b64"]),
  load_image_base64: Object.freeze(["image_b64"]),
  export_image_base64: Object.freeze(["session_id", "rows", "settings_groups"]),
  get_cached_image_base64: Object.freeze(["session_id"]),
  // web/python/webchirp_bridge/serial_pipe.py
  webserial_connect: Object.freeze(["baudrate"]),
  webserial_disconnect: Object.freeze([]),
  webserial_txrx_hex: Object.freeze(["tx_hex", "rx_bytes", "timeout_ms"]),
  // web/python/webchirp_bridge/clone.py
  download_selected_radio: Object.freeze(["session_id"]),
  upload_selected_radio: Object.freeze(["session_id", "rows", "settings_groups"]),
});

// Check one call against RPC_METHODS and split it into what crosses the
// boundary: the JSON parameters and the callback. Every declared JSON
// parameter must be present and nothing else may be, so a caller cannot rely
// on a Python default that a later signature change removes; the callback is
// the one optional slot, because a method that takes one keeps working
// without it.
export function prepareRpcCall(name, params = {}) {
  const declared = RPC_METHODS[name];
  if (!declared) {
    throw new Error(`Unknown RPC method ${name}; known methods: ${Object.keys(RPC_METHODS).join(", ")}`);
  }
  const { [RPC_CALLBACK_PARAM]: callback = null, ...jsonParams } = params;
  const takesCallback = declared.includes(RPC_CALLBACK_PARAM);
  if (callback !== null && !takesCallback) {
    throw new Error(`RPC method ${name} takes no ${RPC_CALLBACK_PARAM}`);
  }
  if (callback !== null && typeof callback !== "function") {
    throw new Error(`RPC method ${name}: ${RPC_CALLBACK_PARAM} must be a function`);
  }
  const expected = declared.filter((param) => param !== RPC_CALLBACK_PARAM);
  const sent = Object.keys(jsonParams).sort();
  const wanted = expected.slice().sort();
  if (sent.join(",") !== wanted.join(",")) {
    throw new Error(
      `RPC method ${name} takes (${expected.join(", ")}), got (${Object.keys(jsonParams).join(", ")})`,
    );
  }
  return { paramsJson: JSON.stringify(jsonParams), callback };
}

// One dispatcher per interpreter, so an interpreter swap (the isolated
// Quansheng runtime in web/js/selected-driver-runtime.mjs boots a fresh
// Pyodide per release) gets a fresh handle on its own rpc_dispatch rather
// than calling into the interpreter it replaced.
const dispatchers = new WeakMap();

// The rpc_dispatch handle of one seeded interpreter, with call() as the only
// way through it. Memoized per interpreter because pyodide.globals.get()
// allocates a new PyProxy on every read.
export function rpcDispatcherFor(pyodide) {
  let dispatcher = dispatchers.get(pyodide);
  if (!dispatcher) {
    const dispatch = pyodide.globals.get("rpc_dispatch");
    if (typeof dispatch !== "function") {
      throw new Error("rpc_dispatch is not defined; the runtime bridge was not seeded");
    }
    dispatcher = Object.freeze({
      // Run one method and return its decoded result. The Python coroutine
      // comes back as an awaitable PyProxy; it is released once settled so a
      // long session does not accumulate one proxy per call.
      async call(name, params = {}) {
        const { paramsJson, callback } = prepareRpcCall(name, params);
        const pending = dispatch(name, paramsJson, callback);
        try {
          return JSON.parse(await pending);
        } finally {
          pending?.destroy?.();
        }
      },
    });
    dispatchers.set(pyodide, dispatcher);
  }
  return dispatcher;
}

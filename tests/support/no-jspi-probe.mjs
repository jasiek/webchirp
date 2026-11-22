// Run by tests/channels/no-jspi-runtime.mjs under
// node --no-experimental-wasm-jspi, the Node stand-in for a browser without
// WebAssembly stack switching (Firefox ESR, say). It lives here rather than
// in a suite directory because it is a script, not a test: it boots the
// shared harness once, tries what a JSPI-less browser can and cannot do, and
// prints one JSON line on stdout, after anything the runtime logged there,
// for the test to assert on. Each step
// records its failure instead of throwing, so the test reports every
// difference at once.
import { loadImageFor, readCatalog, sharedHarness } from "./chirp.mjs";
import { errorFields } from "../../web/js/error-details.ts";

const harness = await sharedHarness();

async function attempt(step) {
  try {
    return { ok: true, value: await step() };
  } catch (error) {
    const { name, message } = errorFields(error);
    return { ok: false, name, message };
  }
}

const report = {
  // Python's own answer to "can this runtime block on a Promise?".
  canRunSync: await attempt(() =>
    harness.runPythonJson("import json, pyodide.ffi\njson.dumps(pyodide.ffi.can_run_sync())"),
  ),
  // The call itself, on an already-settled Promise so nothing but stack
  // switching can make it fail. Caught in Python, so the class name is
  // Python's rather than Pyodide's PythonError wrapper.
  runSync: await attempt(() =>
    harness.runPythonJson(`
import json, pyodide.ffi
from js import Promise
try:
    _outcome = {"value": pyodide.ffi.run_sync(Promise.resolve(7))}
except Exception as _error:
    _outcome = {"raised": type(_error).__name__, "message": str(_error)}
json.dumps(_outcome)
`),
  ),
  // The clone path: a download through the same RPC the browser calls. Its
  // first serial call goes through run_sync (jsbridge._await_js).
  download: await attempt(() => harness.readCodeplug("uv5r", "BaofengUV5R")),
  // Everything that never waits on the serial port: reading an image file.
  imageLoad: await attempt(async () => {
    const { loaded } = await loadImageFor(harness, await readCatalog(), "Baofeng_UV-5R.img");
    return { module: loaded.module, className: loaded.className, rows: loaded.rows.length };
  }),
};

process.stdout.write(`${JSON.stringify(report)}\n`);

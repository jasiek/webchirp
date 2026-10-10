// The third-party URLs the app runs from, all pinned versions on jsDelivr.
//
// One module so the runtime that loads them and scripts/build-dist.ts, which
// lists them in asset-manifest.json for the service worker to cache (web/sw.ts),
// read the same strings: a version bump here is a bump everywhere. The one
// copy that cannot come from here is the static import of Pyodide's loader at
// the top of web/js/runtime-rpc.ts, because an import specifier must be a
// literal.

// Where Pyodide's loader finds its wasm, its stdlib and its lock file. Must
// name the same release as that import and the exact pin of the pyodide npm
// package, which the Node tests run and tsc takes its types from;
// tests/build/pyodide-version.mjs holds them together.
export const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

// Every file loadPyodide() fetches from PYODIDE_INDEX_URL when no packages are
// loaded (nothing here calls loadPackage: CHIRP comes from our own archive).
// The loader itself, pyodide.mjs, is the module runtime-rpc.ts imports.
export const PYODIDE_RUNTIME_FILES = Object.freeze([
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
]);

// The CDC-ACM SerialPort polyfill, imported lazily by web/js/webusb-serial.ts
// when a non-FTDI WebUSB device is chosen. Self-contained: it imports nothing.
export const WEB_SERIAL_POLYFILL_URL = "https://cdn.jsdelivr.net/npm/web-serial-polyfill@1.0.15/+esm";

// The CDN files the app cannot start a radio session without, which the
// service worker keeps beside each build so a cached build boots offline. The
// Sentry SDK is left out on purpose: it is useless without a network, and
// web/js/sentry.ts already carries on when it fails to load.
export const OFFLINE_CDN_URLS: readonly string[] = Object.freeze([
  ...PYODIDE_RUNTIME_FILES.map((name) => `${PYODIDE_INDEX_URL}${name}`),
  WEB_SERIAL_POLYFILL_URL,
]);

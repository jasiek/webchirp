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

// jsDelivr's flattened ESM build of @sentry/browser, pinned to an exact
// version. This is how every other third-party browser dependency arrives here
// (Pyodide, the Web Serial polyfill): the dist build bundles only this repo's
// sources and keeps jsDelivr imports external, and the dev server does not
// serve node_modules, so an npm package cannot be imported by the browser
// directly. tests/channels/sentry.mjs holds it to package.json's version.
export const SENTRY_SDK_VERSION = "10.73.0";
export const SENTRY_SDK_URL = `https://cdn.jsdelivr.net/npm/@sentry/browser@${SENTRY_SDK_VERSION}/+esm`;

// The version of @sentry/conventions the SDK's build imports. It is versioned
// apart from the SDK (@sentry/browser and @sentry/core ask for ^0.16.0).
const SENTRY_CONVENTIONS_VERSION = "0.16.0";

// Every module the SDK's +esm build imports, transitively: the build itself,
// each of @sentry/browser's dependencies, and the browser subpath of
// @sentry/core that jsDelivr splits out. tests/channels/sentry.mjs checks the
// list against the installed packages, and tests/e2e/sentry-sdk-modules.mjs
// walks the real imports on jsDelivr.
export const SENTRY_SDK_MODULES: readonly string[] = Object.freeze([
  SENTRY_SDK_URL,
  ...["core", "browser-utils", "feedback", "replay", "replay-canvas"].map(
    (name) => `https://cdn.jsdelivr.net/npm/@sentry/${name}@${SENTRY_SDK_VERSION}/+esm`,
  ),
  `https://cdn.jsdelivr.net/npm/@sentry/core@${SENTRY_SDK_VERSION}/browser/+esm`,
  `https://cdn.jsdelivr.net/npm/@sentry/conventions@${SENTRY_CONVENTIONS_VERSION}/attributes/+esm`,
]);

// The CDN files the service worker keeps beside each build: what a radio
// session cannot start without, and the Sentry SDK, so that an error or a
// flow metric from a page with no network is kept and sent later (the SDK's
// offline transport, web/js/sentry.ts) rather than lost with the page.
export const OFFLINE_CDN_URLS: readonly string[] = Object.freeze([
  ...PYODIDE_RUNTIME_FILES.map((name) => `${PYODIDE_INDEX_URL}${name}`),
  WEB_SERIAL_POLYFILL_URL,
  ...SENTRY_SDK_MODULES,
]);

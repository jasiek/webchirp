// Module-resolution hook that makes the browser's CDN imports resolvable under
// node:test. web/js/runtime-rpc.js imports Pyodide straight from jsDelivr --
// the browser has no bundler and no import map, so an absolute URL is the only
// specifier that works there -- and Node cannot resolve an https: specifier at
// all. That single line is why a 600-line core module was invisible to every
// test and to the coverage report; mapping the URL onto the pinned `pyodide`
// package in node_modules (the same build the CDN serves, per the version in
// the URL) makes the module importable without changing what ships.
//
// Registered by tests/support/register-cdn-imports.mjs, which is what a
// test imports; keep the two in step.
const PYODIDE_CDN_PREFIX = "https://cdn.jsdelivr.net/pyodide/";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(PYODIDE_CDN_PREFIX)) {
    // Resolve relative to this hook rather than the importing module, so the
    // lookup lands in the repo's own node_modules no matter which file asked.
    return next("pyodide", { ...context, parentURL: import.meta.url });
  }
  return next(specifier, context);
}

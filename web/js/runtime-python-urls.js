// Where the browser fetches each runtime Python file from, keyed the way
// RUNTIME_PYTHON_FILES and EXTRA_DRIVER_RELATIVE_FILES
// (web/js/python-sources.mjs) name them.
//
// This is the source as scripts/dev-server.mjs serves it: every file under its
// own name, below the page. scripts/build-dist.mjs never edits it; it gives
// the bundle a generated module in its place, a literal table naming each
// file's content-hashed copy in dist/. So a new runtime file needs only its
// entry in RUNTIME_PYTHON_FILES, and the provider (createBrowserPythonSource)
// still refuses to construct when a listed file has no URL here.
import { EXTRA_DRIVER_RELATIVE_FILES, RUNTIME_PYTHON_FILES } from "./python-sources.mjs";

/** @type {Readonly<Record<string, string>>} */
export const RUNTIME_PYTHON_URLS = Object.freeze(Object.fromEntries(
  [...RUNTIME_PYTHON_FILES, ...EXTRA_DRIVER_RELATIVE_FILES]
    .map((relPath) => [relPath, `./python/${relPath}`]),
));

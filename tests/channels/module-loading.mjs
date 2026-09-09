// Imports every browser module the app ships, once, in one process.
//
// Two things depend on this. V8 coverage only reports files it actually
// loaded, so a module no test touches is absent from the report rather than
// listed at 0% -- before this test that quietly kept web/app.js,
// web/js/runtime-rpc.js, web/js/tooltip.js and web/js/version-info.js (805
// lines) out of the denominator, and the headline percentage was measured
// against a codebase smaller than the one that deploys. And an import is its
// own assertion: a typo in a relative specifier, a module renamed without its
// importers, or a cycle that leaves an export undefined at module-evaluation
// time all surface here rather than in the browser.
//
// The file list is walked, not enumerated, so a new module is covered the day
// it lands instead of the day someone remembers to add it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Must precede any import of a module that reaches for a CDN URL; see
// tests/support/cdn-imports.mjs.
import "../support/register-cdn-imports.mjs";

import { installFakeDom } from "../support/fake-dom.mjs";
import { webDir } from "../support/repo-paths.mjs";

// Every .js/.mjs under web/, repo-relative and sorted so the test order (and
// any failure) is stable across machines.
function shippedModulePaths(dir = webDir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...shippedModulePaths(full));
    } else if (/\.m?js$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

// The globals a module may touch while it is being evaluated. This is not a
// browser: it is the smallest surface that lets top-level code run to
// completion, because what is under test is that the module loads, not that it
// works. `vivify` hands out an element for any selector, so a module that
// wires up its DOM at import time finds one.
function installBrowserGlobals() {
  const dom = installFakeDom({
    // Hand out an element for any selector a module asks for while loading.
    // The tag is the selector's own leading tag name where it has one, so
    // "input#foo" is an input; an id-only selector becomes a div, which is
    // enough for code that only stores the handle or sets textContent.
    vivify: (selector) => selector.trim().match(/^([a-zA-Z][\w-]*)/)?.[1] || "div",
    navigator: {
      userAgent: "FakeBrowser/1.0",
      // No serial or usb key at all. web/js/serial.js and
      // web/js/serial-test-page.js test for support with the `in` operator, so
      // a key present with the value undefined reads as supported -- the
      // opposite of what is wanted here. web/app.js branches on that at import
      // time and logs down either path; with both absent it takes the
      // unsupported branch, which is the one worth loading under a fake DOM.
    },
    globals: {
      // web/js/version-info.js fetches ./version.json as it loads and swallows
      // any failure, so a rejecting fetch exercises its own error path.
      fetch: async () => {
        throw new Error("fetch is not available in the module-loading test");
      },
      WebAssembly: globalThis.WebAssembly,
      location: { href: "https://example.invalid/", search: "", hash: "" },
    },
  });
  return dom;
}

test("every shipped browser module loads", async (t) => {
  const modulePaths = shippedModulePaths();
  assert.ok(modulePaths.length > 20, "the walk should find the whole web/ tree");

  const dom = installBrowserGlobals();
  t.after(() => dom.restore());

  const failures = [];
  for (const modulePath of modulePaths) {
    try {
      await import(pathToFileURL(modulePath).href);
    } catch (error) {
      failures.push(`${path.relative(process.cwd(), modulePath)}: ${error && error.message}`);
    }
  }

  assert.deepEqual(failures, [], `modules failed to load:\n${failures.join("\n")}`);
});

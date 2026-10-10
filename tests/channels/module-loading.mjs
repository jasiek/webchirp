// Imports every browser module the app ships, once, in one process.
//
// Two things depend on this. V8 coverage only reports files it actually
// loaded, so a module no test touches is absent from the report rather than
// listed at 0% -- before this test that quietly kept web/app.ts,
// web/js/runtime-rpc.ts, web/js/tooltip.ts and web/js/version-info.ts (805
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

import { FakeCacheStorage } from "../support/fake-cache-storage.mjs";
import { installIndexPage } from "../support/index-page.mjs";
import { webDir } from "../support/repo-paths.mjs";

// Every .js/.mjs/.ts module under web/ (not a .d.ts, which only tsc reads), repo-relative and sorted so the test order (and
// any failure) is stable across machines.
function shippedModulePaths(dir = webDir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...shippedModulePaths(full));
    } else if (/(?<!\.d)\.(?:m?js|ts)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

// The page under web/ whose <script type="module"> loads each module, for the
// modules that wire up their page's DOM as they load (web/js/serial-test-page.ts
// queries serial-test.html's elements at import time). A module no page names
// directly is imported by another module, under index.html.
function pageOfEachModule() {
  const pages = new Map();
  for (const name of fs.readdirSync(webDir).filter((file) => file.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(webDir, name), "utf8");
    for (const [, src] of html.matchAll(/<script type="module" src="\.\/([^"]+)"/g)) {
      const modulePath = path.join(webDir, src);
      if (name === "index.html" || !pages.has(modulePath)) {
        pages.set(modulePath, name);
      }
    }
  }
  return pages;
}

// The globals a module may touch while it is being evaluated: the page the
// module ships in, plus a few stand-ins. What is under test is that the module
// loads, not that it works.
function installBrowserGlobals(page) {
  const dom = installIndexPage({
    page,
    navigator: {
      userAgent: "FakeBrowser/1.0",
      // No serial or usb key at all. web/js/serial.ts and
      // web/js/serial-test-page.ts test for support with the `in` operator, so
      // a key present with the value undefined reads as supported -- the
      // opposite of what is wanted here. web/app.ts branches on that at import
      // time and logs down either path; with both absent it takes the
      // unsupported branch, which is the one a page without serial takes.
    },
    globals: {
      // web/js/version-info.ts fetches ./version.json as it loads and swallows
      // any failure, so a rejecting fetch exercises its own error path.
      fetch: async () => {
        throw new Error("fetch is not available in the module-loading test");
      },
      WebAssembly: globalThis.WebAssembly,
    },
  });
  return dom;
}

// web/sw.ts runs in a service worker, not a page: as it loads it reads its
// registration's scope, opens nothing yet, and binds its events on the worker
// global. Stand-ins for exactly that, set for its import and removed after.
const SERVICE_WORKER_MODULE = path.join(webDir, "sw.ts");

function installServiceWorkerGlobals() {
  const stubs = {
    registration: { scope: "https://webchirp.test/" },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: async () => {},
    caches: new FakeCacheStorage(),
    addEventListener: () => {},
  };
  const saved = Object.fromEntries(Object.keys(stubs).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  };
}

test("every shipped browser module loads", async (t) => {
  const modulePaths = shippedModulePaths();
  assert.ok(modulePaths.length > 20, "the walk should find the whole web/ tree");

  const pages = pageOfEachModule();
  let dom = installBrowserGlobals("index.html");
  t.after(() => dom.restore());

  const failures = [];
  // index.html's modules first, then each other page's under its own markup.
  const pageOf = (modulePath) => pages.get(modulePath) || "index.html";
  const ordered = [...modulePaths].sort((a, b) => (pageOf(a) === "index.html" ? 0 : 1) - (pageOf(b) === "index.html" ? 0 : 1));
  for (const modulePath of ordered) {
    if (pageOf(modulePath) !== "index.html") {
      dom = installBrowserGlobals(pageOf(modulePath));
    }
    const restoreWorker = modulePath === SERVICE_WORKER_MODULE ? installServiceWorkerGlobals() : () => {};
    try {
      await import(pathToFileURL(modulePath).href);
    } catch (error) {
      failures.push(`${path.relative(process.cwd(), modulePath)}: ${error && error.message}`);
    } finally {
      restoreWorker();
    }
  }

  assert.deepEqual(failures, [], `modules failed to load:\n${failures.join("\n")}`);
});

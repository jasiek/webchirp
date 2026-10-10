// The Sentry SDK's +esm build on jsDelivr is generated: what it imports is
// decided by jsDelivr, not by this repo, and a dependency resolved from a range
// (@sentry/conventions is ^0.16.0) can change under a pinned SDK version. The
// service worker caches SENTRY_SDK_MODULES (web/js/cdn-urls.ts) so the SDK,
// and with it the offline transport, loads with no network; this walks the
// real imports and fails when the list no longer matches them. It needs the
// network, so it lives with the browser tests rather than in npm test.
import { expect, test } from "@playwright/test";

import { SENTRY_SDK_MODULES, SENTRY_SDK_URL } from "../../web/js/cdn-urls.ts";

const CDN = "https://cdn.jsdelivr.net";

// Every module reachable from root through jsDelivr's absolute /npm/ imports.
async function importClosure(root) {
  const seen = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const url = queue.shift();
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    const response = await fetch(url);
    expect(response.ok, `${url} answered ${response.status}`).toBe(true);
    const source = await response.text();
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*["'](\/npm\/[^"']+)["']/g)) {
      queue.push(new URL(specifier, CDN).href);
    }
  }
  return seen;
}

test("the offline list names exactly the modules the Sentry SDK imports", async () => {
  const closure = await importClosure(SENTRY_SDK_URL);
  expect([...closure].sort()).toEqual([...SENTRY_SDK_MODULES].sort());
});

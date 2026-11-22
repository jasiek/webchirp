import assert from "node:assert/strict";
import test from "node:test";

// Must precede the dynamic import of runtime-rpc.ts, which imports Pyodide
// from its CDN URL; see tests/support/cdn-imports.mjs.
import "../support/register-cdn-imports.mjs";

import { installIndexPage } from "../support/index-page.mjs";

// The radio catalog comes from a prebuilt static file. When that is missing
// the default driver set falls back to live enumeration: boot the runtime,
// import every driver and ask list_registered_radios. The unofficial set
// cannot, because its F4HWN releases share one CHIRP identity and would
// register colliding classes in one registry (web/js/python-sources.ts says
// why they never share an interpreter), so it reports the catalog
// unavailable instead.

// A fetch that answers 404 to everything and remembers what was asked, so a
// test can see which path the catalog load took.
function notFoundFetch() {
  const requested = [];
  const fetch = async (url) => {
    requested.push(String(url));
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  return { fetch, requested };
}

// A fresh runtime-rpc.ts for the page's address: the driver set is read from
// location.search when the module is evaluated, so each test needs its own
// instance, which the query on the specifier gives it.
async function runtimeClientAt(url, instance) {
  const network = notFoundFetch();
  installIndexPage({ url, globals: { fetch: network.fetch } });
  const { createRuntimeRpcClient } = await import(`../../web/js/runtime-rpc.ts?${instance}`);
  const debugLines = [];
  const runtime = createRuntimeRpcClient({ logDebug: (line) => debugLines.push(line) });
  return { runtime, requested: network.requested, debugLines };
}

test("without its static catalog, unofficial mode reports it unavailable and enumerates nothing", async () => {
  const { runtime, requested, debugLines } = await runtimeClientAt(
    "?drivers=quansheng-unofficial",
    "unofficial-catalog-missing",
  );

  // Had the load fallen back, it would have failed booting the runtime
  // list_registered_radios runs in (Pyodide cannot load from its CDN URL
  // here), with that error instead of this one.
  await assert.rejects(runtime.listRadios(), {
    message: "The unofficial driver catalog is unavailable. Reload the page to retry.",
  });

  // Nothing past the static catalog was fetched: no CHIRP archive or
  // manifest, no driver file.
  assert.equal(requested.length, 1, `unexpected requests: ${requested.join(", ")}`);
  assert.match(requested[0], /\/radio-catalog-quansheng-unofficial\.json$/);
  assert.ok(debugLines.some((line) => line.includes("unofficial driver catalog is unavailable")));
});

test("without its static catalog, the default driver set falls back to live enumeration", async () => {
  const { runtime, requested } = await runtimeClientAt("", "default-catalog-missing");

  // The fallback's first step is listing the drivers from the CHIRP
  // manifest, which this fetch also refuses, so the load fails there -- past
  // the point where unofficial mode stops.
  await assert.rejects(runtime.listRadios(), (error) => {
    assert.doesNotMatch(error.message, /catalog is unavailable/);
    return true;
  });
  assert.match(requested[0], /\/radio-catalog\.json$/);
  assert.ok(
    requested.slice(1).some((url) => /\/chirp\/chirp-[0-9a-f]+\.json$/.test(url)),
    `the fallback should have asked for the CHIRP manifest: ${requested.join(", ")}`,
  );
});

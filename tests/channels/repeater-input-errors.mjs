import assert from "node:assert/strict";
import test from "node:test";

import { RepeaterInputError, createRepeaterSources } from "../../web/js/ui/repeater-sources.js";

// Telling a form the user can fix from a directory that is down. Both surface
// the same way in the UI, so the distinction exists only for telemetry: the one
// catch in web/js/ui/repeater-query.js records an input error as "blocked" and
// everything else as "failed", and without the type they are the same string in
// the same Error and every missing location inflates the service failure rate an
// alert would watch.

// Minimal ctx for building the sources. The validation branches under test throw
// before any of these are reached; they exist so the factory can be called at
// all, and a real query would need the whole UI controller.
function stubContext() {
  return {
    log: { setStatus() {}, logDebug() {} },
    state: {},
    table: { rowBuilderHooks: () => ({}), insertRowsAtSelectionOrEnd() {} },
  };
}

function rsgbSource() {
  const sources = createRepeaterSources(stubContext(), {
    endpoints: { rsgb: "https://api.example.test/rsgb" },
  });
  const rsgb = sources.find((source) => source.key === "rsgb");
  assert.ok(rsgb, "the RSGB source is missing, so the rest of this file proves nothing");
  return rsgb;
}

test("a query with no location is an input error, not a directory failure", async () => {
  await assert.rejects(
    () => rsgbSource().runQuery({ position: null, radius: 25 }),
    RepeaterInputError,
  );
});

test("a query with a non-positive distance is an input error", async () => {
  const rsgb = rsgbSource();
  const position = { latitude: 53.4, longitude: -2.9 };
  await assert.rejects(() => rsgb.runQuery({ position, radius: 0 }), RepeaterInputError);
  await assert.rejects(() => rsgb.runQuery({ position, radius: -5 }), RepeaterInputError);
  await assert.rejects(() => rsgb.runQuery({ position, radius: Number.NaN }), RepeaterInputError);
});

test("a directory that answers with an error is not an input error", async (t) => {
  // The half that matters: if a real service failure also came back as a
  // RepeaterInputError, every outage would be filed as "blocked" and the metric
  // would report the directories as healthy while nobody could query them.
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "upstream down" });
  t.after(() => {
    globalThis.fetch = previous;
  });

  await assert.rejects(
    () => rsgbSource().runQuery({ position: { latitude: 53.4, longitude: -2.9 }, radius: 25 }),
    (error) => error instanceof Error && !(error instanceof RepeaterInputError),
  );
});

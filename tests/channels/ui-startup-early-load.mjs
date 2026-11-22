// The Load button works from the first paint, before the radio catalog and
// the startup schema have arrived (issue #323): a CSV loaded in that window
// is the user's data, and the startup schema that lands after it must keep it.
import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { createDeferred, flushMicrotasks, importSampleCsv, tableNames } from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const HEADERS = ["Location", "Name", "Frequency"];

test("a CSV loaded while startup is still loading the catalog survives the startup schema", async () => {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  const catalog = createDeferred();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: () => catalog.promise,
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS, columns: {} }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
    parseCsv: async () => ({
      headers: HEADERS,
      rows: [{ Location: "1", Name: "EARLY", Frequency: "145.500000" }],
      errors: [],
      powerAdjusted: 0,
    }),
  }));
  const started = ui.init(true);
  await flushMicrotasks();

  await importSampleCsv(document);
  assert.deepEqual(tableNames(document), ["EARLY"], "the import landed before startup finished");

  catalog.resolve({ radios: [] });
  await started;

  assert.deepEqual(tableNames(document), ["EARLY"]);
});

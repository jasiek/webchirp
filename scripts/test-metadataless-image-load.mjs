import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findCatalogRadioForImageMetadata } from "../web/js/image-metadata.mjs";
import { listDriverModules } from "../web/js/python-sources.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// CHIRP only writes the metadata trailer for images saved as .img by a recent
// version, so older files identify no driver at all. Detection then falls back
// to every driver's match_model, which can only match drivers already imported.
const METADATA_LESS_IMAGE = "Baofeng_UV-3R.img";
const METADATA_IMAGE = "Baofeng_UV-5R.img";

async function readImage(name) {
  return new Uint8Array(await fs.readFile(path.join(imagesDir, name)));
}

test("image with a metadata trailer needs no full driver import", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const metadata = await harness.runPythonJson(
    "json.dumps(read_image_metadata_base64(_b))",
    { _b: Buffer.from(await readImage(METADATA_IMAGE)).toString("base64") },
  );
  assert.equal(metadata.hasMetadata, true);
  assert.equal(metadata.vendor, "Baofeng");
});

test("metadata-less image is undetectable until every driver is imported", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const image = await readImage(METADATA_LESS_IMAGE);

  const metadata = await harness.runPythonJson(
    "json.dumps(read_image_metadata_base64(_b))",
    { _b: Buffer.from(image).toString("base64") },
  );
  assert.equal(metadata.hasMetadata, false);

  // Without the preload the driver is not registered, so detection fails. This
  // is the failure users saw when dropping a pre-metadata image into the app.
  await assert.rejects(
    () => harness.loadCodeplugBinary(image),
    /Unable to detect radio from image/,
  );

  const result = await harness.runPythonJson(
    "json.dumps(import_all_driver_modules(_mods))",
    { _mods: await listDriverModules(harness.pythonSource) },
  );
  assert.ok(result.registered > 500, `expected many radio classes, got ${result.registered}`);

  const loaded = await harness.loadCodeplugBinary(image);
  assert.equal(loaded.module, "baofeng_uv3r");
  assert.equal(loaded.className, "UV3RRadio");
  assert.ok(loaded.rows.length > 0, "expected channels to be populated");
});

// The TS-480 image stores rclass "TS480Radio", which the catalog matcher
// resolves to the live-mode driver of that name rather than the clone-mode
// TS480_CRadio. Importing a live driver cannot help detection, because
// get_radio_by_image only considers FileBackedRadio subclasses.
test("clone image whose metadata resolves to a live-mode driver still loads", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = JSON.parse(
    await fs.readFile(path.join(repoRoot, "web/radio-catalog.json"), "utf8"),
  ).radios;

  const byClassName = catalog.filter((radio) => radio.className === "TS480Radio");
  assert.equal(byClassName.length, 1);
  assert.equal(byClassName[0].isLiveRadio, true, "expected the name clash to be a live radio");

  await harness.runPythonJson("json.dumps(import_all_driver_modules(_mods))", {
    _mods: await listDriverModules(harness.pythonSource),
  });
  const loaded = await harness.loadCodeplugBinary(await readImage("Kenwood_TS-480_CloneMode.img"));
  assert.equal(loaded.className, "TS480_CRadio");
  assert.ok(loaded.rows.length > 0, "expected channels to be populated");
});

test("import_all_driver_modules reports unimportable drivers instead of hiding them", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const result = await harness.runPythonJson(
    "json.dumps(import_all_driver_modules(_mods))",
    { _mods: ["uv5r", "definitely_not_a_driver"] },
  );
  assert.equal(result.imported, 1);
  assert.match(result.failed.definitely_not_a_driver, /ModuleNotFoundError/);
});

// Quansheng_UV-K5_egzumer.img is the case where a resolved-but-WRONG match was
// worse than no match: vendor/model alone resolved uvk5.OSFWUVK5Radio, a real
// non-live catalog entry, so the sweep was skipped and detection then raised
// "Unsupported model Quansheng UV-K5". The right driver lives in a different
// module and is only reachable when the variant is taken into account.
test("an image whose driver is distinguished only by variant resolves directly", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = JSON.parse(
    await fs.readFile(path.join(repoRoot, "web/radio-catalog.json"), "utf8"),
  ).radios;
  const image = await readImage("Quansheng_UV-K5_egzumer.img");

  const metadata = await harness.runPythonJson(
    "json.dumps(read_image_metadata_base64(_b))",
    { _b: Buffer.from(image).toString("base64") },
  );
  assert.equal(metadata.variant, "egzumer");
  assert.ok(
    catalog.filter((r) => r.vendor === metadata.vendor && r.model === metadata.model).length > 1,
    "vendor/model alone must still be ambiguous, or this test proves nothing",
  );

  const match = findCatalogRadioForImageMetadata(catalog, metadata);
  assert.equal(match?.module, "uvk5_egzumer");
  assert.equal(match?.className, "UVK5RadioEgzumer");

  // Importing only the resolved module must be enough — no all-drivers sweep.
  await harness.runPythonJson("json.dumps({'ok': bool(ensure_radio_module(_m))})", {
    _m: match.module,
  });
  const loaded = await harness.loadCodeplugBinary(image);
  assert.equal(loaded.module, "uvk5_egzumer");
  assert.equal(loaded.className, "UVK5RadioEgzumer");
  assert.ok(loaded.rows.length > 0, "expected channels to be populated");
});

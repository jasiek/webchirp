import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findCatalogRadioForImageMetadata,
  isImageDetectionFailure,
} from "../web/js/image-metadata.mjs";
import { listDriverModules } from "../web/js/python-sources.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// CHIRP only writes the metadata trailer for images saved as .img by a recent
// version, so older files identify no driver at all. Detection then falls back
// to every driver's match_model, which can only match drivers already imported.
const METADATA_LESS_IMAGE = "Baofeng_UV-3R.img";
const METADATA_IMAGE = "Baofeng_UV-5R.img";

// Two metadata-less images whose owning driver sits at opposite ends of the
// alphabetical module list (baofeng_uv3r is 13th of ~191, kguv8d is 94th), so
// the early exit is exercised near the start and around the middle of a sweep.
const PARITY_IMAGES = ["Baofeng_UV-3R.img", "Wouxun_KG-UV8D.img"];

// No driver claims a payload this small: it matches no _memsize, and every
// custom match_model rejects it.
const UNCLAIMABLE_IMAGE_BYTES = 7;

async function readImage(name) {
  return new Uint8Array(await fs.readFile(path.join(imagesDir, name)));
}

async function detectIncrementally(harness, image, modules, progressCb = null) {
  return harness.runPythonJson(
    "json.dumps(detect_image_driver_incremental(_image_b64, _mods, _progress_cb))",
    {
      _image_b64: Buffer.from(image).toString("base64"),
      _mods: modules,
      _progress_cb: progressCb,
    },
  );
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

// The browser retries the driver sweep only when detection is what
// failed, and it decides that by reading the Python class name out of the
// traceback Pyodide hands it. Nothing else pins the two together: rename the
// Python class and the backstop goes quietly dead, while widening the predicate
// makes every unrelated image failure cost a sweep before it surfaces.
test("the retry gate recognises a real detection failure and nothing else", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const image = await readImage(METADATA_LESS_IMAGE);

  const detectionError = await harness
    .loadCodeplugBinary(image)
    .then(() => null, (error) => error);
  assert.ok(detectionError, "expected an undetectable image to fail");
  assert.equal(isImageDetectionFailure(detectionError), true);

  const payloadError = await harness
    .runPythonJson("json.dumps(load_image_base64(_b))", { _b: "not base64!" })
    .then(() => null, (error) => error);
  assert.ok(payloadError, "expected an invalid payload to fail");
  assert.match(String(payloadError.message), /Invalid image base64 payload/);
  assert.equal(
    isImageDetectionFailure(payloadError),
    false,
    "a bad payload is not fixable by importing more drivers",
  );
});

// The incremental sweep only saves work if it never changes the answer. It is
// safe because get_radio_by_image returns the first match in DRV_TO_RADIO
// insertion order, and insertion order is decided by import order alone: import
// the same list in the same order and stop at the first hit, and the winner is
// the one the full sweep would have found. That equivalence is what these tests
// pin down — reordering the module list for speed would break it silently,
// because the default match_model is a bare memory-size comparison that several
// drivers can satisfy at once.
test("incremental detection picks the full sweep's driver without importing every module", async () => {
  const reference = await createTestRadioHarness({ repoRoot });
  const modules = await listDriverModules(reference.pythonSource);
  await reference.runPythonJson("json.dumps(import_all_driver_modules(_mods))", {
    _mods: modules,
  });

  for (const name of PARITY_IMAGES) {
    const image = await readImage(name);
    const full = await reference.loadCodeplugBinary(image);

    // A fresh runtime per image: with nothing imported yet, the early exit is
    // real rather than an artifact of drivers a previous case left registered.
    const harness = await createTestRadioHarness({ repoRoot });
    const reported = [];
    const detected = await detectIncrementally(harness, image, modules, (done, total, mod) =>
      reported.push([done, total, mod]),
    );

    assert.equal(detected.matched, true, `${name}: expected a driver to claim the image`);
    assert.equal(detected.module, full.module, `${name}: driver module`);
    assert.equal(detected.className, full.className, `${name}: driver class`);
    assert.equal(detected.exhausted, false, `${name}: expected an early exit`);
    assert.ok(
      detected.imported < detected.total,
      `${name}: imported ${detected.imported} of ${detected.total} modules`,
    );

    // Progress has to stop where detection stopped. A report past the match
    // would mean the sweep kept fetching modules it no longer needed.
    assert.equal(reported.length, detected.imported, `${name}: progress reports`);
    assert.deepEqual(reported.at(-1).slice(0, 2), [detected.imported, detected.total]);

    // Loading still goes through get_radio_by_image, now over a partially
    // populated directory, and must produce the same radio and the same rows.
    const loaded = await harness.loadCodeplugBinary(image);
    assert.equal(loaded.module, full.module, `${name}: loaded module`);
    assert.equal(loaded.className, full.className, `${name}: loaded class`);
    assert.deepEqual(loaded.rows, full.rows, `${name}: loaded channels`);
  }
});

// A driver imported earlier in the session (the radio the user had selected)
// sits at the front of DRV_TO_RADIO, so the full sweep would consider it before
// anything it imports. The incremental sweep has to check the already-registered
// classes first for the same reason.
test("detection considers drivers imported earlier in the session first", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  await harness.pyodide.runPythonAsync("ensure_radio_module('baofeng_uv3r')");

  const detected = await detectIncrementally(
    harness,
    await readImage(METADATA_LESS_IMAGE),
    ["uv5r", "ft60"],
  );

  assert.equal(detected.matched, true);
  assert.equal(detected.module, "baofeng_uv3r");
  assert.equal(detected.className, "UV3RRadio");
  assert.equal(detected.imported, 0, "expected no module imports at all");
});

test("an image no driver claims imports every module and reports the list exhausted", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const modules = await listDriverModules(harness.pythonSource);

  const detected = await detectIncrementally(
    harness,
    new Uint8Array(UNCLAIMABLE_IMAGE_BYTES),
    modules,
  );

  assert.equal(detected.matched, false);
  assert.equal(detected.module, "");
  // Only an exhausted list means every driver is registered, which is the one
  // thing the caller may cache for the rest of the session.
  assert.equal(detected.exhausted, true);
  assert.equal(detected.imported, modules.length);
  assert.ok(detected.registered > 500, `expected many radio classes, got ${detected.registered}`);
});

// Images with a metadata trailer normally skip detection entirely, but the
// TS-480 trailer resolves to a live-mode driver in the catalog, so it reaches
// this path. Detection then has to match on the vendor/model/variant aliases
// rather than match_model.
test("image whose metadata the catalog cannot match is detected incrementally too", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const modules = await listDriverModules(harness.pythonSource);
  const image = await readImage("Kenwood_TS-480_CloneMode.img");

  const detected = await detectIncrementally(harness, image, modules);

  assert.equal(detected.matched, true);
  assert.equal(detected.module, "ts480");
  assert.equal(detected.className, "TS480_CRadio");
  assert.ok(
    detected.imported < detected.total,
    `imported ${detected.imported} of ${detected.total} modules`,
  );

  const loaded = await harness.loadCodeplugBinary(image);
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

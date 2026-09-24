import assert from "node:assert/strict";
import test from "node:test";

import { listRadioFeatures, sharedHarness } from "../support/chirp.mjs";

// Two drivers whose capabilities differ in every field the sweep records, so a
// change that collapses the description to a shared default -- an empty band
// list, a constant channel count -- cannot pass. They are also the two radios
// the static per-model pages exist for: the UV-5R and the BF-888S are what the
// keyword research pointed at.
const MODULES = ["uv5r", "h777"];

test("a driver's features are read from what it advertises, not a template", async () => {
  const harness = await sharedHarness();
  const sweep = await listRadioFeatures(harness, MODULES);

  assert.deepEqual(sweep.failed, {}, "every driver in these modules describes itself");

  const uv5r = sweep.features["uv5r:BaofengUV5RGeneric"];
  assert.deepEqual(uv5r.memoryBounds, [0, 127], "UV-5R holds 128 channels numbered from 0");
  assert.equal(uv5r.nameLength, 7);
  assert.deepEqual(uv5r.modes, ["FM", "NFM"]);
  assert.deepEqual(uv5r.powerLevels, { High: "4.0W", Low: "1.0W" });
  assert.equal(uv5r.hasSettings, true);
  assert.ok(
    uv5r.bands.some(([low, high]) => low <= 145000000 && high >= 145000000),
    "the UV-5R covers 2m",
  );

  const bf888 = sweep.features["h777:H777Radio"];
  assert.deepEqual(bf888.memoryBounds, [1, 16], "BF-888S holds 16 channels numbered from 1");
  assert.equal(bf888.nameLength, 6);
  assert.deepEqual(
    bf888.bands,
    [[400000000, 490000000]],
    "the BF-888S is UHF only, which is the fact that distinguishes its page",
  );
});

test("the empty tone mode is left out of a radio's advertised capabilities", async () => {
  const harness = await sharedHarness();
  const sweep = await listRadioFeatures(harness, MODULES);

  for (const [key, features] of Object.entries(sweep.features)) {
    assert.ok(
      !features.toneModes.includes(""),
      `${key} lists "no tone" as a tone mode, which describes nothing`,
    );
  }
});

test("a radio that cannot be instantiated is reported, not silently dropped", async () => {
  const harness = await sharedHarness();
  const sweep = await listRadioFeatures(harness, MODULES);
  const described = Object.keys(sweep.features).length;
  const failed = Object.keys(sweep.failed).length;

  // The contract the page generator relies on: every catalogued radio lands in
  // exactly one of the two buckets, so a missing page is always traceable to a
  // named failure rather than to a radio the sweep forgot about.
  const registered = await harness.runPythonJson(
    "json.dumps([r['key'] for r in await list_registered_radios(_mods)])",
    { _mods: MODULES },
  );
  assert.equal(described + failed, registered.length);
  for (const key of registered) {
    assert.ok(
      key in sweep.features || key in sweep.failed,
      `${key} is registered but absent from both buckets`,
    );
  }
});

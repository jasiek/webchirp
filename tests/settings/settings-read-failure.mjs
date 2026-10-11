import assert from "node:assert/strict";
import test from "node:test";

import { loadImageFor, readCatalog, readImage, sharedHarness } from "../support/chirp.mjs";

// A driver with an ordinary settings tree, so has_settings is true and the
// failure below comes from get_settings() itself.
const IMAGE = "Baofeng_UV-5R.img";

test("image load keeps its channels when the driver's get_settings raises", async () => {
  const harness = await sharedHarness();
  const catalog = await readCatalog();
  const baseline = await loadImageFor(harness, catalog, IMAGE);
  assert.ok(baseline.loaded.rows.length > 0, "fixture should hold channels");
  assert.ok(baseline.loaded.settings.length > 0, "fixture should expose settings");

  const { module, className } = baseline.match;
  await harness.runPython(
    `
import sys
_cls = getattr(sys.modules["chirp.drivers." + _module], _class)
_original_get_settings = _cls.get_settings
def _broken_get_settings(self):
    raise RuntimeError("settings tree exploded")
_cls.get_settings = _broken_get_settings
    `,
    { _module: module, _class: className },
  );
  try {
    const loaded = await harness.loadCodeplugBinary(await readImage(IMAGE));
    assert.equal(loaded.rows.length, baseline.loaded.rows.length);
    // Empty settings is what the UI reads as "no Settings tab".
    assert.deepEqual(loaded.settings, []);
  } finally {
    await harness.runPython(
      `
import sys
getattr(sys.modules["chirp.drivers." + _module], _class).get_settings = _original_get_settings
      `,
      { _module: module, _class: className },
    );
  }
});

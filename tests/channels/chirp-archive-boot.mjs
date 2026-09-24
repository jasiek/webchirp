// The runtime boots from the CHIRP archive alone: no import hook, no fetch
// global, no interpreter suspension. These cases pin the three things that
// changed when the per-module CDN fetch went away -- where a driver's source
// comes from, what is (not) on sys.meta_path, and how the all-drivers sweep
// keeps its progress visible now that nothing in it suspends.
import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_MOUNT_DIR } from "../../web/js/python-sources.mjs";
import { importAllDriverModules, sharedHarness } from "../support/chirp.mjs";

// A driver that was never among the files seeded ahead of the old import hook,
// so importing it proves the mounted tree rather than a leftover preload.
const DRIVER = "uv5r";

test("a driver imports from the mounted archive with no fetch global installed", async () => {
  assert.equal(
    globalThis.fetch_chirp_source,
    undefined,
    "the harness must not install the retired CDN fetch global",
  );
  const harness = await sharedHarness({ isolated: true });
  const probe = await harness.runPythonJson(
    `
import sys
_before = "chirp.drivers." + _driver in sys.modules
ensure_radio_module(_driver)
_module = sys.modules["chirp.drivers." + _driver]
import chirp.drivers
json.dumps({
    "importedBefore": _before,
    "file": _module.__file__,
    "driversPackageFile": chirp.drivers.__file__,
    "driversAll": len(getattr(chirp.drivers, "__all__", [])),
    "finders": [type(f).__module__ + "." + type(f).__name__ for f in sys.meta_path],
})
    `,
    { _driver: DRIVER },
  );
  assert.equal(probe.importedBefore, false, "the isolated runtime should start without it");
  assert.equal(probe.file, `${RUNTIME_MOUNT_DIR}/chirp/drivers/${DRIVER}.py`);
  // Upstream's real drivers package, not the namespace package the old seed
  // left behind: its __init__ lists every driver module in __all__.
  assert.equal(probe.driversPackageFile, `${RUNTIME_MOUNT_DIR}/chirp/drivers/__init__.py`);
  assert.ok(probe.driversAll > 150, `expected __all__ to list the drivers, got ${probe.driversAll}`);
  assert.deepEqual(
    probe.finders.filter((name) => name.startsWith("webchirp_bridge.")),
    [],
    "the bridge must install no import hook of its own",
  );
});

test("the all-drivers sweep yields to the event loop between imports", async () => {
  const harness = await sharedHarness({ isolated: true });
  const modules = await harness.pythonSource.listDriverModules();
  assert.ok(modules.length > 150, `expected the manifest's driver list, got ${modules.length}`);

  // Count event-loop turns while the sweep runs. A synchronous loop would let
  // none through until it returned, so the counter would still read zero when
  // the last progress report arrives; the async sweep hands control back after
  // every import, which is what lets a browser paint the progress strip.
  let turns = 0;
  let stop = false;
  const tick = () => {
    if (!stop) {
      turns += 1;
      setTimeout(tick, 0);
    }
  };
  setTimeout(tick, 0);
  const reports = [];
  let turnsAtLastReport = 0;
  try {
    const result = await importAllDriverModules(harness, modules, (done, total, name) => {
      reports.push([done, total, name]);
      turnsAtLastReport = turns;
    });
    assert.equal(result.imported + Object.keys(result.failed).length, modules.length);
    assert.deepEqual(result.failed, {}, "every driver at this pin imports");
    assert.ok(result.registered > 500, `expected many radio classes, got ${result.registered}`);
  } finally {
    stop = true;
  }

  assert.equal(reports.length, modules.length, "one report per module");
  assert.deepEqual(reports.at(-1).slice(0, 2), [modules.length, modules.length]);
  assert.deepEqual(reports.map(([done]) => done), modules.map((_, i) => i + 1));
  assert.ok(
    turnsAtLastReport >= modules.length / 2,
    `expected the event loop to run between imports, saw ${turnsAtLastReport} turns over ${modules.length} modules`,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { listRegisteredRadios, sharedHarness } from "../support/chirp.mjs";

// Regression test for issue #100: ChirpCdnFinder.find_spec used to catch the
// error from fetching a driver's source and return None, so the import fell
// through to PathFinder and the user saw "ModuleNotFoundError: No module named
// 'chirp.drivers.kguv8d'" -- with no trace of the 404, the offline network or
// the missing JSPI support that actually stopped it. The finder must now name
// the real cause in both surfaces the user has: the raised error and the debug
// panel that serial_log feeds.
const FETCH_FAILURE = "Failed to fetch https://cdn.test/chirp/drivers/kguv8d.py: 503";

// Swap a JS callable a bridge module reaches through. Python bound it by value
// at "from js import ..." inside the owning module, so neither reassigning
// globalThis nor the flattened copy in pyodide.globals (which runtime_bridge.py
// exports from the module, not the other way round) would be seen -- the
// module attribute is the only handle. Which module owns the name is part of
// what this pins: the finder in chirp_loader fetches, and logs through
// jsbridge's _log_debug.
function patchPythonModule(pyodide, moduleName, overrides) {
  const module = pyodide.pyimport(moduleName);
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, module[name]);
    module[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      module[name] = value;
    }
    module.destroy();
  };
}

test("a failed CHIRP source fetch names its cause instead of ModuleNotFoundError", async () => {
  const harness = await sharedHarness();
  const pyodide = harness.pyodide;
  const loader = pyodide.pyimport("webchirp_bridge.chirp_loader");
  const originalFetch = loader.fetch_chirp_source;
  loader.destroy();
  const logged = [];

  const restoreFetch = patchPythonModule(pyodide, "webchirp_bridge.chirp_loader", {
    fetch_chirp_source: async (sourcePath) => {
      if (String(sourcePath).includes("kguv8d")) {
        throw new Error(FETCH_FAILURE);
      }
      return originalFetch(sourcePath);
    },
  });
  const restoreLog = patchPythonModule(pyodide, "webchirp_bridge.jsbridge", {
    serial_log: (message) => {
      logged.push(String(message || ""));
      return { logged: true };
    },
  });
  const restore = () => {
    restoreLog();
    restoreFetch();
  };

  try {
    await assert.rejects(
      harness.runPython('ensure_radio_module("kguv8d")'),
      (error) => {
        const text = String(error?.message || "");
        assert.match(text, /ImportError/);
        assert.match(text, /chirp\.drivers\.kguv8d/);
        assert.match(text, /\/chirp\/drivers\/kguv8d\.py/);
        assert.ok(
          text.includes(FETCH_FAILURE),
          `expected the fetch failure in the raised error, got: ${text}`,
        );
        return true;
      },
    );

    const debugPanel = logged.join("\n");
    assert.match(debugPanel, /IMPORT FAIL chirp\.drivers\.kguv8d/);
    assert.ok(
      debugPanel.includes(FETCH_FAILURE),
      `expected the fetch failure in the debug log, got: ${debugPanel}`,
    );
    // The traceback is what makes an unexpected failure triageable at all --
    // the JSPI case (FINDINGS: no-jspi-browsers-fail-init-as-unavailable)
    // raises from _await_js, far from the fetch itself.
    assert.match(debugPanel, /Traceback \(most recent call last\)/);
  } finally {
    restore();
  }

  // The hook still materializes modules once the source is reachable again: a
  // failed import must not poison later ones.
  const radios = await listRegisteredRadios(harness, ["kguv8d"]);
  assert.ok(radios.length > 0, "expected kguv8d to register after a successful fetch");
});

import assert from "node:assert/strict";
import test from "node:test";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

// Regression test for issue #100: ChirpCdnFinder.find_spec used to catch the
// error from fetching a driver's source and return None, so the import fell
// through to PathFinder and the user saw "ModuleNotFoundError: No module named
// 'chirp.drivers.kguv8d'" -- with no trace of the 404, the offline network or
// the missing JSPI support that actually stopped it. The finder must now name
// the real cause in both surfaces the user has: the raised error and the debug
// panel that serial_log feeds.
const FETCH_FAILURE = "Failed to fetch https://cdn.test/chirp/drivers/kguv8d.py: 503";

// Swap the two JS callables the finder reaches through. Both are module-level
// names in the Pyodide globals namespace runtime_bridge.py was executed in, and
// Python bound them by value at "from js import ...", so reassigning
// globalThis would not be seen -- the globals slot is the only handle.
function patchPythonGlobals(pyodide, overrides) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, pyodide.globals.get(name));
    pyodide.globals.set(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      pyodide.globals.set(name, value);
    }
  };
}

test("a failed CHIRP source fetch names its cause instead of ModuleNotFoundError", async () => {
  const harness = await createTestRadioHarness({ repoRoot: process.cwd() });
  const pyodide = harness.pyodide;
  const originalFetch = pyodide.globals.get("fetch_chirp_source");
  const logged = [];

  const restore = patchPythonGlobals(pyodide, {
    fetch_chirp_source: async (sourcePath) => {
      if (String(sourcePath).includes("kguv8d")) {
        throw new Error(FETCH_FAILURE);
      }
      return originalFetch(sourcePath);
    },
    serial_log: (message) => {
      logged.push(String(message || ""));
      return { logged: true };
    },
  });

  try {
    await assert.rejects(
      pyodide.runPythonAsync('ensure_radio_module("kguv8d")'),
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
  const radios = await harness.runPythonJson(
    "json.dumps(list_registered_radios(_modules))",
    { _modules: ["kguv8d"] },
  );
  assert.ok(radios.length > 0, "expected kguv8d to register after a successful fetch");
});

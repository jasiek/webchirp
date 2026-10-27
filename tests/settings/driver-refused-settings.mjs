import assert from "node:assert/strict";
import test from "node:test";

import { isPythonError, refusedSettingIssues } from "../../web/js/runtime-errors.ts";
import { initOptions } from "../../web/js/sentry.ts";
import { plantedImage, readCatalog, sharedHarness } from "../support/chirp.mjs";
import { withCapturedDebugLog } from "../support/debug-log-capture.mjs";

// What the settings step of an export or upload does with a value the driver
// refuses. kguv9dplus shows a stored frequency of 0 as "" and refuses "" when
// writing it back, and one user's KG-UV9GX failed every export and upload on
// such a 0 (WEBCHIRP-FRONTEND-2D, -2E; FINDINGS
// drivers-refuse-their-own-settings). No upstream image stores one, so it is
// planted. The driver's workaround, and the tests that show the driver still
// needs it, are in tests/channels/kguv9dplus-empty-frequency.mjs.
const IMAGE = "Wouxun_KG-UV9GX.img";
const PLANTED_FIELD = "vfo_a.band_200.freq";
const PLANTED_SETTING = "vfo_a.band_200.freq";
// A sibling the tests edit, in a band (108-181 MHz) where 146 MHz is valid.
const EDITED_SETTING = "vfo_a.band_150.freq";

// Every test here drives the same runtime; sharedHarness() memoizes the boot.
async function context() {
  return { harness: await sharedHarness(), catalog: await readCatalog() };
}

/** Find a setting in a serialized tree by its own id, at any depth. */
function findSetting(nodes, id) {
  for (const node of nodes || []) {
    if (node.kind === "group") {
      const found = findSetting(node.children, id);
      if (found) {
        return found;
      }
    } else if (node.id === id) {
      return node;
    }
  }
  return null;
}

/** A copy of a serialized tree with one setting's single value replaced. */
function withValue(nodes, id, current) {
  const copy = structuredClone(nodes);
  const node = findSetting(copy, id);
  assert.ok(node, `the tree should carry ${id}`);
  node.values[0].current = current;
  return copy;
}

/** Whether Sentry's beforeSend drops the event it would build for this error. */
function isIgnoredBySentry(error) {
  const event = { exception: { values: [{ type: error.name, value: error.message }] } };
  return initOptions().beforeSend(event, { originalException: error }) === null;
}

/** The single value a setting currently holds, without the driver's padding. */
function settingValue(nodes, id) {
  const node = findSetting(nodes, id);
  assert.ok(node, `the tree should carry ${id}`);
  return String(node.values[0].current).trim();
}

/** Open the image with a zero planted in VFO A's 200 MHz band frequency. */
async function loadPlanted(harness, catalog) {
  const { image } = await plantedImage(harness, catalog, IMAGE, { [PLANTED_FIELD]: 0 });
  const loaded = await harness.loadCodeplugBinary(image);
  assert.equal(settingValue(loaded.settings, PLANTED_SETTING), "");
  return loaded;
}

/** Run fn with the get_settings hook answering with each driver's own tree,
 * as for a driver no workaround covers. */
async function withoutSettingsWorkarounds(harness, fn) {
  await harness.runPython(`
import webchirp_bridge.workarounds as _hooks
_saved_get_settings = dict(_hooks._GET_SETTINGS)
_hooks._GET_SETTINGS.clear()
`);
  try {
    return await fn();
  } finally {
    await harness.runPython("_hooks._GET_SETTINGS.update(_saved_get_settings)");
  }
}

// Desktop CHIRP runs set_settings() only after an edit, so a write with none
// hands the driver nothing to refuse, whatever the image holds.
test("an export that edits no setting leaves the settings as read, without running the driver", async () => {
  const { harness, catalog } = await context();
  const loaded = await loadPlanted(harness, catalog);

  // The panel's whole tree, unedited -- what the browser sends on export.
  const { result: exported, log } = await withCapturedDebugLog(harness, () =>
    harness.exportCodeplugBinary(loaded.module, loaded.className, loaded.rows, loaded.settings),
  );
  assert.ok(
    log.some((line) => line.startsWith("No radio setting was changed")),
    "set_settings() should not run",
  );
  const reloaded = await harness.loadCodeplugBinary(exported.image);
  assert.equal(settingValue(reloaded.settings, PLANTED_SETTING), "");
});

// A driver refusing a value nobody edited is failing to write back its own
// tree -- an upstream defect, not the user's to correct -- so the write stops
// with the driver's own error rather than a notice naming the setting.
test("a refusal of a value nobody edited stops the write with the driver's own error", async () => {
  const { harness, catalog } = await context();
  const loaded = await loadPlanted(harness, catalog);

  await withoutSettingsWorkarounds(harness, () =>
    assert.rejects(
      harness.exportCodeplugBinary(
        loaded.module,
        loaded.className,
        loaded.rows,
        withValue(loaded.settings, EDITED_SETTING, "146.000000"),
      ),
      (error) => {
        assert.ok(isPythonError(error, "InvalidValueError"), `got ${error.name}`);
        assert.equal(error.message, "Frequency 0.000000 is not with in 219.000000-250.997500");
        return true;
      },
    ),
  );
});

// An edit the radio refuses is the user's to correct, so the export stops
// with a notice that names the setting, and Sentry never hears of it. Both
// refusals are covered: CHIRP's own value check (an option the list lacks)
// and the driver's apply callback (a frequency outside its band). The planted
// zero rides along, as it did for the user, and is not the one blamed.
const REFUSED_EDITS = [
  {
    why: "the driver's apply callback refuses a frequency outside the band",
    id: EDITED_SETTING,
    value: "50.000000",
    names: /Receiver A Settings > 150 MHz Band > Rx Frequency: Frequency 50\.000000 is not with in/,
  },
  {
    why: "CHIRP refuses an option the list does not hold",
    id: "vfo_a.band_150.encqt",
    value: "webchirp-not-an-option",
    names: /Receiver A Settings > 150 MHz Band > Encode QT/,
  },
];

test("an edit the radio refuses stops the export and names the setting", async () => {
  const { harness, catalog } = await context();
  const loaded = await loadPlanted(harness, catalog);

  for (const { why, id, value, names } of REFUSED_EDITS) {
    await assert.rejects(
      harness.exportCodeplugBinary(
        loaded.module,
        loaded.className,
        loaded.rows,
        withValue(loaded.settings, id, value),
      ),
      (error) => {
        assert.ok(isPythonError(error, "SettingsRefusedError"), `${why}: got ${error.name}`);
        assert.match(error.message, names, why);
        assert.match(error.message, /Correct it in Settings, then export again\./, why);
        assert.ok(isIgnoredBySentry(error), `${why}: Sentry should drop it`);
        // The refused setting travels with the error, by the same path the
        // panel keys its fields on, so the panel can mark it.
        const issues = refusedSettingIssues(error);
        assert.deepEqual(
          issues.map((issue) => issue.path.join(".")),
          [findSetting(loaded.settings, id).path.join(".")],
          why,
        );
        return true;
      },
    );
  }
});

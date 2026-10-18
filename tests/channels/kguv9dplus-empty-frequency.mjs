import assert from "node:assert/strict";
import test from "node:test";

import { isPythonError } from "../../web/js/runtime-errors.ts";
import { plantedImage, readCatalog, sharedHarness } from "../support/chirp.mjs";

// kguv9dplus shows a stored frequency of 0 as "" (int2freq, short2freq), and
// four kinds of setting have an apply callback that parses "" back as 0 Hz and
// refuses it as outside its range (freq2int, freq2short). So the driver cannot
// write back the tree it read from an image holding such a 0, which every
// export and upload of one user's KG-UV9GX hit (Sentry WEBCHIRP-FRONTEND-2D,
// -2E). The fix is web/python/webchirp_bridge/workarounds/kguv9dplus.py
// (FINDINGS drivers-refuse-their-own-settings): a frequency that read as empty
// and is still empty is left as read. No upstream image holds such a 0, so
// each one is planted.
const IMAGE = "Wouxun_KG-UV9GX.img";

// Each kind of setting the workaround covers: the memory field planted with
// 0, and the setting the driver shows it as.
const EMPTY_FREQUENCIES = [
  { kind: "a VFO band's Rx frequency", field: "vfo_a.band_200.freq", id: "vfo_a.band_200.freq" },
  { kind: "an FM broadcast channel", field: "fm_chans[0].fm_freq", id: "fm_1" },
  { kind: "an area's scan start", field: "settings.a.scan_st", id: "settings.a.scan_st" },
  { kind: "an area's scan end", field: "settings.a.scan_end", id: "settings.a.scan_end" },
];
const EVERY_FIELD = Object.fromEntries(EMPTY_FREQUENCIES.map(({ field }) => [field, 0]));

// A sibling the radio holds a frequency in: 152.23 MHz, in a band (108-181
// MHz) where 146 MHz is valid too.
const HELD_FREQUENCY = "vfo_a.band_150.freq";

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

/** A copy of a serialized tree with some settings' single values replaced. */
function withValues(nodes, values) {
  const copy = structuredClone(nodes);
  for (const [id, current] of Object.entries(values)) {
    const node = findSetting(copy, id);
    assert.ok(node, `the tree should carry ${id}`);
    node.values[0].current = current;
  }
  return copy;
}

/** The single value a setting holds, without the driver's padding. */
function settingValue(nodes, id) {
  const node = findSetting(nodes, id);
  assert.ok(node, `the tree should carry ${id}`);
  return String(node.values[0].current).trim();
}

/** Load the image with fields planted, the way the browser opens a file. */
async function loadPlanted(harness, fields) {
  const { image } = await plantedImage(harness, await readCatalog(), IMAGE, fields);
  return harness.loadCodeplugBinary(image);
}

/** Export a loaded codeplug with the given settings tree, then reopen it. */
async function exportAndReload(harness, loaded, settings) {
  const exported = await harness.exportCodeplugBinary(
    loaded.module,
    loaded.className,
    loaded.rows,
    settings,
  );
  return harness.loadCodeplugBinary(exported.image);
}

test("an edit is written beside every frequency the driver shows as empty, which stay as read", async () => {
  const harness = await sharedHarness();
  const loaded = await loadPlanted(harness, EVERY_FIELD);
  for (const { id } of EMPTY_FREQUENCIES) {
    assert.equal(settingValue(loaded.settings, id), "", `${id} should read as empty`);
  }

  const reloaded = await exportAndReload(
    harness,
    loaded,
    withValues(loaded.settings, { [HELD_FREQUENCY]: "146.000000" }),
  );
  assert.equal(settingValue(reloaded.settings, HELD_FREQUENCY), "146.000000");
  for (const { id } of EMPTY_FREQUENCIES) {
    assert.equal(settingValue(reloaded.settings, id), "", `${id} should stay empty`);
  }
});

test("a frequency typed into an empty one goes to the driver and is written", async () => {
  const harness = await sharedHarness();
  const loaded = await loadPlanted(harness, EVERY_FIELD);
  const reloaded = await exportAndReload(
    harness,
    loaded,
    withValues(loaded.settings, { "vfo_a.band_200.freq": "230.000000" }),
  );
  assert.equal(settingValue(reloaded.settings, "vfo_a.band_200.freq"), "230.000000");
});

// The workaround covers only frequencies that read as empty, so clearing one
// the radio holds is refused as desktop CHIRP refuses it.
test("clearing a frequency the radio holds is still refused, naming it", async () => {
  const harness = await sharedHarness();
  const loaded = await loadPlanted(harness, EVERY_FIELD);
  await assert.rejects(
    harness.exportCodeplugBinary(
      loaded.module,
      loaded.className,
      loaded.rows,
      withValues(loaded.settings, { [HELD_FREQUENCY]: "" }),
    ),
    (error) => {
      assert.ok(isPythonError(error, "SettingsRefusedError"), `got ${error.name}`);
      assert.match(error.message, /Receiver A Settings > 150 MHz Band > Rx Frequency: Frequency 0\.000000 is not with in/);
      return true;
    },
  );
});

// DRIVER_TESTS: each test below pins one kind of setting the driver cannot
// write back, so a pin bump names which ones CHIRP fixed. Drop a fixed kind
// from EMPTY_FREQUENCIES and from _REFUSE_EMPTY in the workaround; delete the
// workaround (its module, its entry in the get_settings hook, this file and
// the FINDINGS entry's mention of it) once none is left.
for (const { kind, field, id } of EMPTY_FREQUENCIES) {
  test(`without its workaround, the driver still refuses ${kind} it shows as empty`, async () => {
    // When this fails, the pinned CHIRP writes back this kind of empty
    // frequency. See DRIVER_TESTS above before deleting anything.
    const harness = await sharedHarness();
    const { match, image } = await plantedImage(harness, await readCatalog(), IMAGE, {
      [field]: 0,
    });
    const driver = await harness.runPythonJson(
      `
_r = _import_radio_class(_m, _c)(memmap.MemoryMapBytes(bytes(
    chirp_common.CloneModeRadio._strip_metadata(base64.b64decode(_b))[0])))
_setting = next(
    _s for _group in _r.get_settings() for _s in _group.walk()
    if str(_s.get_name()) == _id)
_shown = str(_setting.value)
_refused = ""
try:
    _setting.run_apply_callback()
except chirp_settings.InvalidValueError as _exc:
    _refused = str(_exc)
json.dumps({"shown": _shown, "refused": _refused})
`,
      { _m: match.module, _c: match.className, _b: image.toString("base64"), _id: id },
    );
    assert.equal(driver.shown.trim(), "", `the driver should show the planted 0 in ${id} as empty`);
    assert.match(driver.refused, /^Frequency 0\.000000 is not with in /);
  });
}

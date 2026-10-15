import assert from "node:assert/strict";
import test from "node:test";

import { isPythonError, refusedSettingIssues } from "../../web/js/runtime-errors.ts";
import { initOptions } from "../../web/js/sentry.ts";
import { loadImageFor, readCatalog, sharedHarness } from "../support/chirp.mjs";

// A driver can refuse to write back a value it rendered itself. kguv9dplus
// shows a VFO band frequency of 0 as "" (int2freq), and the apply callback
// that writes it parses "" as 0 Hz and raises InvalidValueError because 0 Hz
// is outside the band. Export and upload hand the panel's whole settings tree
// back, so every export of such an image used to fail on a setting nobody had
// touched (WEBCHIRP-FRONTEND-2D). No upstream image stores a zero there, so
// the zero is planted.
const IMAGE = "Wouxun_KG-UV9GX.img";
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

/** Plant a zero frequency in VFO A's 200 MHz band and serialize the image.
 *
 * Also replays the planted radio's own settings tree through the driver, the
 * way desktop CHIRP would after any edit, and reports what it refused: the
 * tests below are only worth anything while the driver still refuses it. */
async function plantedImage(harness, match, raw) {
  const planted = await harness.runPythonJson(
    `
_r = _import_radio_class(_m, _c)(memmap.MemoryMapBytes(bytes(
    chirp_common.CloneModeRadio._strip_metadata(base64.b64decode(_b))[0])))
_r._memobj.vfo_a.band_200.freq = 0
_image = base64.b64encode(_image_bytes_from_radio(_r)).decode()
_refused = ""
try:
    _r.set_settings(_r.get_settings())
except chirp_settings.InvalidValueError as _exc:
    _refused = str(_exc)
json.dumps({"image": _image, "refused": _refused})
    `,
    {
      _m: match.module,
      _c: match.className,
      _b: Buffer.from(raw).toString("base64"),
    },
  );
  assert.match(
    planted.refused,
    /not with in/,
    "the driver should still refuse to replay a zero VFO frequency",
  );
  return Buffer.from(planted.image, "base64");
}

test("an export that edits no setting leaves a value the driver would refuse as read", async () => {
  const { harness, catalog } = await context();
  const { match, raw } = await loadImageFor(harness, catalog, IMAGE);
  const loaded = await harness.loadCodeplugBinary(await plantedImage(harness, match, raw));
  assert.equal(settingValue(loaded.settings, PLANTED_SETTING), "");

  // The panel's whole tree, unedited -- what the browser sends on export.
  const exported = await harness.exportCodeplugBinary(
    loaded.module,
    loaded.className,
    loaded.rows,
    loaded.settings,
  );
  const reloaded = await harness.loadCodeplugBinary(exported.image);
  assert.equal(settingValue(reloaded.settings, PLANTED_SETTING), "");
});

// Once the user edits something, set_settings() runs over the whole tree, and
// the planted zero is replayed with it. Desktop CHIRP stops there with the
// driver's message; here a refusal of a value nobody edited leaves its bytes
// as read, and only the edits are written.
test("an edit is written even beside a value the driver would refuse", async () => {
  const { harness, catalog } = await context();
  const { match, raw } = await loadImageFor(harness, catalog, IMAGE);
  const loaded = await harness.loadCodeplugBinary(await plantedImage(harness, match, raw));

  const exported = await harness.exportCodeplugBinary(
    loaded.module,
    loaded.className,
    loaded.rows,
    withValue(loaded.settings, EDITED_SETTING, "146.000000"),
  );
  const reloaded = await harness.loadCodeplugBinary(exported.image);
  assert.equal(settingValue(reloaded.settings, EDITED_SETTING), "146.000000");
  assert.equal(settingValue(reloaded.settings, PLANTED_SETTING), "");
});

// An edit the radio refuses is the user's to correct, so the export stops
// with a notice that names the setting, and Sentry never hears of it. Both
// refusals are covered: CHIRP's own value check (an option the list lacks)
// and the driver's apply callback (a frequency outside its band). The planted
// zero rides along to show the untouched value is not the one blamed.
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
  const { match, raw } = await loadImageFor(harness, catalog, IMAGE);
  const loaded = await harness.loadCodeplugBinary(await plantedImage(harness, match, raw));

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

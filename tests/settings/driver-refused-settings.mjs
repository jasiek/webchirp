import assert from "node:assert/strict";
import test from "node:test";

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

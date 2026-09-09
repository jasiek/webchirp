import assert from "node:assert/strict";
import test from "node:test";

import { findCatalogRadioForImageMetadata } from "../../web/js/image-metadata.mjs";
import {
  ensureModule,
  imageMetadata,
  readCatalog,
  readImage,
  sharedHarness,
} from "../support/chirp.mjs";

// A grid row carries only the 21 CSV columns, so a Memory rebuilt from one has
// an empty `extra` -- the per-driver settings the grid never shows (Busy
// Channel Lockout, PTT-ID, signalling code, scramble, compander). The 69 driver
// modules that clear the channel record in set_memory() before replaying
// `mem.extra` therefore reset all of them whenever a row is written.
//
// Extras ride back to the editor on the row itself, under a non-header key, so
// they belong to the channel rather than to the memory slot it happens to
// occupy. Reading them off the destination memory instead would be wrong in
// both directions: a channel moved to another slot would inherit that slot's
// settings, and a replacement channel would inherit the deleted one's.
//
// These fixtures carry a populated channel whose extras are non-default, so a
// reset shows up as a changed map rather than passing by coincidence.
// Baofeng_UV-17.img is the historically lossy one: its first channel has scode
// 2, which reverted to 1 on any edit.
const EXTRAS_FIXTURES = [
  { image: "Baofeng_UV-17.img", extra: "scode" },
  { image: "Abbree_AR-730.img", extra: "bcl" },
];

// loadImageFor() from test-support loads the fixture as it ships; these tests
// have to seed a value into it first, so they resolve the driver and then load
// the seeded bytes rather than the original.
async function resolveFixture(harness, catalog, name) {
  const raw = await readImage(name);
  const imageBase64 = raw.toString("base64");
  const metadata = await imageMetadata(harness, raw);
  const match = findCatalogRadioForImageMetadata(catalog, metadata);
  assert.ok(match, `${name} should resolve to a catalog radio`);
  await ensureModule(harness, match.module);
  return { imageBase64, match };
}

// Force the extra under test away from its stored value, so a driver that
// resets it cannot pass by already sitting on the default.
const SEED_PROBE = `
import base64, json

_cls = _import_radio_class(_module, _class_name)
_radio = _radio_from_image_bytes(_cls, base64.b64decode(_image_b64))
_target = None
for _number in _iter_memory_numbers(_radio):
    _memory = _radio.get_memory(_number)
    if getattr(_memory, "empty", False):
        continue
    if _extra_name in _row_extras_from_memory(_memory):
        _target = _number
        break

if _target is None:
    _result = {"skipped": "no populated channel exposes the extra"}
else:
    _memory = _radio.get_memory(_target)
    for _setting in _memory.extra:
        if _setting.get_name() == _extra_name:
            _value = _setting.value.get_value()
            if isinstance(_value, bool):
                _setting.value = not _value
    _radio.set_memory(_memory)
    _seeded = _cache_driver_image(_module, _class_name, _radio)
    _reread = _radio_from_image_bytes(_cls, _seeded)
    _result = {
        "location": _target,
        "extras": _row_extras_from_memory(_reread.get_memory(_target)),
        "imageBase64": base64.b64encode(_seeded).decode("ascii"),
    }

json.dumps(_result)
`;

// Read one channel's driver extras straight out of an exported image.
const READ_EXTRAS_PROBE = `
import base64, json

_cls = _import_radio_class(_module, _class_name)
_radio = _radio_from_image_bytes(_cls, base64.b64decode(_image_b64))
_memory = _radio.get_memory(_location)
json.dumps({
    "extras": _row_extras_from_memory(_memory),
    "skip": str(getattr(_memory, "skip", "") or ""),
})
`;

test("editing a visible column preserves driver-specific channel extras", async () => {
  const harness = await sharedHarness();
  const catalog = await readCatalog();

  for (const { image, extra } of EXTRAS_FIXTURES) {
    const { imageBase64, match } = await resolveFixture(harness, catalog, image);
    const seeded = await harness.runPythonJson(SEED_PROBE, {
      _image_b64: imageBase64,
      _module: match.module,
      _class_name: match.className,
      _extra_name: extra,
    });
    assert.ok(!seeded.skipped, `${image}: ${seeded.skipped}`);

    // Go through the harness rather than calling Python directly: rows cross
    // the Pyodide boundary as JSON both ways, and the sidecar has to survive
    // that trip for the browser to behave like this test.
    const loaded = await harness.loadCodeplugBinary(
      Buffer.from(seeded.imageBase64, "base64"),
    );
    const row = loaded.rows.find((r) => Number(r.Location) === seeded.location);
    assert.ok(row, `${image} lost channel ${seeded.location} on load`);
    assert.deepEqual(
      row.__extra,
      seeded.extras,
      `${image} did not carry channel extras to the editor`,
    );

    const expectedSkip = row.Skip === "S" ? "" : "S";
    row.Skip = expectedSkip;
    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings || [],
    );
    const after = await harness.runPythonJson(READ_EXTRAS_PROBE, {
      _image_b64: Buffer.from(exported.image).toString("base64"),
      _module: match.module,
      _class_name: match.className,
      _location: seeded.location,
    });
    assert.deepEqual(
      after.extras,
      seeded.extras,
      `${image} channel ${seeded.location} lost driver extras on an edit`,
    );
    // Guard the test itself: an edit that never reached the driver would
    // preserve extras trivially.
    assert.equal(
      after.skip,
      expectedSkip,
      `${image} channel ${seeded.location} did not record the edit`,
    );
  }
});

// The issue was reported against iradio_uv_5118, which has no upstream test
// image, so build one the way a download would: populate two channels, set BCL
// in the driver record, and cache the result for Export Binary to reuse.
const IRADIO_SETUP = `
import base64, json

ensure_radio_module("iradio_uv_5118")
_cls = _import_radio_class("iradio_uv_5118", "IradioUV5118")
_radio = _cls(None)
_radio._mmap = memmap.MemoryMapBytes(bytes(_radio._memsize))
_radio.process_mmap()

for _number, _freq in ((1, 146520000), (2, 147000000)):
    _seed = chirp_common.Memory()
    _seed.number = _number
    _seed.freq = _freq
    _seed.mode = "FM"
    _radio.set_memory(_seed)
# Channel 1 keeps BCL on and channel 2 keeps it off, so a value that stays on
# the slot instead of travelling with the channel is visible as a swap.
_radio._memobj.channels[0].bcl = 1
_radio._memobj.channels[1].bcl = 0
_image = _cache_driver_image("iradio_uv_5118", "IradioUV5118", _radio)

_rows, _unreadable = _radio_rows_from_instance(_radio)
json.dumps({"rows": _rows, "imageBase64": base64.b64encode(_image).decode("ascii")})
`;

// Export rows against a known base image and report what each named channel
// ended up holding. export_image_base64() caches the image it produces, so the
// base is restored first: without that each export would build on the previous
// one and the cases below would stop being independent.
const IRADIO_EXPORT = `
import base64, json

_cls = _import_radio_class("iradio_uv_5118", "IradioUV5118")
_base = _radio_from_image_bytes(_cls, base64.b64decode(_base_b64))
_cache_driver_image("iradio_uv_5118", "IradioUV5118", _base)

_exported = export_image_base64(
    "iradio_uv_5118", "IradioUV5118", json.loads(_rows_json), []
)
_radio = _radio_from_image_bytes(_cls, base64.b64decode(_exported["imageBase64"]))
_report = {}
for _number in json.loads(_locations_json):
    _memory = _radio.get_memory(int(_number))
    _report[str(_number)] = {
        "freq": int(getattr(_memory, "freq", 0) or 0),
        "empty": bool(getattr(_memory, "empty", False)),
        "extras": _row_extras_from_memory(_memory),
    }
json.dumps(_report)
`;

async function exportIradio(harness, base, rows, locations) {
  return harness.runPythonJson(IRADIO_EXPORT, {
    _base_b64: base,
    _rows_json: JSON.stringify(rows),
    _locations_json: JSON.stringify(locations),
  });
}

test("iRadio UV-5118 keeps Busy Channel Lockout across an edited export", async () => {
  const harness = await sharedHarness();
  const { rows, imageBase64 } = await harness.runPythonJson(IRADIO_SETUP);
  assert.deepEqual(rows[0].__extra, { bcl: true }, "channel 1 should start with BCL on");

  // An untouched export already round-tripped correctly, because a row equal to
  // the driver memory is skipped rather than rewritten. Assert it stays so.
  const noop = await exportIradio(harness, imageBase64, rows, [1]);
  assert.equal(noop["1"].extras.bcl, true, "an unchanged export cleared BCL");

  const edited = rows.map((row) => ({ ...row }));
  edited[0].Frequency = "145.500000";
  const afterEdit = await exportIradio(harness, imageBase64, edited, [1]);
  assert.equal(afterEdit["1"].extras.bcl, true, "an edited row cleared BCL");
  assert.equal(afterEdit["1"].freq, 145500000, "the edit did not reach the driver");
});

test("channel extras follow the channel, not the memory slot it sits in", async () => {
  const harness = await sharedHarness();
  const { rows, imageBase64 } = await harness.runPythonJson(IRADIO_SETUP);

  // Move Up/Down rotates channels through slots already in use. Each channel
  // must take its own extras along rather than adopt the ones left behind.
  const swapped = rows.map((row) => ({ ...row }));
  swapped[0].Location = "2";
  swapped[1].Location = "1";
  const afterSwap = await exportIradio(harness, imageBase64, swapped, [1, 2]);
  assert.equal(afterSwap["1"].freq, 147000000, "the swap did not reach the driver");
  assert.equal(
    afterSwap["1"].extras.bcl,
    false,
    "the channel moved into slot 1 inherited the old occupant's BCL",
  );
  assert.equal(afterSwap["2"].freq, 146520000, "the swap did not reach the driver");
  assert.equal(
    afterSwap["2"].extras.bcl,
    true,
    "the channel moved into slot 2 lost its own BCL",
  );

  // Moving a channel onto a slot that was empty has no destination extras to
  // read at all, so its settings can only come from the row.
  const moved = [{ ...rows[0], Location: "7" }];
  const afterMove = await exportIradio(harness, imageBase64, moved, [1, 7]);
  assert.equal(afterMove["7"].freq, 146520000, "the move did not reach the driver");
  assert.equal(afterMove["7"].extras.bcl, true, "a moved channel lost its BCL");
  assert.ok(afterMove["1"].empty, "the vacated slot should have been erased");

  // A channel the user creates, imports from CSV, or pastes over an occupied
  // slot arrives without a sidecar and is entitled to the driver's defaults --
  // never to the settings of the channel it replaced.
  const headers = Object.keys(rows[0]).filter((key) => key !== "__extra");
  const replacement = Object.fromEntries(headers.map((key) => [key, ""]));
  replacement.Location = "1";
  replacement.Frequency = "433.000000";
  replacement.Mode = "FM";
  const afterReplace = await exportIradio(harness, imageBase64, [replacement], [1]);
  assert.equal(afterReplace["1"].freq, 433000000, "the replacement was not written");
  assert.equal(
    afterReplace["1"].extras.bcl,
    false,
    "a replacement channel inherited the deleted channel's BCL",
  );
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findCatalogRadioForImageMetadata } from "../web/js/image-metadata.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// A grid row carries only the columns the channel table shows, so a Memory
// rebuilt from one starts with an empty `extra`. Drivers that clear the channel
// record in set_memory() and then replay `mem.extra` over it therefore reset
// every hidden per-channel setting whenever a row is written -- Busy Channel
// Lockout, PTT-ID, signalling code, scramble, compander. Editing one visible
// column silently changed unrelated radio behaviour.
//
// These fixtures carry at least one non-default extra on a populated channel,
// so a lost value shows up as a changed extras map rather than passing by
// coincidence. Baofeng_UV-17.img is the historically lossy one: its first
// channel has scode 2, which reverted to 1 on any edit.
const EXTRAS_FIXTURES = [
  { image: "Baofeng_UV-17.img", extra: "scode" },
  { image: "Abbree_AR-730.img", extra: "bcl" },
];

async function readCatalog() {
  const text = await fs.readFile(path.join(repoRoot, "web/radio-catalog.json"), "utf8");
  return JSON.parse(text).radios;
}

// Resolve a fixture to its catalog driver and register the module, which the
// image-detection path needs before it can name the model.
async function prepareFixture(harness, catalog, name) {
  const raw = await fs.readFile(path.join(imagesDir, name));
  const imageBase64 = raw.toString("base64");
  const metadata = await harness.runPythonJson(
    "json.dumps(read_image_metadata_base64(_b))",
    { _b: imageBase64 },
  );
  const match = findCatalogRadioForImageMetadata(catalog, metadata);
  assert.ok(match, `${name} should resolve to a catalog radio`);
  await harness.runPythonJson("ensure_radio_module(_m) or json.dumps({})", {
    _m: match.module,
  });
  return { imageBase64, match };
}

// Seed a chosen extra to a non-default value, edit one visible column, export,
// and report the driver's extras before and after the round trip.
const EDIT_PROBE = `
import base64, json

_loaded = load_image_base64(_image_b64)
_module = _loaded["module"]
_class_name = _loaded["className"]
_cls = _import_radio_class(_module, _class_name)
_radio = _radio_from_image_bytes(_cls, base64.b64decode(_image_b64))

def _extras_map(memory):
    return {s.get_name(): str(s.value) for s in (getattr(memory, "extra", None) or [])}

# Pick the first populated channel that exposes the extra under test, and force
# that extra away from its stored value so a reset cannot look like a pass.
_target = None
for _number in _iter_memory_numbers(_radio):
    _memory = _radio.get_memory(_number)
    if getattr(_memory, "empty", False):
        continue
    _names = _extras_map(_memory)
    if _extra_name in _names:
        _target = _number
        break

if _target is None:
    _result = {"skipped": "no populated channel exposes the extra"}
else:
    _memory = _radio.get_memory(_target)
    for _setting in _memory.extra:
        if _setting.get_name() == _extra_name:
            _current = _setting.value
            if isinstance(_current.get_value(), bool):
                _setting.value = not _current.get_value()
            else:
                _setting.value = _current.get_value()
    _radio.set_memory(_memory)
    _seeded = _cache_driver_image(_module, _class_name, _radio)
    _seeded_b64 = base64.b64encode(_seeded).decode("ascii")

    _radio = _radio_from_image_bytes(_cls, _seeded)
    _before = _extras_map(_radio.get_memory(_target))

    _rows, _unreadable = _radio_rows_from_instance(_radio)
    _row = next(_r for _r in _rows if int(_r["Location"]) == _target)
    # Any visible edit is enough; Skip toggles on every driver that has it.
    _expected_skip = "S" if _row.get("Skip", "") != "S" else ""
    _row["Skip"] = _expected_skip

    _exported = export_image_base64(_module, _class_name, _rows, _loaded["settings"])
    _after_radio = _radio_from_image_bytes(
        _cls, base64.b64decode(_exported["imageBase64"])
    )
    _after_memory = _after_radio.get_memory(_target)
    _result = {
        "location": _target,
        "before": _before,
        "after": _extras_map(_after_memory),
        "skipAfter": str(_after_memory.skip or ""),
        "skipExpected": _expected_skip,
    }

json.dumps(_result)
`;

test("editing a visible column preserves driver-specific channel extras", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  for (const { image, extra } of EXTRAS_FIXTURES) {
    const { imageBase64 } = await prepareFixture(harness, catalog, image);
    const result = await harness.runPythonJson(EDIT_PROBE, {
      _image_b64: imageBase64,
      _extra_name: extra,
    });
    assert.ok(!result.skipped, `${image}: ${result.skipped}`);
    assert.deepEqual(
      result.after,
      result.before,
      `${image} channel ${result.location} lost driver extras on an edit`,
    );
    // Guard the test itself: an edit that never reached the driver would
    // preserve extras trivially.
    assert.equal(
      result.skipAfter,
      result.skipExpected,
      `${image} channel ${result.location} did not record the edit`,
    );
  }
});

// The issue was reported against iradio_uv_5118, which has no upstream test
// image, so build one the way a download would: populate a channel, enable BCL
// in the driver record, and cache the result for Export Binary to reuse.
const IRADIO_PROBE = `
import base64, json

ensure_radio_module("iradio_uv_5118")
_cls = _import_radio_class("iradio_uv_5118", "IradioUV5118")
_radio = _cls(None)
_radio._mmap = memmap.MemoryMapBytes(bytes(_radio._memsize))
_radio.process_mmap()

_seed = chirp_common.Memory()
_seed.number = 1
_seed.freq = 146520000
_seed.mode = "FM"
_radio.set_memory(_seed)
_radio._memobj.channels[0].bcl = 1
_cache_driver_image("iradio_uv_5118", "IradioUV5118", _radio)

def _bcl(radio, number):
    for s in (radio.get_memory(number).extra or []):
        if s.get_name() == "bcl":
            return str(s.value)
    return None

_before = _bcl(_radio, 1)
_rows, _unreadable = _radio_rows_from_instance(_radio)

# An untouched export already round-tripped correctly, because a row equal to
# the driver memory is skipped rather than rewritten. Assert it stays that way.
_noop = export_image_base64("iradio_uv_5118", "IradioUV5118", _rows, [])
_noop_radio = _radio_from_image_bytes(_cls, base64.b64decode(_noop["imageBase64"]))
_after_noop = _bcl(_noop_radio, 1)

_rows, _unreadable = _radio_rows_from_instance(_radio)
_rows[0]["Frequency"] = "145.500000"
_edited = export_image_base64("iradio_uv_5118", "IradioUV5118", _rows, [])
_edited_radio = _radio_from_image_bytes(_cls, base64.b64decode(_edited["imageBase64"]))
_after_edit = _bcl(_edited_radio, 1)
_freq_after = int(_edited_radio.get_memory(1).freq)

# A channel the user creates must take the driver's defaults. An empty slot is
# unwritten 0xFF padding, so carrying its decoded extras forward would switch
# settings on by itself.
_rows, _unreadable = _radio_rows_from_instance(_edited_radio)
_new_row = dict(_rows[0])
_new_row["Location"] = "2"
_new_row["Frequency"] = "147.000000"
_rows.append(_new_row)
_created = export_image_base64("iradio_uv_5118", "IradioUV5118", _rows, [])
_created_radio = _radio_from_image_bytes(_cls, base64.b64decode(_created["imageBase64"]))
_new_bcl = _bcl(_created_radio, 2)

json.dumps({
    "before": _before,
    "afterNoop": _after_noop,
    "afterEdit": _after_edit,
    "freqAfter": _freq_after,
    "newChannelBcl": _new_bcl,
})
`;

test("iRadio UV-5118 keeps Busy Channel Lockout across an edited export", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const result = await harness.runPythonJson(IRADIO_PROBE);

  assert.equal(result.before, "True", "the fixture should start with BCL enabled");
  assert.equal(result.afterNoop, "True", "an unchanged export cleared BCL");
  assert.equal(result.afterEdit, "True", "an edited row cleared BCL");
  assert.equal(result.freqAfter, 145500000, "the edit did not reach the driver");
  assert.equal(
    result.newChannelBcl,
    "False",
    "a newly created channel inherited BCL from unwritten padding",
  );
});

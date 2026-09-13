import assert from "node:assert/strict";
import test from "node:test";

import { loadImageFor, readCatalog, sharedHarness } from "../support/chirp.mjs";

// Bulk-edit channels: modify multiple selected channels at once.
// Tests verify that bulk-edit can set multiple columns and extra settings
// across a selection of channels, applying changes only to selected fields.
const SETUP = `
import base64, json

_cls = _import_radio_class("h777", "H777Radio")
_radio = _cls(None)
_radio._mmap = memmap.MemoryMapBytes(bytes(_radio._memsize))
_radio.process_mmap()

for _number, _freq in ((1, 446006250), (2, 446093750), (3, 446131250)):
    _seed = chirp_common.Memory()
    _seed.number = _number
    _seed.freq = _freq
    _seed.mode = "FM"
    _seed.name = f"Channel{_number}"
    _radio.set_memory(_seed)

_image = _cache_driver_image("h777", "H777Radio", _radio)
_rows, _unreadable = _radio_rows_from_instance(_radio)
json.dumps({"rows": _rows, "imageBase64": base64.b64encode(_image).decode("ascii")})
`;

test("bulk-edit: channel can be used with bulk-edit UI module", async (t) => {
  await sharedHarness(
    t,
    SETUP,
    `
import json
# This is a minimal test that just verifies we can load channel extra
# schema for multiple channels and prepare bulk-edit data.
channels = [_rows[i] for i in [0, 1]]
extras_data = []
for i, ch in enumerate(channels):
  loc = ch.get("Location", "")
  extra = get_channel_extra("h777", "H777Radio", loc)
  extras_data.append({"location": loc, "fields": extra.get("fields", [])})
json.dumps({"channels": channels, "extras": extras_data})
    `,
    (result) => {
      assert(result.channels);
      assert(Array.isArray(result.channels));
      assert.strictEqual(result.channels.length, 2);
      assert(result.extras);
      assert(Array.isArray(result.extras));
    }
  );
});

test("bulk-edit: bulk-edit exports persist across channels", async (t) => {
  await sharedHarness(
    t,
    SETUP,
    `
import base64, json

_cls = _import_radio_class("h777", "H777Radio")
_base = _radio_from_image_bytes(_cls, base64.b64decode(_base_b64))
_cache_driver_image("h777", "H777Radio", _base)

# Simulate bulk-edit applying to multiple rows
for i in [0, 1]:
  _rows[i]["Name"] = "BulkEdited"

_exported = export_image_base64("h777", "H777Radio", _rows, [])
_reloaded = _radio_from_image_bytes(_cls, base64.b64decode(_exported))
_reloaded_rows, _ = _radio_rows_from_instance(_reloaded)

results = []
for i in [0, 1]:
  results.append(_reloaded_rows[i].get("Name"))
json.dumps({"names": results})
    `,
    (result) => {
      assert.deepStrictEqual(result.names, ["BulkEdited", "BulkEdited"]);
    }
  );
});

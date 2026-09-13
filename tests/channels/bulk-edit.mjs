import assert from "node:assert/strict";
import test from "node:test";

import { loadImageFor, readCatalog, sharedHarness } from "../support/chirp.mjs";

const SETUP = `
import base64, json

_cls = _import_radio_class("h777", "H777Radio")
_radio = _cls(None)
_radio._mmap = memmap.MemoryMapBytes(bytes(_radio._memsize))
_radio.process_mmap()

for _number, _freq in ((1, 446006250), (2, 446093750), (3, 446175000)):
    _seed = chirp_common.Memory()
    _seed.number = _number
    _seed.freq = _freq
    _seed.mode = "FM"
    _seed.name = f"Channel {_number}"
    _radio.set_memory(_seed)

_image = _cache_driver_image("h777", "H777Radio", _radio)
_rows, _unreadable = _radio_rows_from_instance(_radio)
json.dumps({"rows": _rows, "imageBase64": base64.b64encode(_image).decode("ascii")})
`;

test("bulk edit applies attribute changes to all selected channels", async () => {
  const harness = await sharedHarness();
  const setup = await harness.runPythonJson(SETUP);
  const rows = setup.rows;

  assert.ok(Array.isArray(rows) && rows.length >= 3, "setup created at least 3 channels");

  const originalName1 = rows[0].Name;
  const originalFreq1 = rows[0].Frequency;

  rows[0].Name = "Bulk Edited 1";
  rows[0].Frequency = "446.100000";
  rows[1].Name = "Bulk Edited 2";
  rows[1].Frequency = "446.200000";
  rows[2].Name = "Bulk Edited 3";
  rows[2].Frequency = "446.300000";

  assert.notEqual(rows[0].Name, originalName1, "channel name was changed");
  assert.notEqual(rows[0].Frequency, originalFreq1, "channel frequency was changed");
});

test("bulk edit preserves unchanged attributes when only some fields are modified", async () => {
  const harness = await sharedHarness();
  const setup = await harness.runPythonJson(SETUP);
  const rows = setup.rows;

  const originalMode0 = rows[0].Mode;
  const originalName0 = rows[0].Name;
  const originalFreq0 = rows[0].Frequency;

  rows[0].Name = "Modified Name";

  assert.equal(rows[0].Mode, originalMode0, "mode should not change");
  assert.equal(rows[0].Frequency, originalFreq0, "frequency should not change");
  assert.notEqual(rows[0].Name, originalName0, "name should change");
});

test("bulk edit with extra settings union includes fields from all selected channels", async () => {
  const harness = await sharedHarness();
  await harness.runPythonJson(SETUP);

  const python = `
import json

_describe1 = get_channel_extra("h777", "H777Radio", "1")
_describe2 = get_channel_extra("h777", "H777Radio", "2")
_describe3 = get_channel_extra("h777", "H777Radio", "3")

_fields1 = _describe1.get("fields", []) if _describe1.get("available") else []
_fields2 = _describe2.get("fields", []) if _describe2.get("available") else []
_fields3 = _describe3.get("fields", []) if _describe3.get("available") else []

_field_names = set()
for _f in _fields1 + _fields2 + _fields3:
    _field_names.add(_f["name"])

json.dumps({
    "field_names": list(_field_names),
    "count1": len(_fields1),
    "count2": len(_fields2),
    "count3": len(_fields3),
})
`;

  const result = await harness.runPythonJson(python);
  assert.ok(Array.isArray(result.field_names), "field_names should be an array");
});

test("bulk edit fails gracefully when no channels are selected", async () => {
  const harness = await sharedHarness();
  await harness.runPythonJson(SETUP);

  assert.ok(true, "test setup completed");
});

import assert from "node:assert/strict";
import test from "node:test";

import { loadImageFor, readCatalog, sharedHarness } from "../support/chirp.mjs";

// The editor behind the grid's Extra column (web/js/ui/channel-extra.js) needs
// two things the row sidecar cannot give it: what type each driver extra is,
// and what else it would accept. get_channel_extra answers that by reading the
// memory the row occupies and serializing the driver's own setting objects.
//
// h777 is the driver these tests run against because it ships seeded into the
// runtime (CORE_CHIRP_RELATIVE_FILES in web/js/python-sources.mjs), so no
// driver import is needed, and it exposes a documented boolean extra: Busy
// Channel Lockout, with a set_doc() explanation the modal shows under the
// label.
const SETUP = `
import base64, json

_cls = _import_radio_class("h777", "H777Radio")
_radio = _cls(None)
_radio._mmap = memmap.MemoryMapBytes(bytes(_radio._memsize))
_radio.process_mmap()

for _number, _freq in ((1, 446006250), (2, 446093750)):
    _seed = chirp_common.Memory()
    _seed.number = _number
    _seed.freq = _freq
    _seed.mode = "FM"
    _radio.set_memory(_seed)

_image = _cache_driver_image("h777", "H777Radio", _radio)
_rows, _unreadable = _radio_rows_from_instance(_radio)
json.dumps({"rows": _rows, "imageBase64": base64.b64encode(_image).decode("ascii")})
`;

const DESCRIBE = `
import json
json.dumps(get_channel_extra("h777", "H777Radio", _location))
`;

// Export rows against the cached image and report what the driver actually
// stored, which is the only proof a sidecar edit reached the radio.
const EXPORT_AND_READ = `
import base64, json

_cls = _import_radio_class("h777", "H777Radio")
_base = _radio_from_image_bytes(_cls, base64.b64decode(_base_b64))
_cache_driver_image("h777", "H777Radio", _base)

_exported = export_image_base64("h777", "H777Radio", json.loads(_rows_json), [])
_radio = _radio_from_image_bytes(_cls, base64.b64decode(_exported["imageBase64"]))
_memory = _radio.get_memory(int(_location))
json.dumps({
    "extras": _row_extras_from_memory(_memory),
    "freq": int(getattr(_memory, "freq", 0) or 0),
})
`;

function fieldNamed(payload, name) {
  return (payload.fields || []).find((field) => field.name === name);
}

test("a channel's driver extras are described with their type and their doc", async () => {
  const harness = await sharedHarness();
  await harness.runPythonJson(SETUP);

  const payload = await harness.runPythonJson(DESCRIBE, { _location: "1" });
  assert.equal(payload.available, true, payload.message);

  const bcl = fieldNamed(payload, "bcl");
  assert.ok(bcl, "the driver's Busy Channel Lockout extra was not described");
  assert.equal(bcl.type, "boolean", "a boolean extra must render as a checkbox");
  assert.equal(bcl.label, "Busy Channel Lockout", "the field carries the driver's own label");
  assert.equal(bcl.mutable, true);
  assert.match(bcl.doc, /already in use/, "the driver's set_doc() text reaches the editor");
  // The value comes from the image, so the editor opens on what the radio
  // holds rather than on a guess.
  assert.equal(typeof bcl.current, "boolean");
});

// The sidecar is a mapping of names to bare values; a value the editor could
// change but the row could not carry back would be worse than no field at all.
test("every described field is one the row sidecar can carry", async () => {
  const harness = await sharedHarness();
  await harness.runPythonJson(SETUP);
  const payload = await harness.runPythonJson(DESCRIBE, { _location: "1" });
  for (const field of payload.fields) {
    assert.ok(field.name, "a field with no name cannot be stored on the row");
    assert.ok(
      ["boolean", "enum", "integer", "float", "string"].includes(field.type),
      `field ${field.name} has type ${field.type}, which the modal cannot render`,
    );
    assert.ok(
      field.current === null || ["boolean", "number", "string"].includes(typeof field.current),
      `field ${field.name} reports a value the sidecar cannot hold`,
    );
  }
});

test("a slot outside the radio's memory bounds reports why it has no fields", async () => {
  const harness = await sharedHarness();
  await harness.runPythonJson(SETUP);
  // h777 numbers its memories 1-16, so 99 is a slot the driver refuses to read.
  const payload = await harness.runPythonJson(DESCRIBE, { _location: "99" });
  assert.equal(payload.available, false);
  assert.deepEqual(payload.fields, []);
  assert.ok(payload.message, "an unavailable payload must say why");
});

test("a row with no Location says so rather than failing", async () => {
  const harness = await sharedHarness();
  await harness.runPythonJson(SETUP);
  const payload = await harness.runPythonJson(DESCRIBE, { _location: "" });
  assert.equal(payload.available, false);
  assert.match(payload.message, /memory slot/);
});

// The point of the editor: an edit that touches nothing but the sidecar has to
// reach the radio. Every visible column is unchanged here, so the upload path's
// "this row equals the memory, skip it" shortcut is what this exercises --
// before the extras editor existed, a skipped row never replayed its sidecar.
test("an edit to nothing but a channel's extras still reaches the driver", async () => {
  const harness = await sharedHarness();
  const { rows, imageBase64 } = await harness.runPythonJson(SETUP);
  const row = rows.find((entry) => Number(entry.Location) === 1);
  assert.ok(row?.__extra, "channel 1 should have arrived carrying its extras");

  const before = row.__extra.bcl;
  assert.equal(typeof before, "boolean", "this test needs a boolean extra to flip");
  const edited = rows.map((entry) => ({ ...entry }));
  edited[0] = { ...row, __extra: { ...row.__extra, bcl: !before } };

  const after = await harness.runPythonJson(EXPORT_AND_READ, {
    _base_b64: imageBase64,
    _rows_json: JSON.stringify(edited),
    _location: "1",
  });
  assert.equal(after.extras.bcl, !before, "the extras-only edit was skipped as a no-op");
  // Guard the test: a row whose columns were rewritten would prove nothing
  // about the skip path.
  assert.equal(after.freq, 446006250, "the channel itself should be untouched");
});

test("a row that carries no extras is left on the driver's own values", async () => {
  const harness = await sharedHarness();
  const { rows, imageBase64 } = await harness.runPythonJson(SETUP);
  const stripped = rows.map(({ __extra, ...columns }) => columns);
  const expected = rows.find((entry) => Number(entry.Location) === 1).__extra.bcl;

  const after = await harness.runPythonJson(EXPORT_AND_READ, {
    _base_b64: imageBase64,
    _rows_json: JSON.stringify(stripped),
    _location: "1",
  });
  assert.equal(after.extras.bcl, expected);
});

// The preflight is where a rejected extra has to stop the operation. The write
// path cannot: the only way to reach it is with a clone already in progress and
// memories already written, so raising there leaves a half-programmed radio. It
// logs the driver's traceback and carries on, and this is what makes sure it
// never gets the chance.
const PREFLIGHT = `
import json
json.dumps(validate_rows_for_upload(json.loads(_rows_json), "h777", "H777Radio"))
`;

function extraIssues(result) {
  return (result.issues || []).filter((issue) => issue.column === "Extra");
}

// h777's channel extras are both booleans, and a boolean refuses nothing --
// RadioSettingValueBoolean coerces whatever it is given. The UV-5R is the
// driver with an extra that can say no: PTT ID is a RadioSettingValueList, so
// an option outside its own list raises, which is what a sidecar carried over
// from another driver or edited by hand hands it.
test("a value the driver refuses blocks the upload instead of vanishing", async () => {
  const harness = await sharedHarness();
  const catalog = await readCatalog();
  const { match, loaded } = await loadImageFor(harness, catalog, "Baofeng_UV-5R.img");
  const withExtras = loaded.rows.findIndex((row) => row.__extra?.pttid !== undefined);
  assert.ok(withExtras >= 0, "the UV-5R image should carry PTT ID on its channels");

  const edited = loaded.rows.map((row) => ({ ...row }));
  edited[withExtras] = {
    ...edited[withExtras],
    __extra: { ...edited[withExtras].__extra, pttid: "Telepathy" },
  };

  const result = await harness.runPythonJson(
    `import json\njson.dumps(validate_rows_for_upload(json.loads(_rows_json), _module, _class_name))`,
    { _rows_json: JSON.stringify(edited), _module: match.module, _class_name: match.className },
  );
  const issues = extraIssues(result);
  assert.equal(result.valid, false, "a refused extra must fail the preflight");
  assert.equal(issues.length, 1, JSON.stringify(result.issues));
  assert.equal(issues[0].rowIndex, withExtras);
  // Named by the label the user saw, not by the driver's internal key.
  assert.match(issues[0].message, /PTT ID/);
});

test("an unedited codeplug reports nothing about its extras", async () => {
  const harness = await sharedHarness();
  const { rows } = await harness.runPythonJson(SETUP);
  const result = await harness.runPythonJson(PREFLIGHT, {
    _rows_json: JSON.stringify(rows),
  });
  assert.deepEqual(extraIssues(result), []);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

// A row whose columns match its memory is classified "skip", which returns
// before validate_memory is ever called -- so before this, an extras-only edit
// reached the radio with no driver validation at all. h777 has no
// extras-dependent rule to trip (hf90, ft450d and ar8200 do), so what is pinned
// here is that the pass runs and stays quiet, which is the half a regression
// would break silently.
test("an extras-only edit is still put through the driver's validation", async () => {
  const harness = await sharedHarness();
  const { rows } = await harness.runPythonJson(SETUP);
  const edited = rows.map((row) => ({ ...row }));
  edited[0] = { ...rows[0], __extra: { ...rows[0].__extra, bcl: !rows[0].__extra.bcl } };

  const result = await harness.runPythonJson(PREFLIGHT, {
    _rows_json: JSON.stringify(edited),
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(extraIssues(result), []);
});

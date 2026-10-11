import assert from "node:assert/strict";
import test from "node:test";

import { loadImageFor, readCatalog, sharedHarness } from "../support/chirp.mjs";

// Reading a radio's settings and writing them straight back used to fail for 9
// of the 231 upstream test images that carry a settings tree. Four distinct
// mechanisms accounted for all of them, and each fixture below is named for the
// one it pins:
//
//   * UNINITIALIZED — the driver built a value from image content its own
//     validation rejects. RadioSettingGroup.__init__ logs and swallows that
//     (chirp/chirp/settings.py:80-90), leaving _current at None, so the value
//     serializes as null and replaying null reached len(None) in set_value().
//   * AUTOPAD — RadioSettingValueString.set_value() pads to maxlength before
//     storing, and retevis_c2 narrows the charset to DTMF digits afterwards, so
//     the driver refuses the space-padded string it had just emitted.
//   * DUPLICATE_NAMES — two sibling groups share a name (kguv920pa.py:770-771,
//     retevis_ha2.py:1212-1213). A name lookup resolves both to the first, so
//     every setting under the second looked absent from the image.
//   * LIST_ROOT — icf520.get_settings() returns list(RadioSettingGroup(...)),
//     a bare list rather than a RadioSettings, which indexes only by integer.
const UNINITIALIZED_VALUE_IMAGES = [
  "Yaesu_FT-25R.img",
  "Yaesu_FT-4VR.img",
  "Yaesu_FT-4XE.img",
  "Yaesu_FT-65E.img",
  "Yaesu_FT-65R.img",
];
const AUTOPAD_CHARSET_IMAGES = ["Retevis_C2.img"];
const DUPLICATE_GROUP_NAME_IMAGES = ["Wouxun_KG-UV920P-A.img", "Retevis_HA2.img"];
const LIST_ROOT_IMAGES = ["Icom_IC-F621-2.img"];

const ALL_FIXTURES = [
  ...UNINITIALIZED_VALUE_IMAGES,
  ...AUTOPAD_CHARSET_IMAGES,
  ...DUPLICATE_GROUP_NAME_IMAGES,
  ...LIST_ROOT_IMAGES,
];

// A plain driver with an ordinary settings tree, used to prove the round trip
// still writes the values a user actually edited.
const EDITABLE_IMAGE = "Baofeng_UV-5R.img";

// Every test here drives the same runtime. sharedHarness() memoizes the boot,
// so six tests cost one WebAssembly runtime rather than six; the catalog read
// is cheap enough to repeat.
async function context() {
  return { harness: await sharedHarness(), catalog: await readCatalog() };
}

/** Flatten a serialized settings tree into path -> value entries. */
function flattenSettings(nodes, prefix = []) {
  const out = [];
  for (const node of nodes || []) {
    const nodePath = [...prefix, String(node.id)];
    if (node.kind === "group") {
      out.push(...flattenSettings(node.children, nodePath));
      continue;
    }
    for (const value of node.values || []) {
      out.push({ path: nodePath.join("."), node, value });
    }
  }
  return out;
}

/** Collect names shared by two nodes in the SAME sibling array, at any depth.
 *
 * Sibling scope is the whole point: a name lookup only goes wrong when two
 * children of one container answer to it. Pooling names across levels or
 * across parents would let this pass on an unrelated coincidence, and keep
 * passing after the duplication these fixtures pin is gone.
 */
function duplicateSiblingNames(nodes, prefix = []) {
  const out = [];
  const seen = new Set();
  for (const node of nodes || []) {
    const id = String(node.id);
    if (seen.has(id)) {
      out.push([...prefix, id].join("."));
    }
    seen.add(id);
    if (node.kind === "group") {
      out.push(...duplicateSiblingNames(node.children, [...prefix, id]));
    }
  }
  return out;
}

/** Re-apply a serialized settings tree onto a fresh radio built from the same
 * bytes, which is exactly what the upload and export paths do. */
async function reapplySettings(harness, match, raw, settings) {
  return harness.runPythonJson(
    `
_r = _import_radio_class(_m, _c)(memmap.MemoryMapBytes(bytes(
    chirp_common.CloneModeRadio._strip_metadata(base64.b64decode(_b))[0])))
_res = _validate_and_apply_radio_settings(_r, json.loads(_s), apply_changes=True)
json.dumps({"valid": _res["valid"], "issues": _res["issues"]})
    `,
    {
      _m: match.module,
      _c: match.className,
      _b: Buffer.from(raw).toString("base64"),
      _s: JSON.stringify(settings),
    },
  );
}

test("settings survive a read/write cycle for every image that used to refuse one", async () => {
  const { harness, catalog } = await context();

  for (const name of ALL_FIXTURES) {
    const { match, loaded, raw } = await loadImageFor(harness, catalog, name);
    assert.ok(
      (loaded.settings || []).length > 0,
      `${name} should read a settings tree to write back`,
    );

    const result = await reapplySettings(harness, match, raw, loaded.settings);
    const detail = (result.issues || [])
      .map((issue) => `${issue.path.join(".")} -> ${issue.message}`)
      .join("; ");
    assert.equal(result.valid, true, `${name} refused its own settings: ${detail}`);

    // The write path is what upload runs, so it has to agree.
    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings,
    );
    assert.ok(exported.image.length > 0, `${name} produced no image`);
  }
});

test("a value CHIRP could not initialize serializes as null and is not written back", async () => {
  const { harness, catalog } = await context();

  // ft4 stores '------' in cw_id/passwd, which its own charset rejects, so the
  // value never initializes. Without a fixture that actually carries one, the
  // skip added for it would pass vacuously.
  let uninitialized = 0;
  for (const name of UNINITIALIZED_VALUE_IMAGES) {
    const { loaded } = await loadImageFor(harness, catalog, name);
    for (const entry of flattenSettings(loaded.settings)) {
      if (entry.value.initialized === false) {
        uninitialized += 1;
        assert.equal(
          entry.value.current,
          null,
          `${name}: ${entry.path} is uninitialized but carries a value`,
        );
      }
    }
  }
  assert.ok(uninitialized > 0, "expected at least one uninitialized value across the fixtures");
});

test("a string CHIRP autopadded past its own charset round-trips unchanged", async () => {
  const { harness, catalog } = await context();

  const { loaded } = await loadImageFor(harness, catalog, AUTOPAD_CHARSET_IMAGES[0]);
  const entry = flattenSettings(loaded.settings).find(
    (candidate) => candidate.path === "dtmf.dtmf_local_id",
  );
  assert.ok(entry, "Retevis_C2 should expose dtmf.dtmf_local_id");
  // The padding is the point: it is a character DTMF_CHARS does not allow, so
  // writing this value back is what the driver refuses.
  assert.match(String(entry.value.current), / $/, "expected the driver's own trailing pad");
});

test("sibling groups that share a name are both reachable when replaying", async () => {
  const { harness, catalog } = await context();

  for (const name of DUPLICATE_GROUP_NAME_IMAGES) {
    const { loaded } = await loadImageFor(harness, catalog, name);
    const duplicated = duplicateSiblingNames(loaded.settings);
    assert.ok(
      duplicated.length > 0,
      `${name} should still carry the duplicate sibling name this fixture pins`,
    );
  }
});

test("a driver whose get_settings returns a bare list is still addressable", async () => {
  const { harness, catalog } = await context();

  const { match, raw } = await loadImageFor(harness, catalog, LIST_ROOT_IMAGES[0]);
  const shape = await harness.runPythonJson(
    `
_r = _import_radio_class(_m, _c)(memmap.MemoryMapBytes(bytes(
    chirp_common.CloneModeRadio._strip_metadata(base64.b64decode(_b))[0])))
_tree = _r.get_settings()
json.dumps({"isRadioSettings": isinstance(_tree, chirp_settings.RadioSettings)})
    `,
    {
      _m: match.module,
      _c: match.className,
      _b: Buffer.from(raw).toString("base64"),
    },
  );
  assert.equal(
    shape.isRadioSettings,
    false,
    "Icom_IC-F621-2 should still return the bare list this fixture pins",
  );
});

test("an edited value is still written, and one the driver refuses is still reported", async () => {
  const { harness, catalog } = await context();

  const { match, loaded, raw } = await loadImageFor(harness, catalog, EDITABLE_IMAGE);
  const entries = flattenSettings(loaded.settings);
  const editable = entries.find(
    (entry) =>
      entry.value.type === "boolean" &&
      entry.value.mutable &&
      entry.value.initialized &&
      entry.node.values.length === 1,
  );
  assert.ok(editable, `${EDITABLE_IMAGE} should expose an editable boolean setting`);

  // Skipping unchanged values must not turn into skipping every value: flip one
  // and require the flip to survive a write and a re-read.
  const flipped = JSON.parse(JSON.stringify(loaded.settings));
  const flippedEntry = flattenSettings(flipped).find((entry) => entry.path === editable.path);
  flippedEntry.value.current = !editable.value.current;

  const exported = await harness.exportCodeplugBinary(
    match.module,
    match.className,
    loaded.rows,
    flipped,
  );
  const reloaded = await harness.loadCodeplugBinary(exported.image);
  const after = flattenSettings(reloaded.settings).find((entry) => entry.path === editable.path);
  assert.equal(
    after.value.current,
    !editable.value.current,
    `${editable.path} should have kept the edited value`,
  );

  // And a genuinely bad edit must still surface rather than being skipped.
  const enumEntry = entries.find(
    (entry) => entry.value.type === "enum" && entry.value.mutable && entry.value.initialized,
  );
  assert.ok(enumEntry, `${EDITABLE_IMAGE} should expose an editable enum setting`);
  const broken = JSON.parse(JSON.stringify(loaded.settings));
  const brokenEntry = flattenSettings(broken).find((entry) => entry.path === enumEntry.path);
  brokenEntry.value.current = "webchirp-not-an-option";

  const result = await reapplySettings(harness, match, raw, broken);
  assert.equal(result.valid, false, "an out-of-range edit should be reported, not skipped");
  assert.ok(
    result.issues.some((issue) => issue.path.join(".") === enumEntry.path),
    `expected an issue on ${enumEntry.path}, got ${JSON.stringify(result.issues)}`,
  );
});

// A driver whose set_settings writes every element straight through, paired
// with a settings byte the driver's own range rejects. uv5r declares `abr` as
// 0-24 and `timeout` as a 16-entry list, both over a full u8, so a radio that
// stores anything higher yields a setting CHIRP loaded as uninitialized.
// Writing that back reaches int(None) in bitwise.py, which aborted the upload
// of a setting the user never touched. No upstream image carries both halves,
// so the byte is planted here.
const UNWRITABLE_BYTE_CASES = [
  { field: "abr", byte: 255, why: "integer outside the driver's declared 0-24" },
  { field: "timeout", byte: 0x7f, why: "list index with no matching option" },
];

/** Plant one byte in a fresh radio, then run the upload path's settings step
 * against it. Returns what CHIRP refused to load and whether the write stood. */
async function applyWithPlantedByte(harness, match, raw, field, byte) {
  return harness.runPythonJson(
    `
_r = _import_radio_class(_m, _c)(memmap.MemoryMapBytes(bytes(
    chirp_common.CloneModeRadio._strip_metadata(base64.b64decode(_b))[0])))
setattr(_r._memobj.settings, _f, _v)
_before = int(getattr(_r._memobj.settings, _f))
_dead = [e.get_name() for e in _r.get_settings().walk()
         if any(not v.initialized for v in e)]
_res = _validate_and_apply_radio_settings(
    _r, _serialize_radio_settings(_r.get_settings()), apply_changes=True)
json.dumps({"dead": _dead, "valid": _res["valid"], "issues": _res["issues"],
            "before": _before, "after": int(getattr(_r._memobj.settings, _f))})
    `,
    {
      _m: match.module,
      _c: match.className,
      _b: Buffer.from(raw).toString("base64"),
      _f: field,
      _v: byte,
    },
  );
}

test("a setting CHIRP could not load does not abort the write for every other one", async () => {
  const { harness, catalog } = await context();
  const { match, raw } = await loadImageFor(harness, catalog, EDITABLE_IMAGE);

  for (const { field, byte, why } of UNWRITABLE_BYTE_CASES) {
    const result = await applyWithPlantedByte(harness, match, raw, field, byte);

    // Without this the rest of the case passes vacuously: the planted byte has
    // to actually be one the driver refuses to load.
    assert.ok(
      result.dead.includes(field),
      `${field} (${why}) should read back uninitialized, got ${JSON.stringify(result.dead)}`,
    );
    assert.equal(
      result.valid,
      true,
      `${field} aborted the write: ${JSON.stringify(result.issues)}`,
    );
    // Skipped means skipped. Writing a repaired or zeroed value would silently
    // change a radio setting the user never asked us to touch.
    assert.equal(result.after, result.before, `${field} was rewritten while being skipped`);
  }
});

// A RadioSetting holding several values carries mutability on each value, not
// on the setting: one locked value must not lock its siblings (issue 98).
test("a multi-value setting reports mutability per value only", async () => {
  const { harness } = await context();
  const node = await harness.runPythonJson(
    `
_open = chirp_settings.RadioSettingValueString(0, 8, "Open")
_locked = chirp_settings.RadioSettingValueString(0, 8, "Locked")
_locked.set_mutable(False)
_setting = chirp_settings.RadioSetting("pair", "Pair", _open, _locked)
json.dumps(_serialize_setting_node(_setting, []))
    `,
  );
  assert.equal("mutable" in node, false, "the setting itself carries no aggregate flag");
  assert.deepEqual(node.values.map((value) => value.mutable), [true, false]);
});

// The write side of the same rule: an edit to the mutable sibling of a locked
// value reaches the driver, while a setting whose every value is locked is
// still withheld (issue 98, Codex review on PR 239).
test("an edit beside a locked value is written, an all-locked setting is not", async () => {
  const { harness } = await context();
  const written = await harness.runPythonJson(
    `
def _mixed_tree():
    _open = chirp_settings.RadioSettingValueString(0, 8, "Open")
    _locked = chirp_settings.RadioSettingValueString(0, 8, "Locked")
    _locked.set_mutable(False)
    _frozen = chirp_settings.RadioSettingValueString(0, 8, "Frozen")
    _frozen.set_mutable(False)
    return chirp_settings.RadioSettings(chirp_settings.RadioSettingGroup(
        "basic", "Basic",
        chirp_settings.RadioSetting("pair", "Pair", _open, _locked),
        chirp_settings.RadioSetting("frozen", "Frozen", _frozen),
    ))

class _MixedRadio:
    written = None
    def get_features(self):
        _rf = chirp_common.RadioFeatures()
        _rf.has_settings = True
        return _rf
    def get_settings(self):
        return _mixed_tree()
    def set_settings(self, settings):
        _MixedRadio.written = {
            s.get_name(): [str(v.get_value()).rstrip() for v in s]
            for g in settings for s in g.values()
        }

_payload = _serialize_radio_settings(_mixed_tree())
_payload[0]["children"][0]["values"][0]["current"] = "Edited"
_res = _validate_and_apply_radio_settings(_MixedRadio(), _payload, apply_changes=True)
json.dumps({"valid": _res["valid"], "written": _MixedRadio.written})
    `,
  );
  assert.equal(written.valid, true);
  assert.deepEqual(written.written, { pair: ["Edited", "Locked"] });
});

// A value the driver refuses is reported as an issue, and the reply's tree
// carries what the user typed rather than the value it was typed over, so the
// panel shows the field the message is about (issue 97).
test("a refused edit comes back in the reply as the user's own value", async () => {
  const { harness } = await context();
  const result = await harness.runPythonJson(
    `
def _tree():
    return chirp_settings.RadioSettings(chirp_settings.RadioSettingGroup(
        "basic", "Basic",
        chirp_settings.RadioSetting(
            "volume", "Volume", chirp_settings.RadioSettingValueInteger(0, 10, 5)),
        chirp_settings.RadioSetting(
            "name", "Name", chirp_settings.RadioSettingValueString(0, 8, "Open")),
    ))

class _Radio:
    def get_features(self):
        _rf = chirp_common.RadioFeatures()
        _rf.has_settings = True
        return _rf
    def get_settings(self):
        return _tree()

_payload = _serialize_radio_settings(_tree())
_payload[0]["children"][0]["values"][0]["current"] = 99
_payload[0]["children"][1]["values"][0]["current"] = "Edited"
_res = _validate_and_apply_radio_settings(_Radio(), _payload, apply_changes=False)
_by_id = {c["id"]: c["values"][0]["current"] for c in _res["settings"][0]["children"]}
json.dumps({"valid": _res["valid"], "issues": _res["issues"], "values": _by_id})
    `,
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), [["basic", "volume"]]);
  assert.equal(result.values.volume, 99, "the refused 99 is shown, not the radio's 5");
  assert.equal(String(result.values.name).trimEnd(), "Edited", "an accepted edit is applied as before");
});

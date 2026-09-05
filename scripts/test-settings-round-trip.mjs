import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findCatalogRadioForImageMetadata } from "../web/js/image-metadata.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// Reading a radio's settings and writing them straight back used to fail for 9
// of the 231 upstream test images that carry a settings tree. Four distinct
// mechanisms accounted for all of them, and each fixture below is named for the
// one it pins:
//
//   * UNINITIALIZED — the driver built a value from image content its own
//     validation rejects. RadioSettingGroup.__init__ logs and swallows that
//     (chirp/settings.py:80-90), leaving _current at None, so the value
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

async function readCatalog() {
  const text = await fs.readFile(path.join(repoRoot, "web/radio-catalog.json"), "utf8");
  return JSON.parse(text).radios;
}

async function loadImageFor(harness, catalog, name) {
  const raw = await fs.readFile(path.join(imagesDir, name));
  const metadata = await harness.runPythonJson(
    "json.dumps(read_image_metadata_base64(_b))",
    { _b: raw.toString("base64") },
  );
  const match = findCatalogRadioForImageMetadata(catalog, metadata);
  assert.ok(match, `${name} should resolve to a catalog radio`);
  await harness.runPythonJson("ensure_radio_module(_m) or json.dumps({})", {
    _m: match.module,
  });
  const loaded = await harness.loadCodeplugBinary(raw);
  return { match, loaded, raw };
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
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

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
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

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
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

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
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  for (const name of DUPLICATE_GROUP_NAME_IMAGES) {
    const { loaded } = await loadImageFor(harness, catalog, name);
    const topNames = (loaded.settings || []).map((group) => String(group.id));
    const nested = (loaded.settings || []).flatMap((group) =>
      (group.children || []).filter((child) => child.kind === "group").map((child) => String(child.id)),
    );
    const duplicated = [...topNames, ...nested].filter(
      (value, index, all) => all.indexOf(value) !== index,
    );
    assert.ok(
      duplicated.length > 0,
      `${name} should still carry the duplicate group name this fixture pins`,
    );
  }
});

test("a driver whose get_settings returns a bare list is still addressable", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

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
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

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

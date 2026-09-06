import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findCatalogRadioForImageMetadata } from "../web/js/image-metadata.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// Reading a radio and writing it straight back used to fail for 113 of the 248
// resolvable upstream test images. Two defects accounted for 96 of them, both
// in the row -> Memory reconstruction:
//
//   * power labels were rebuilt by converting the driver's PowerLevel to a watt
//     string and parsing it back, via int(level) which truncates the dBm. A 50W
//     level became "39W", and PowerLevel equality compares dBm as a float, so
//     the driver's POWER_LEVELS.index() lookup raised "not in list".
//   * every write went through Memory.really_from_csv(), a legacy parser that
//     accepts only "+", "-" and "" for duplex, while our read path emits the
//     "split" and "off" that CHIRP's own to_csv() produces.
//
// These images each carry at least one channel that trips one of the two.
const POWER_ROUND_TRIP_IMAGES = [
  "BTECH_GMRS-V2.img",
  "AnyTone_5888UV.img",
  "BTECH_UV-25X2.img",
];
const SPLIT_DUPLEX_IMAGES = ["Baofeng_UV-5R.img", "Anysecu_WP-9900.img"];
const MIGRATED_IMAGE_FIXTURES = ["Icom_ID-5100.img", "Icom_ID-51_Plus2.img"];
const LOSSY_IMMUTABLE_POWER_FIXTURES = ["Retevis_RB618.img", "Retevis_RT647.img"];
const HISTORICALLY_LOSSY_NO_OP_FIXTURES = [
  "Icom_ID-51_Plus2.img",
  "Radioddity_GM-30.img",
  "Yaesu_FTM-7250D_R.img",
  "Anysecu_UV-A37.img",
  "BTECH_GMRS-20V2.img",
];

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

async function readCatalog() {
  const text = await fs.readFile(path.join(repoRoot, "web/radio-catalog.json"), "utf8");
  return JSON.parse(text).radios;
}

test("an unchanged export preserves every visible channel field", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  for (const name of HISTORICALLY_LOSSY_NO_OP_FIXTURES) {
    const { match, loaded } = await loadImageFor(harness, catalog, name);
    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings || [],
    );
    const reloaded = await harness.loadCodeplugBinary(exported.image);
    assert.equal(
      reloaded.rows.length,
      loaded.rows.length,
      `${name} changed the number of visible channels`,
    );

    // Locations identify radio memories; comparing by location catches added,
    // removed and changed rows without treating binary padding as channel data.
    const before = Object.fromEntries(
      loaded.rows.map((row) => [String(row.Location), row]),
    );
    const after = Object.fromEntries(
      reloaded.rows.map((row) => [String(row.Location), row]),
    );
    assert.deepEqual(after, before, `${name} changed visible channel data`);
  }
});

test("power levels survive a read/write cycle without dBm truncation", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  for (const name of POWER_ROUND_TRIP_IMAGES) {
    const { match, loaded } = await loadImageFor(harness, catalog, name);
    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings || [],
    );
    assert.ok(exported.image.length > 0, `${name} produced no image`);

    // Re-reading must report the same power label for every channel, which is
    // what the truncation broke: a 50W level came back as 39W.
    const reloaded = await harness.loadCodeplugBinary(exported.image);
    const before = loaded.rows.map((row) => `${row.Location}:${row.Power}`);
    const after = reloaded.rows.map((row) => `${row.Location}:${row.Power}`);
    assert.deepEqual(after, before, `${name} changed power levels across a write`);
  }
});

test("channels with split and off duplex survive a read/write cycle", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  let sawNonStandardDuplex = false;
  for (const name of SPLIT_DUPLEX_IMAGES) {
    const { match, loaded } = await loadImageFor(harness, catalog, name);
    const duplexes = new Set(loaded.rows.map((row) => String(row.Duplex || "")));
    if (duplexes.has("split") || duplexes.has("off")) {
      sawNonStandardDuplex = true;
    }

    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings || [],
    );
    const reloaded = await harness.loadCodeplugBinary(exported.image);
    const before = loaded.rows.map((row) => `${row.Location}:${row.Duplex}:${row.Offset}`);
    const after = reloaded.rows.map((row) => `${row.Location}:${row.Duplex}:${row.Offset}`);
    assert.deepEqual(after, before, `${name} changed duplex across a write`);
  }
  assert.ok(
    sawNonStandardDuplex,
    "fixture images no longer contain a split/off channel; pick different ones",
  );
});

test("migrated images can export without re-reading incompatible cached bytes", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  for (const name of MIGRATED_IMAGE_FIXTURES) {
    const { match, loaded } = await loadImageFor(harness, catalog, name);
    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings || [],
    );
    assert.ok(exported.image.length > 0, `${name} produced no image`);
  }
});

test("editing a mutable field preserves lossy immutable power values", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const catalog = await readCatalog();

  for (const name of LOSSY_IMMUTABLE_POWER_FIXTURES) {
    const { match, loaded } = await loadImageFor(harness, catalog, name);
    assert.ok(loaded.rows.length > 0, `${name} has no channels`);
    const originalPower = loaded.rows[0].Power;
    loaded.rows[0].Tone = "Tone";
    loaded.rows[0].rToneFreq = "88.5";
    const exported = await harness.exportCodeplugBinary(
      match.module,
      match.className,
      loaded.rows,
      loaded.settings || [],
    );
    const reloaded = await harness.loadCodeplugBinary(exported.image);
    assert.equal(reloaded.rows[0].Tone, "Tone", `${name} lost the mutable edit`);
    assert.equal(reloaded.rows[0].rToneFreq, "88.5", `${name} lost the tone value`);
    assert.equal(
      reloaded.rows[0].Power,
      originalPower,
      `${name} changed immutable power while editing its tone`,
    );
  }
});

// Guards the specific mechanism rather than just the symptom: the map has to
// hand back the driver's own PowerLevel object, because a rebuilt one compares
// unequal for every level whose dBm is not a whole number.
test("power label resolution returns the driver's own PowerLevel objects", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const result = await harness.runPythonJson(
    `
ensure_radio_module("anytone")
_levels = _valid_power_levels_for_driver("anytone", "AnyTone5888UVRadio")
_map = _power_levels_by_label(_levels)
_out = []
for _level in _levels:
    _resolved = _resolve_power_level(str(_level), _map)
    _out.append({
        "label": str(_level),
        "isSameObject": _resolved is _level,
        "watts": round(chirp_common.dBm_to_watts(float(_level)), 1),
    })
_labels, _default = _power_label_map_for_radio("anytone", "AnyTone5888UVRadio")
json.dumps({"levels": _out, "csvLabels": _labels})
    `,
  );

  assert.ok(result.levels.length > 0);
  for (const level of result.levels) {
    assert.equal(level.isSameObject, true, `${level.label} was rebuilt, not reused`);
  }
  // 50W is 46.99 dBm; int() truncation used to render it as "39W".
  assert.equal(result.csvLabels.High, "50W");
  assert.equal(result.csvLabels.Low, "5.0W");
});

// A channel with no power level serializes as the string "None", because
// Memory.to_csv() formats it with "%s". The previous code could not parse that
// and fell back to a default, silently writing the radio's first power level.
test("a channel with no power level stays unset instead of getting a default", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const result = await harness.runPythonJson(
    `
ensure_radio_module("anytone")
_map = _power_levels_by_label(_valid_power_levels_for_driver("anytone", "AnyTone5888UVRadio"))
_mem = chirp_common.Memory()
_mem.power = None
json.dumps({
    "serializedAs": _mem.to_csv()[15],
    "resolvesToNone": _resolve_power_level(_mem.to_csv()[15], _map) is None,
    "blankResolvesToNone": _resolve_power_level("", _map) is None,
})
    `,
  );
  assert.equal(result.serializedAs, "None");
  assert.equal(result.resolvesToNone, true);
  assert.equal(result.blankResolvesToNone, true);
});

// to_MHz(float(text)) truncates: an 8.219000 MHz offset lands on 8218999 Hz,
// so 27 channels of the IC-M710 image drifted by 1 Hz on every write.
test("frequencies and offsets keep full precision across a write", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const parsed = await harness.runPythonJson(
    `json.dumps({"legacy": chirp_common.to_MHz(float("8.219000")),
                 "current": chirp_common.parse_freq("8.219000")})`,
  );
  assert.equal(parsed.legacy, 8218999, "expected the legacy conversion to truncate");
  assert.equal(parsed.current, 8219000);

  const catalog = await readCatalog();
  const { match, loaded } = await loadImageFor(harness, catalog, "Icom_IC-M710.img");
  const exported = await harness.exportCodeplugBinary(
    match.module,
    match.className,
    loaded.rows,
    loaded.settings || [],
  );
  const reloaded = await harness.loadCodeplugBinary(exported.image);
  const before = loaded.rows.map((row) => `${row.Location}:${row.Frequency}:${row.Offset}`);
  const after = reloaded.rows.map((row) => `${row.Location}:${row.Frequency}:${row.Offset}`);
  assert.deepEqual(after, before, "frequencies drifted across a write");
});

test("unsupported power text fails with the radio's valid values, not an index error", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  await assert.rejects(
    () =>
      harness.runPythonJson(
        `
ensure_radio_module("anytone")
_map = _power_levels_by_label(_valid_power_levels_for_driver("anytone", "AnyTone5888UVRadio"))
json.dumps({"level": str(_resolve_power_level("7.5W", _map))})
        `,
      ),
    /is not supported by this radio; valid values:/,
  );
});

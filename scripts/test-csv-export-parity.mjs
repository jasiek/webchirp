import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(repoRoot, "chirp/tests/images");

// CHIRP's own CSV export, transcribed from chirp/wxui/memedit.py so the
// comparison is against upstream behaviour and not a restatement of ours. Kept
// in the test rather than the runtime because nothing in the app needs a second
// export implementation.
const REFERENCE_EXPORT_PY = `
def _reference_csv_export(image_b64):
    """ChirpMemEdit._export_to_file(), minus the wx grid."""
    # Imported here rather than taken from the bridge's globals so the reference
    # stays valid whatever the bridge happens to import.
    from chirp import import_logic
    from chirp.drivers.generic_csv import CSVRadio

    raw_image = base64.b64decode(image_b64)
    with tempfile.NamedTemporaryFile(mode="wb", suffix=".img", delete=False) as f:
        image_path = f.name
        f.write(raw_image)
    try:
        radio = directory.get_radio_by_image(image_path)
    finally:
        os.unlink(image_path)

    rf = radio.get_features()
    lo, hi = rf.memory_bounds
    mems = []
    for number in range(int(lo), int(hi) + 1):
        try:
            mem = radio.get_memory(number)
            # Desktop CHIRP augments its grid cache with external properties
            # before export, so include metadata-backed comments in the oracle.
            if isinstance(radio, chirp_common.ExternalMemoryProperties):
                mem = radio.get_memory_extra(mem)
        except Exception:
            continue
        # Specials carry string numbers and never get exported.
        if mem.empty or not isinstance(mem.number, int) or mem.number < 0:
            continue
        mems.append(mem)

    csv_radio = CSVRadio(None, max_memory=(mems[-1].number if mems else 999))
    # "The CSV driver defaults to a single non-empty memory at location zero, so
    # delete it before we go to export."
    csv_radio.erase_memory(0)
    for mem in mems:
        try:
            mem = import_logic.import_mem(
                csv_radio, rf, mem, mem_cls=chirp_common.Memory
            )
        except import_logic.ImportError:
            pass  # CHIRP logs and exports the memory unconverted.
        csv_radio.set_memory(mem)
    return csv_radio.as_string()
`;

// One image per divergence this parity target covers, plus a vendor spread.
// Set WEBCHIRP_CSV_PARITY_IMAGES=all to sweep every image in chirp/tests/images.
const IMAGES = [
  // Location bounds start at 1, so a phantom channel 0 shows up in the export.
  "BTECH_GMRS-V2.img",
  "Yaesu_FT-60.img",
  // Power levels whose dBm is not a whole number.
  "AnyTone_5888UV.img",
  "BTECH_UV-25X2.img",
  // split/off duplex, which the CSV writer has to accept.
  "Baofeng_UV-5R.img",
  "Anysecu_WP-9900.img",
  // DVMemory.to_csv() column layout.
  "Icom_IC-2820H.img",
  "Icom_ID-5100.img",
  "Kenwood_TH-D74_clone_mode.img",
  // Frequencies that lose precision when parsed as floats.
  "Icom_IC-M710.img",
  // Non-empty channels with no frequency, which CHIRP's CSV parser discards.
  "Icom_IC-W32A.img",
  "Jetstream_JT220M.img",
  // Power levels a blank driver instance does not advertise.
  "Retevis_RT98.img",
  // Every image in KNOWN_POWER_LABEL_DIVERGENCES, so the default run is the one
  // that notices when a known divergence appears or disappears.
  "Yaesu_VX-6.img",
  "Yaesu_VX-7.img",
  "Yaesu_FT-90.img",
  "Retevis_RB618.img",
  "Retevis_RT647.img",
  // Vendor spread.
  "Alinco_DR735T.img",
  "Baofeng_UV-17Pro.img",
  "Icom_IC-2200H.img",
  "Kenwood_TM-D710_CloneMode.img",
  "Puxing_PX-777.img",
  "Retevis_RT21.img",
  "TYT_TH-UV8000.img",
  "Wouxun_KG-UV8D.img",
  "Yaesu_FT-857_897.img",
];

// Images whose Power column cannot match CHIRP's, because a row carries power as
// a label while these drivers use one label for two wattages. get_features()
// advertises only one of the lists, so "Hi" is 5W on 2m and 1.5W on 220MHz with
// nothing in the row to tell them apart; CHIRP is exact only because it passes
// PowerLevel objects around instead of text. Every other column still has to
// match, and an image listed here that stops diverging must be removed.
const KNOWN_POWER_LABEL_DIVERGENCES = new Map([
  ["Yaesu_VX-6.img", "vx6.POWER_LEVELS_220 reuses the POWER_LEVELS labels"],
  ["Yaesu_VX-7.img", "vx7.POWER_LEVELS_220 reuses the POWER_LEVELS labels"],
  ["Yaesu_FT-90.img", "ft90 splits Hi/Mid1/Mid2/Low across VHF and UHF wattages"],
  ["Retevis_RB618.img", "radtel_t18.RB618Radio assigns Low without advertising it"],
  ["Retevis_RT647.img", "radtel_t18.RT647Radio assigns Low without advertising it"],
]);

// True when two exports differ in nothing but the Power column, which is the
// only thing a known label divergence is allowed to change.
function differsOnlyInPower(expected, actual) {
  const powerIndex = 15;
  const expectedLines = expected.split("\r\n");
  const actualLines = actual.split("\r\n");
  if (expectedLines.length !== actualLines.length) {
    return false;
  }
  let sawPowerDifference = false;
  for (const [index, line] of expectedLines.entries()) {
    const other = actualLines[index];
    if (line === other) {
      continue;
    }
    const mine = line.split(",");
    const theirs = other.split(",");
    if (mine.length !== theirs.length) {
      return false;
    }
    for (let field = 0; field < mine.length; field += 1) {
      if (mine[field] === theirs[field]) {
        continue;
      }
      if (field !== powerIndex) {
        return false;
      }
      sawPowerDifference = true;
    }
  }
  return sawPowerDifference;
}

// Images predating the metadata trailer only resolve through match_model, which
// needs the driver already imported, so import the whole catalog up front and
// let CHIRP detect each image the way directory.get_radio_by_image() does.
async function importEveryDriver(harness) {
  const text = await fs.readFile(path.join(repoRoot, "web/radio-catalog.json"), "utf8");
  const modules = Array.from(
    new Set(JSON.parse(text).radios.map((radio) => radio.module)),
  ).sort();
  const result = await harness.runPythonJson(
    'json.dumps({"radios": len(list_registered_radios(json.loads(_mods)))})',
    { _mods: JSON.stringify(modules) },
  );
  assert.ok(result.radios > 400, `expected the driver catalog to load, got ${result.radios}`);
}

async function listAllImages() {
  const names = await fs.readdir(imagesDir);
  return names.filter((name) => name.toLowerCase().endsWith(".img")).sort();
}

async function selectedImages() {
  if (String(process.env.WEBCHIRP_CSV_PARITY_IMAGES || "").toLowerCase() === "all") {
    return listAllImages();
  }
  return IMAGES;
}

test("CSV export is identical to CHIRP's own CSV export", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  await harness.runPythonJson(`${REFERENCE_EXPORT_PY}\njson.dumps({"ready": True})`);
  await importEveryDriver(harness);

  const names = await selectedImages();
  const mismatches = [];
  const skipped = [];
  const stillDiverging = [];
  let compared = 0;

  for (const name of names) {
    const raw = await fs.readFile(path.join(imagesDir, name));
    let loaded = null;
    try {
      // The app's own read path: detect the driver and hand back grid rows.
      loaded = await harness.loadCodeplugBinary(raw);
    } catch (error) {
      skipped.push(`${name}: image did not load (${error.message})`);
      continue;
    }

    let result = null;
    try {
      result = await harness.runPythonJson(
        `json.dumps({
             "ours": normalize_rows(json.loads(_rows_json), _m, _c),
             "theirs": _reference_csv_export(_b),
         })`,
        {
          _rows_json: JSON.stringify(loaded.rows || []),
          _m: loaded.module,
          _c: loaded.className,
          _b: raw.toString("base64"),
        },
      );
    } catch (error) {
      mismatches.push(`${name}: export raised ${error.message}`);
      continue;
    }

    compared += 1;
    const known = KNOWN_POWER_LABEL_DIVERGENCES.get(name);
    if (result.ours === result.theirs) {
      if (known) {
        mismatches.push(
          `${name}: now matches CHIRP — drop it from KNOWN_POWER_LABEL_DIVERGENCES (${known})`,
        );
      }
      continue;
    }
    if (known && differsOnlyInPower(result.theirs, result.ours)) {
      stillDiverging.push(`${name} (${known})`);
      continue;
    }
    mismatches.push(`${name}:\n${firstDifference(result.theirs, result.ours)}`);
  }

  if (skipped.length) {
    // Never let an unresolvable image read as a pass.
    console.log(`skipped ${skipped.length} image(s):\n  ${skipped.join("\n  ")}`);
  }
  if (stillDiverging.length) {
    console.log(
      `${stillDiverging.length} known Power-column divergence(s):\n  ${stillDiverging.join("\n  ")}`,
    );
  }
  assert.ok(compared >= 10, `expected to compare at least 10 images, compared ${compared}`);
  assert.deepEqual(mismatches, [], `${mismatches.length} image(s) diverge from CHIRP`);
});

const CSV_HEADER_LINE = [
  "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode",
  "DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment",
  "URCALL,RPT1CALL,RPT2CALL,DVCODE",
].join(",");

test("importing a CSV does not invent a channel 0", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const csvText = `${CSV_HEADER_LINE}\n`
    + "1,TEST,145.500000,,0.600000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,5.0W,,,,,\n";
  const parsed = await harness.runPythonJson("json.dumps(parse_csv(_csv))", { _csv: csvText });

  assert.deepEqual(
    parsed.rows.map((row) => row.Location),
    ["1"],
    "CSVRadio(None) seeds a default channel 0 that load_from() does not clear",
  );
  assert.equal(parsed.rows[0].Frequency, "145.500000");
  assert.equal(parsed.rows[0].Power, "5.0W");
});

test("a DV row keeps the documented column layout", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const csvText = `${CSV_HEADER_LINE}\n`
    + "1,DSTAR,145.500000,,0.600000,,88.5,88.5,023,NN,023,Tone->Tone,DV,5.00,,5.0W,,,,,\n";
  const parsed = await harness.runPythonJson("json.dumps(parse_csv(_csv))", { _csv: csvText });

  const [row] = parsed.rows;
  // DVMemory.to_csv() would put the mode string in RxDtcsCode and shift the rest.
  assert.equal(row.Mode, "DV");
  assert.equal(row.RxDtcsCode, "023");
  assert.equal(row.TStep, "5.00");
  assert.equal(row.Power, "5.0W");
});

// A submodule bump that renames or drops an image would quietly stop covering
// whichever divergence that image stands for, so fail instead.
test("the curated image list still covers each divergence class", async () => {
  const available = new Set(await listAllImages());
  for (const name of IMAGES) {
    assert.ok(available.has(name), `${name} is gone from chirp/tests/images`);
  }
  for (const name of KNOWN_POWER_LABEL_DIVERGENCES.keys()) {
    assert.ok(available.has(name), `${name} is gone from chirp/tests/images`);
    assert.ok(IMAGES.includes(name), `${name} must stay in the compared set`);
  }
});

function firstDifference(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const total = Math.max(expectedLines.length, actualLines.length);
  const out = [];
  for (let i = 0; i < total && out.length < 6; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      out.push(`  line ${i + 1}\n    chirp:    ${expectedLines[i] ?? "<eof>"}`);
      out.push(`    webchirp: ${actualLines[i] ?? "<eof>"}`);
    }
  }
  return out.join("\n");
}

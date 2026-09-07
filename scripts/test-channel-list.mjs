import assert from "node:assert/strict";
import test from "node:test";

import { ensureModule, sharedHarness } from "./test-support/chirp.mjs";

const PMR446_FREQS_6DP = [
  "446.006250",
  "446.018750",
  "446.031250",
  "446.043750",
  "446.056250",
  "446.068750",
  "446.081250",
  "446.093750",
  "446.106250",
  "446.118750",
  "446.131250",
  "446.143750",
  "446.156250",
  "446.168750",
  "446.181250",
  "446.193750",
];

const PMR446_FREQS_5DP = PMR446_FREQS_6DP.map((value) =>
  Number.parseFloat(value).toFixed(5),
);

const TEST_RADIO = {
  module: "uv5r",
  className: "BaofengUV5R",
};

function makeChannelRows({ offset = "0.000000", frequencies = PMR446_FREQS_6DP } = {}) {
  return frequencies.map((frequency, index) => ({
    Location: String(index + 1),
    Name: `PMR${String(index + 1).padStart(2, "0")}`,
    Frequency: frequency,
    Duplex: "",
    Offset: offset,
    Tone: "",
    rToneFreq: "88.5",
    cToneFreq: "88.5",
    DtcsCode: "023",
    DtcsPolarity: "NN",
    RxDtcsCode: "023",
    CrossMode: "Tone->Tone",
    Mode: "NFM",
    TStep: "12.50",
    Skip: "",
    Power: "Low",
    Comment: "channel-list-test",
  }));
}

function makeGmrsRows() {
  return [
    {
      Location: "1",
      Name: "GMRS 1",
      Frequency: "462.56250",
      Duplex: "",
      Offset: "0.000000",
      Tone: "",
      rToneFreq: "88.5",
      cToneFreq: "88.5",
      DtcsCode: "023",
      DtcsPolarity: "NN",
      RxDtcsCode: "023",
      CrossMode: "Tone->Tone",
      Mode: "FM",
      TStep: "12.50",
      Skip: "",
      Power: "Low",
      Comment: "gmrs-test",
    },
    {
      Location: "2",
      Name: "GMRS 8",
      Frequency: "467.56250",
      Duplex: "",
      Offset: "0.000000",
      Tone: "",
      rToneFreq: "88.5",
      cToneFreq: "88.5",
      DtcsCode: "023",
      DtcsPolarity: "NN",
      RxDtcsCode: "023",
      CrossMode: "Tone->Tone",
      Mode: "NFM",
      TStep: "12.50",
      Skip: "",
      Power: "Low",
      Comment: "gmrs-test",
    },
    {
      Location: "3",
      Name: "GMRS 15",
      Frequency: "462.55000",
      Duplex: "",
      Offset: "0.000000",
      Tone: "",
      rToneFreq: "88.5",
      cToneFreq: "88.5",
      DtcsCode: "023",
      DtcsPolarity: "NN",
      RxDtcsCode: "023",
      CrossMode: "Tone->Tone",
      Mode: "FM",
      TStep: "12.50",
      Skip: "",
      Power: "High",
      Comment: "gmrs-test",
    },
    {
      Location: "4",
      Name: "GMRS 15R",
      Frequency: "462.55000",
      Duplex: "+",
      Offset: "5.000000",
      Tone: "",
      rToneFreq: "88.5",
      cToneFreq: "88.5",
      DtcsCode: "023",
      DtcsPolarity: "NN",
      RxDtcsCode: "023",
      CrossMode: "Tone->Tone",
      Mode: "FM",
      TStep: "12.50",
      Skip: "",
      Power: "High",
      Comment: "gmrs-test",
    },
  ];
}

// An optional --chirp-dir on the command line points the runtime at another
// CHIRP checkout; the harness falls back to WEBCHIRP_CHIRP_DIR and ./chirp.
function parseChirpDirArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === "--chirp-dir" && argv[i + 1]) {
      return String(argv[i + 1]);
    }
    if (arg.startsWith("--chirp-dir=")) {
      return arg.slice("--chirp-dir=".length);
    }
  }
  return "";
}

test("channel list rows are parseable and codeplug-applicable", async (t) => {
  const harness = await sharedHarness({ chirpDir: parseChirpDirArg() });
  await ensureModule(harness, TEST_RADIO.module);

  await t.test("blank Offset values normalize into parseable rows", async () => {
    const rows = makeChannelRows({ offset: "" });
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_csv = normalize_rows(_rows, _sel_module, _sel_class)
_parsed = parse_csv(_csv)
_failures = []
for _idx, _row in enumerate(_parsed["rows"]):
    _vals = [str(_row.get(_h, "") or "") for _h in CSV_HEADERS]
    try:
        _mem = chirp_common.Memory()
        _mem.really_from_csv(_vals)
    except Exception as _exc:
        _failures.append({"index": _idx, "error": str(_exc)})
json.dumps({
    "csvText": _csv,
    "rowCount": len(_parsed["rows"]),
    "csvErrors": list(_parsed["errors"]),
    "parseFailures": _failures,
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.ok(result.rowCount >= rows.length);
    assert.deepEqual(result.csvErrors, []);
    assert.deepEqual(result.parseFailures, []);
    assert.match(result.csvText, /0\.000000/);
  });

  await t.test("UI-style PMR frequencies are parseable from channel list values", async () => {
    const rows = makeChannelRows({ frequencies: PMR446_FREQS_5DP });
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_csv = normalize_rows(_rows, _sel_module, _sel_class)
_parsed = parse_csv(_csv)
json.dumps({
    "rowCount": len(_parsed["rows"]),
    "csvErrors": list(_parsed["errors"]),
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.ok(result.rowCount >= rows.length);
    assert.deepEqual(result.csvErrors, []);
  });

  await t.test("channel list rows can be applied to a driver codeplug image", async () => {
    const rows = makeChannelRows();
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_radio_cls = _import_radio_class(_sel_module, _sel_class)
_size = int(getattr(_radio_cls, "_memsize", 0) or 0)
if _size <= 0:
    raise RuntimeUnsupportedError("Driver does not expose _memsize for offline codeplug test")
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_size)))
_apply_rows_to_radio_instance(_radio, _rows)
_roundtrip, _ = _radio_rows_from_instance(_radio)
_locations = sorted(int(_r.get("Location", 0) or 0) for _r in _roundtrip)
_powers = {str(_r.get("Location", "")): str(_r.get("Power", "")) for _r in _roundtrip}
_image = _radio.get_mmap().get_byte_compatible().get_packed()
json.dumps({
    "memorySize": _size,
    "imageSize": len(_image),
    "rowCount": len(_roundtrip),
    "locations": _locations,
    "powers": _powers,
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.memorySize, result.imageSize);
    assert.equal(result.rowCount, rows.length);
    assert.deepEqual(
      result.locations,
      rows.map((row) => Number(row.Location)),
    );
    for (const row of rows) {
      assert.equal(result.powers[row.Location], row.Power);
    }
  });

  await t.test("GMRS-style rows preserve bandwidth/power/simplex and repeater fields", async () => {
    const rows = makeGmrsRows();
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_radio_cls = _import_radio_class(_sel_module, _sel_class)
_size = int(getattr(_radio_cls, "_memsize", 0) or 0)
if _size <= 0:
    raise RuntimeUnsupportedError("Driver does not expose _memsize for offline codeplug test")
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_size)))
_apply_rows_to_radio_instance(_radio, _rows)
_roundtrip, _ = _radio_rows_from_instance(_radio)
_by_location = {str(_r.get("Location", "")): _r for _r in _roundtrip}
json.dumps({
    "rowCount": len(_roundtrip),
    "firstMode": str(_by_location["1"].get("Mode", "")),
    "secondMode": str(_by_location["2"].get("Mode", "")),
    "thirdPower": str(_by_location["3"].get("Power", "")),
    "repeaterDuplex": str(_by_location["4"].get("Duplex", "")),
    "repeaterOffset": str(_by_location["4"].get("Offset", "")),
    "repeaterPower": str(_by_location["4"].get("Power", "")),
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.rowCount, rows.length);
    assert.equal(result.firstMode, "FM");
    assert.equal(result.secondMode, "NFM");
    assert.equal(result.thirdPower, "High");
    assert.equal(result.repeaterDuplex, "+");
    assert.equal(result.repeaterOffset, "5.000000");
    assert.equal(result.repeaterPower, "High");
  });

  await t.test("preflight validator returns row+column issues for invalid values", async () => {
    const rows = makeChannelRows();
    rows[2].Frequency = "not-a-freq";
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
json.dumps(validate_rows_for_upload(_rows, _sel_module, _sel_class))
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.issues));
    assert.ok(result.issues.length >= 1);
    assert.equal(result.issues[0].rowIndex, 2);
    assert.equal(result.issues[0].column, "Frequency");
  });

  // https://github.com/jasiek/webchirp/issues/73: _apply_rows_to_radio_instance
  // rejects an out-of-bounds Location, but it does so partway through a clone
  // with the radio already open. Preflight has to catch it while it is still
  // a highlighted cell.
  await t.test("preflight validator reports out-of-bounds and duplicate Locations", async () => {
    const rows = makeChannelRows();
    rows[0].Location = "9000";
    rows[3].Location = rows[2].Location;
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
json.dumps(validate_rows_for_upload(_rows, _sel_module, _sel_class))
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.valid, false);
    const byRow = new Map(
      result.issues
        .filter((issue) => issue.column === "Location")
        .map((issue) => [issue.rowIndex, issue.message]),
    );
    assert.match(byRow.get(0) ?? "", /outside radio memory bounds 0-127/);
    assert.match(byRow.get(3) ?? "", /already used by row 3/);
    // Rows 1, 2 and 4+ are fine and must not be flagged.
    assert.equal(byRow.has(1), false);
    assert.equal(byRow.has(2), false);
    assert.equal(byRow.has(4), false);
  });

  await t.test("driver validation rejects a globally valid tuning step", async () => {
    const rows = makeChannelRows().slice(0, 1);
    rows[0].TStep = "15.00";
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
json.dumps(validate_rows_for_upload(_rows, _sel_module, _sel_class))
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.valid, false);
    const issue = result.issues.find((candidate) => candidate.column === "TStep");
    assert.match(
      issue?.message ?? "",
      /Tuning step 15\.00 not supported/,
      JSON.stringify(result),
    );
  });

  await t.test("GT-5R immutable TX fields block preflight and the write path", async () => {
    const result = await harness.runPythonJson(
      `
_module = "uv5r"
_class_name = "RadioddityGT5RRadio"
_radio_cls = _import_radio_class(_module, _class_name)
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_radio_cls._memsize)))
_existing = chirp_common.Memory(1)
_existing.freq = chirp_common.parse_freq("462.562500")
_existing.duplex = "off"
_existing.offset = 0
_existing.mode = "NFM"
_radio.set_memory(_existing)
_image = _radio.get_mmap().get_byte_compatible().get_packed()
LAST_IMAGE_BY_DRIVER[_driver_cache_key(_module, _class_name)] = bytes(_image)
_readable_rows, _ = _radio_rows_from_instance(_radio)
_row = next(
    _row for _row in _readable_rows
    if _row["Location"] == "1"
)
_rows = [_row]
_row["Duplex"] = "+"
_row["Offset"] = "5.000000"
_preflight = validate_rows_for_upload(_rows, _module, _class_name)
try:
    _write_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_image)))
    _apply_rows_to_radio_instance(_write_radio, _rows, _module, _class_name)
    _write_error = ""
except Exception as _exc:
    _write_error = str(_exc)
json.dumps({"preflight": _preflight, "writeError": _write_error})
      `,
    );

    assert.equal(result.preflight.valid, false);
    const immutableColumns = new Set(
      result.preflight.issues
        .filter((issue) => /not mutable/.test(issue.message))
        .map((issue) => issue.column),
    );
    assert.deepEqual(
      immutableColumns,
      new Set(["Duplex", "Offset"]),
      JSON.stringify(result),
    );
    assert.ok(
      result.preflight.warnings.some((warning) =>
        /Duplex must be "off"/.test(warning.message)),
    );
    assert.match(result.writeError, /Field duplex is not mutable/);
    assert.match(result.writeError, /Field offset is not mutable/);
  });

  await t.test("the driver's name filter is applied before set_memory", async () => {
    const rows = makeChannelRows().slice(0, 1);
    rows[0].Name = "lower*toolong";
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_radio_cls = _import_radio_class(_sel_module, _sel_class)
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_radio_cls._memsize)))
_expected = _radio.filter_name(_rows[0]["Name"])
_apply_rows_to_radio_instance(_radio, _rows, _sel_module, _sel_class)
json.dumps({"expected": _expected, "stored": _radio.get_memory(1).name})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.stored, result.expected);
    assert.notEqual(result.stored, rows[0].Name);
  });

  await t.test("clearing a frequency validates and erases the existing memory", async () => {
    const rows = makeChannelRows().slice(0, 1);
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_radio_cls = _import_radio_class(_sel_module, _sel_class)
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_radio_cls._memsize)))
_apply_rows_to_radio_instance(_radio, _rows, _sel_module, _sel_class)
_image = _radio.get_mmap().get_byte_compatible().get_packed()
LAST_IMAGE_BY_DRIVER[_driver_cache_key(_sel_module, _sel_class)] = bytes(_image)
_rows[0]["Frequency"] = ""
_preflight = validate_rows_for_upload(_rows, _sel_module, _sel_class)
_write_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_image)))
_apply_rows_to_radio_instance(_write_radio, _rows, _sel_module, _sel_class)
json.dumps({
    "preflight": _preflight,
    "isEmpty": bool(_write_radio.get_memory(1).empty),
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.preflight.valid, true, JSON.stringify(result));
    assert.deepEqual(result.preflight.issues, []);
    assert.equal(result.isEmpty, true);
  });

  await t.test("binary image export/load roundtrip preserves driver identity", async () => {
    const rows = makeChannelRows();
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_exported = export_image_base64(_sel_module, _sel_class, _rows)
_loaded = load_image_base64(_exported["imageBase64"])
json.dumps({
    "module": _loaded["module"],
    "className": _loaded["className"],
    "vendor": _loaded["vendor"],
    "model": _loaded["model"],
    "rowCount": len(_loaded["rows"]),
    "size": int(_exported.get("size", 0)),
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.equal(result.module, TEST_RADIO.module);
    assert.match(result.className, /BaofengUV5R/);
    assert.equal(result.vendor, "Baofeng");
    assert.equal(result.model, "UV-5R");
    assert.equal(result.rowCount, rows.length);
    assert.ok(result.size > 0);
  });

  await t.test("offline binary export does not fabricate a downloaded image", async () => {
    const rows = makeChannelRows();
    const result = await harness.runPythonJson(
      `
_rows = json.loads(_rows_json)
_key = _driver_cache_key(_sel_module, _sel_class)
LAST_IMAGE_BY_DRIVER.pop(_key, None)
IMAGE_CLASS_BY_DRIVER.pop(_key, None)
_exported = export_image_base64(_sel_module, _sel_class, _rows)
_settings = get_radio_settings(_sel_module, _sel_class)
try:
    _upload_selected_radio_sync(_sel_module, _sel_class, _rows)
    _upload_error = ""
except Exception as _exc:
    _upload_error = str(_exc)
json.dumps({
    "exportSize": int(_exported.get("size", 0)),
    "hasCachedImage": _has_cached_image(_sel_module, _sel_class),
    "settingsRequiresImage": bool(_settings.get("requiresImage")),
    "uploadError": _upload_error,
})
      `,
      {
        _rows_json: JSON.stringify(rows),
        _sel_module: TEST_RADIO.module,
        _sel_class: TEST_RADIO.className,
      },
    );

    assert.ok(result.exportSize > 0);
    assert.equal(result.hasCachedImage, false);
    assert.equal(result.settingsRequiresImage, true);
    assert.match(result.uploadError, /No cached radio image/);
  });
});

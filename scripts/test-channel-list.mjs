import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import {
  createFilesystemPythonSource,
  installFetchChirpSourceGlobal,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

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

function installJsBridgeStubs() {
  globalThis.serial_open = async () => ({ connected: true, message: "stub open" });
  globalThis.serial_close = async () => ({ connected: false, message: "stub close" });
  globalThis.serial_write_hex = async () => ({ written: 0, hex: "" });
  globalThis.serial_read_hex = async () => ({ read: 0, hex: "", timedOut: true });
  globalThis.serial_write_bytes = async () => ({ written: 0 });
  globalThis.serial_read_bytes = async () => [];
  globalThis.serial_log = () => ({ logged: true });
  globalThis.serial_prepare_clone = async () => ({ prepared: true });
  globalThis.serial_reset_buffers = async () => ({ reset: true });
}

async function pathExists(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveChirpPackageDir(inputDir) {
  const candidate = path.resolve(inputDir);
  const directInit = path.join(candidate, "__init__.py");
  const directDrivers = path.join(candidate, "drivers");
  if ((await pathExists(directInit)) && (await pathExists(directDrivers))) {
    return candidate;
  }

  const nested = path.join(candidate, "chirp");
  const nestedInit = path.join(nested, "__init__.py");
  const nestedDrivers = path.join(nested, "drivers");
  if ((await pathExists(nestedInit)) && (await pathExists(nestedDrivers))) {
    return nested;
  }

  throw new Error(
    `Invalid CHIRP source dir: ${candidate}. Expected dir containing __init__.py and drivers/`,
  );
}

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

async function createLocalPythonSource(repoRoot) {
  const chirpInputDir =
    parseChirpDirArg() || process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp");
  const chirpPackageDir = await resolveChirpPackageDir(chirpInputDir);
  const runtimeBridgePath = path.join(repoRoot, "web/python/runtime_bridge.py");
  return createFilesystemPythonSource({
    chirpPackageDir,
    runtimeBridgePath,
    readText: (fullPath) => fs.readFile(fullPath, "utf8"),
    readDirNames: async (fullPath) => {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    joinPath: (...parts) => path.join(...parts),
  });
}

async function runPythonJson(pyodide, python, vars = {}) {
  for (const [key, value] of Object.entries(vars)) {
    pyodide.globals.set(key, value);
  }
  const jsonText = await pyodide.runPythonAsync(python);
  return JSON.parse(jsonText);
}

test("channel list rows are parseable and codeplug-applicable", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  installJsBridgeStubs();
  const pythonSource = await createLocalPythonSource(repoRoot);
  installFetchChirpSourceGlobal(pythonSource);

  const pyodide = await loadPyodide();
  await seedPyodideRuntime(pyodide, pythonSource);
  pyodide.globals.set("_sel_module", TEST_RADIO.module);
  await pyodide.runPythonAsync("ensure_radio_module(_sel_module)");

  await t.test("blank Offset values normalize into parseable rows", async () => {
    const rows = makeChannelRows({ offset: "" });
    const result = await runPythonJson(
      pyodide,
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
    const result = await runPythonJson(
      pyodide,
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
    const result = await runPythonJson(
      pyodide,
      `
_rows = json.loads(_rows_json)
_radio_cls = _import_radio_class(_sel_module, _sel_class)
_size = int(getattr(_radio_cls, "_memsize", 0) or 0)
if _size <= 0:
    raise RuntimeUnsupportedError("Driver does not expose _memsize for offline codeplug test")
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_size)))
_apply_rows_to_radio_instance(_radio, _rows)
_roundtrip = _radio_rows_from_instance(_radio)
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
    const result = await runPythonJson(
      pyodide,
      `
_rows = json.loads(_rows_json)
_radio_cls = _import_radio_class(_sel_module, _sel_class)
_size = int(getattr(_radio_cls, "_memsize", 0) or 0)
if _size <= 0:
    raise RuntimeUnsupportedError("Driver does not expose _memsize for offline codeplug test")
_radio = _radio_cls(memmap.MemoryMapBytes(bytes(_size)))
_apply_rows_to_radio_instance(_radio, _rows)
_roundtrip = _radio_rows_from_instance(_radio)
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
    const result = await runPythonJson(
      pyodide,
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

  await t.test("binary image export/load roundtrip preserves driver identity", async () => {
    const rows = makeChannelRows();
    const result = await runPythonJson(
      pyodide,
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
});

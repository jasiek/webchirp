import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";

const CORE_CHIRP_FILES = [
  ["chirp/__init__.py", "chirp/__init__.py"],
  ["chirp/errors.py", "chirp/errors.py"],
  ["chirp/util.py", "chirp/util.py"],
  ["chirp/memmap.py", "chirp/memmap.py"],
  ["chirp/chirp_common.py", "chirp/chirp_common.py"],
  ["chirp/directory.py", "chirp/directory.py"],
  ["chirp/pyPEG.py", "chirp/pyPEG.py"],
  ["chirp/bitwise_grammar.py", "chirp/bitwise_grammar.py"],
  ["chirp/bitwise.py", "chirp/bitwise.py"],
  ["chirp/settings.py", "chirp/settings.py"],
  ["chirp/drivers/generic_csv.py", "chirp/drivers/generic_csv.py"],
  ["chirp/drivers/h777.py", "chirp/drivers/h777.py"],
];

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

async function mkdirpFs(pyodide, dir) {
  const parts = dir.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      pyodide.FS.mkdir(current);
    } catch {
      // already exists
    }
  }
}

async function bootstrapRuntime(pyodide, repoRoot) {
  await mkdirpFs(pyodide, "/webchirp_runtime/chirp/drivers");
  for (const [src, dest] of CORE_CHIRP_FILES) {
    const fullPath = path.join(repoRoot, "chirp", src);
    const text = await fs.readFile(fullPath, "utf8");
    pyodide.FS.writeFile(`/webchirp_runtime/${dest}`, text, { encoding: "utf8" });
  }
  const runtimePath = path.join(repoRoot, "web/python/runtime_bridge.py");
  const runtimePython = await fs.readFile(runtimePath, "utf8");
  await pyodide.runPythonAsync(runtimePython);
}

function installJsBridgeStubs(repoRoot) {
  globalThis.serial_open = async () => ({ connected: true, message: "stub open" });
  globalThis.serial_close = async () => ({ connected: false, message: "stub close" });
  globalThis.serial_write_hex = async () => ({ written: 0, hex: "" });
  globalThis.serial_read_hex = async () => ({ read: 0, hex: "", timedOut: true });
  globalThis.serial_write_bytes = async () => ({ written: 0 });
  globalThis.serial_read_bytes = async () => [];
  globalThis.serial_log = () => ({ logged: true });
  globalThis.serial_prepare_clone = async () => ({ prepared: true });
  globalThis.serial_reset_buffers = async () => ({ reset: true });
  globalThis.fetch_chirp_source = async (sourcePath) => {
    const rel = String(sourcePath || "").replace(/^\/chirp\//, "");
    const fullPath = path.join(repoRoot, "chirp/chirp", rel);
    return await fs.readFile(fullPath, "utf8");
  };
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
  installJsBridgeStubs(repoRoot);

  const pyodide = await loadPyodide();
  await bootstrapRuntime(pyodide, repoRoot);
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
_image = _radio.get_mmap().get_byte_compatible().get_packed()
json.dumps({
    "memorySize": _size,
    "imageSize": len(_image),
    "rowCount": len(_roundtrip),
    "locations": _locations,
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

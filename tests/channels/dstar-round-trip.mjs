import assert from "node:assert/strict";
import test from "node:test";

import { isPythonError } from "../../web/js/runtime-errors.ts";
import { ensureModule, readImage, sharedHarness } from "../support/chirp.mjs";

// A D-STAR channel is a chirp_common.DVMemory: a Memory plus the UR, RPT1 and
// RPT2 calls and the digital code. The grid used to project every memory
// through a plain Memory, so those columns read blank, and the write side
// rebuilt each row as a plain Memory, which a DV radio's set_memory() turns
// into a DV channel with default routing. Renaming a D-STAR channel and
// exporting the image therefore cleared its repeater calls and digital code
// (issue #317).
const DV_CHANNEL = {
  number: 14,
  name: "DV BEFORE",
  urcall: "CQCQCQ",
  rpt1call: "W1ABC  B",
  rpt2call: "W1ABC  G",
  code: 42,
};
const FM_CHANNEL = DV_CHANNEL.number + 1;
const ID31 = { module: "id31", className: "ID31Radio", image: "Icom_ID-31A.img" };
const IC2200 = { module: "ic2200", className: "IC2200Radio", image: "Icom_IC-2200H.img" };
const ID800 = { module: "id800", className: "ID800v2Radio", image: "Icom_ID-800H_v2.img" };
const ROUTING = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"];

// An upstream image from chirp/tests/images, opened with the pinned driver,
// with `plant` (Python, the radio bound to _r) run against it first. Changes
// go through the driver's own set_memory(), so a fixture is whatever the
// driver would have written, not hand-made bytes. These upstream images carry
// no metadata trailer; _image_bytes_from_radio() adds the one the image load
// resolves the driver by.
async function upstreamImage(harness, driver, plant = "", vars = {}) {
  await ensureModule(harness, driver.module);
  const raw = await readImage(driver.image);
  const image = await harness.runPythonJson(
    `
_r = _import_radio_class(_m, _c)(memmap.MemoryMapBytes(bytes(
    chirp_common.CloneModeRadio._strip_metadata(base64.b64decode(_b))[0])))
${plant}
json.dumps(base64.b64encode(_image_bytes_from_radio(_r)).decode())
`,
    {
      ...vars,
      _m: driver.module,
      _c: driver.className,
      _b: Buffer.from(raw).toString("base64"),
    },
  );
  return Buffer.from(image, "base64");
}

// The ID-31A image with the issue's D-STAR channel in slot 14 and an FM one
// in slot 15.
function id31ImageWithDvChannel(harness) {
  return upstreamImage(
    harness,
    ID31,
    `
_ch = json.loads(_ch_json)
_mem = chirp_common.DVMemory()
_mem.number = _ch["number"]
_mem.name = _ch["name"]
_mem.freq = 440500000
_mem.mode = "DV"
_mem.dv_urcall = _ch["urcall"]
_mem.dv_rpt1call = _ch["rpt1call"]
_mem.dv_rpt2call = _ch["rpt2call"]
_mem.dv_code = _ch["code"]
_r.set_memory(_mem)
_fm = chirp_common.Memory()
_fm.number = _fm_number
_fm.name = "FM"
_fm.freq = 446000000
_fm.mode = "FM"
_r.set_memory(_fm)
`,
    { _ch_json: JSON.stringify(DV_CHANNEL), _fm_number: FM_CHANNEL },
  );
}

function rowAt(rows, location) {
  const row = rows.find((candidate) => String(candidate.Location) === String(location));
  assert.ok(row, `channel ${location} is missing from the grid`);
  return row;
}

function routingOf(row) {
  return ROUTING.map((header) => row[header]);
}

async function exportAndReload(harness, driver, loaded) {
  const exported = await harness.exportCodeplugBinary(
    driver.module,
    driver.className,
    loaded.rows,
    loaded.settings || [],
  );
  return harness.loadCodeplugBinary(exported.image);
}

test("a D-STAR channel shows its routing fields in the grid", async () => {
  const harness = await sharedHarness();
  const loaded = await harness.loadCodeplugBinary(await id31ImageWithDvChannel(harness));

  const row = rowAt(loaded.rows, DV_CHANNEL.number);
  assert.equal(row.Mode, "DV");
  assert.deepEqual(routingOf(row), [
    DV_CHANNEL.urcall,
    DV_CHANNEL.rpt1call,
    DV_CHANNEL.rpt2call,
    String(DV_CHANNEL.code),
  ]);
  // The other columns still line up with Memory.CSV_FORMAT, which a
  // DVMemory's own to_csv() would shift (issue #33).
  assert.equal(row.Frequency, "440.500000");
  assert.match(row.TStep, /^\d+\.\d\d$/);

  const fm = rowAt(loaded.rows, FM_CHANNEL);
  assert.deepEqual(routingOf(fm), ["", "", "", ""], "the driver read the FM channel as a plain Memory");
});

test("renaming a D-STAR channel keeps its routing fields across a binary export", async () => {
  const harness = await sharedHarness();
  const loaded = await harness.loadCodeplugBinary(await id31ImageWithDvChannel(harness));

  rowAt(loaded.rows, DV_CHANNEL.number).Name = "DV AFTER";
  const preflight = await harness.rpc("validate_rows_for_upload", {
    rows: loaded.rows,
    session_id: loaded.sessionId,
  });
  assert.deepEqual(preflight.issues, [], "the rename should pass the upload preflight");

  const reloaded = await exportAndReload(harness, ID31, loaded);
  const row = rowAt(reloaded.rows, DV_CHANNEL.number);
  assert.equal(row.Name, "DV AFTER");
  assert.equal(row.Mode, "DV");
  assert.deepEqual(routingOf(row), [
    DV_CHANNEL.urcall,
    DV_CHANNEL.rpt1call,
    DV_CHANNEL.rpt2call,
    String(DV_CHANNEL.code),
  ]);
});

test("a channel switched to DV in the grid is converted by the driver", async () => {
  // The routing columns are read-only, so a row the user turns into a D-STAR
  // channel carries none. It reaches set_memory() as a plain Memory in DV
  // mode -- what desktop CHIRP's grid hands the driver for the same edit --
  // and the ID-31 driver fills in its own default routing.
  const harness = await sharedHarness();
  const loaded = await harness.loadCodeplugBinary(await id31ImageWithDvChannel(harness));

  const row = rowAt(loaded.rows, FM_CHANNEL);
  assert.equal(row.Mode, "FM");
  row.Mode = "DV";
  const reloaded = await exportAndReload(harness, ID31, loaded);
  const after = rowAt(reloaded.rows, FM_CHANNEL);
  assert.equal(after.Mode, "DV");
  assert.deepEqual(routingOf(after), ["CQCQCQ", "", "", "0"]);
});

test("a call-list radio takes a channel switched to DV and keeps its D-STAR ones", async () => {
  // The IC-2200H stores routing as indexes into its call lists, and its
  // set_memory() looks every call of a DVMemory up there. Its lists do not
  // hold DVMemory's default "CQCQCQ", so a row with no routing must not be
  // turned into a DVMemory with made-up calls: that export would fail.
  const harness = await sharedHarness();
  const loaded = await harness.loadCodeplugBinary(await upstreamImage(harness, IC2200));

  const dv = loaded.rows.find((row) => row.Mode === "DV");
  const fm = loaded.rows.find((row) => row.Mode === "FM");
  assert.ok(dv && fm, "the IC-2200H image no longer holds both a DV and an FM channel");
  const routing = routingOf(dv);
  assert.notDeepEqual(routing, ["", "", "", ""], "the DV channel's routing is not shown");
  dv.Name = "RENAMED";
  fm.Mode = "DV";

  const reloaded = await exportAndReload(harness, IC2200, loaded);
  assert.deepEqual(routingOf(rowAt(reloaded.rows, dv.Location)), routing);
  assert.equal(rowAt(reloaded.rows, fm.Location).Mode, "DV");
});

test("a DV line imported from CSV carries no routing the file did not hold", async () => {
  // CHIRP's CSV parser makes a DV line a DVMemory but never reads the D-STAR
  // columns, so any routing on it would be DVMemory's class defaults.
  const harness = await sharedHarness();
  const csvText = [
    "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,"
      + "DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,"
      + "URCALL,RPT1CALL,RPT2CALL,DVCODE",
    "1,DSTAR,145.500000,,0.600000,,88.5,88.5,023,NN,023,Tone->Tone,DV,5.00,,5.0W,,,,,",
    "",
  ].join("\n");
  const parsed = await harness.runPythonJson("json.dumps(parse_csv(_csv))", { _csv: csvText });
  assert.equal(parsed.rows[0].Mode, "DV");
  assert.deepEqual(routingOf(parsed.rows[0]), ["", "", "", ""]);
});

test("an ID-800H refuses a channel switched to DV only when it is written", async () => {
  // Pins an upstream defect, FINDINGS.md id800-refuses-a-plain-dv-memory
  // (CHIRP d99bb227): id800's set_memory() raises InvalidDataError for a DV
  // memory that is not a DVMemory, where other D-STAR drivers fill in their
  // default routing. The grid sends the same plain Memory desktop CHIRP's does,
  // and the per-row check never calls set_memory(), so the preflight passes
  // and the export fails. This test fails once upstream accepts the edit:
  // then the export reloads the channel as DV.
  const harness = await sharedHarness();
  const loaded = await harness.loadCodeplugBinary(await upstreamImage(harness, ID800));
  assert.equal(loaded.className, ID800.className);

  const fm = loaded.rows.find((row) => row.Mode === "FM");
  assert.ok(fm, "the ID-800H image no longer holds an FM channel");
  fm.Mode = "DV";

  const preflight = await harness.rpc("validate_rows_for_upload", {
    rows: loaded.rows,
    session_id: loaded.sessionId,
  });
  assert.deepEqual(preflight.issues, [], "the preflight should not see the driver's refusal");

  const error = await harness
    .exportCodeplugBinary(ID800.module, ID800.className, loaded)
    .then(() => null, (caught) => caught);
  assert.ok(error, "the ID-800H driver now takes a plain DV Memory: drop this test");
  assert.ok(isPythonError(error, "InvalidDataError"), `got ${error.name}: ${error.message}`);
  assert.equal(error.message, "DV mode is not a DVMemory!");
});

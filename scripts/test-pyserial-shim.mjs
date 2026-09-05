import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

// Drivers that import pyserial at module scope. Without the serial shim in
// runtime_bridge.py they raise ModuleNotFoundError in Pyodide and silently
// never register with CHIRP's directory (issue #29).
const PYSERIAL_DRIVER_MODULES = ["tg_uv2p", "idrp"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let harnessPromise = null;

function getHarness() {
  if (!harnessPromise) {
    harnessPromise = createTestRadioHarness({ repoRoot });
  }
  return harnessPromise;
}

test("drivers importing pyserial at module scope import cleanly", async () => {
  const harness = await getHarness();
  const results = await harness.runPythonJson(
    `
_out = {}
for _name in _shim_modules:
    try:
        importlib.import_module("chirp.drivers." + str(_name))
        _out[str(_name)] = "ok"
    except Exception as _exc:
        _out[str(_name)] = "%s: %s" % (type(_exc).__name__, _exc)
json.dumps(_out)
    `,
    { _shim_modules: PYSERIAL_DRIVER_MODULES },
  );
  for (const name of PYSERIAL_DRIVER_MODULES) {
    assert.equal(results[name], "ok", `chirp.drivers.${name} failed to import: ${results[name]}`);
  }
});

test("TG-UV2+ registers and is listed by list_registered_radios", async () => {
  const harness = await getHarness();
  const radios = await harness.runPythonJson(
    "json.dumps(list_registered_radios(_shim_modules))",
    { _shim_modules: ["tg_uv2p"] },
  );
  const tguv2p = radios.find((radio) => radio.key === "tg_uv2p:QuanshengTGUV2P");
  assert.ok(tguv2p, "tg_uv2p:QuanshengTGUV2P missing from registered radios");
  assert.equal(tguv2p.vendor, "Quansheng");
  assert.equal(tguv2p.model, "TG-UV2+");
});

test("upstream Quansheng TG-UV2+ image loads and detects its driver", async () => {
  const harness = await getHarness();
  const imageBytes = await fs.readFile(
    path.join(repoRoot, "chirp/tests/images/Quansheng_TG-UV2+.img"),
  );
  const loaded = await harness.loadCodeplugBinary(imageBytes);
  assert.equal(loaded.module, "tg_uv2p");
  assert.equal(loaded.className, "QuanshengTGUV2P");
  assert.equal(loaded.vendor, "Quansheng");
  assert.equal(loaded.model, "TG-UV2+");
  assert.ok(loaded.rows.length > 0, "expected channel rows from the loaded image");
});

test("shim Serial refuses construction with a clear error", async () => {
  const harness = await getHarness();
  const result = await harness.runPythonJson(
    `
import serial
try:
    serial.Serial(port="/dev/never", baudrate=9600)
    _shim_error = ""
except serial.SerialException as _exc:
    _shim_error = str(_exc)
json.dumps({"error": _shim_error, "stopbitsTwo": serial.STOPBITS_TWO})
    `,
  );
  assert.match(result.error, /Web Serial bridge/);
  assert.equal(result.stopbitsTwo, 2);
});

// pyserial's write() reports how many bytes it sent. Drivers that validate the
// count -- puxing_px888k.pipewrite raises "operation returned <None>", tk11
// treats a falsy count as a failed transfer -- could never clone while the shim
// returned None (issue #79).
test("shim pipe write() returns the number of bytes written", async () => {
  const harness = await getHarness();
  const result = await harness.runPythonJson(
    `
_pipe = WebSerialPipe()
json.dumps({
  "bytesWritten": _pipe.write(b"\\x02\\x06abc"),
  "bytearrayWritten": _pipe.write(bytearray(b"\\x01\\x02\\x03")),
  "strWritten": _pipe.write("PROGRAM"),
  "emptyWritten": _pipe.write(b""),
})
    `,
  );
  assert.equal(result.bytesWritten, 5);
  assert.equal(result.bytearrayWritten, 3);
  assert.equal(result.strWritten, 7);
  assert.equal(result.emptyWritten, 0);
});

test("puxing_px888k pipewrite accepts the shim pipe", async () => {
  const harness = await getHarness();
  const result = await harness.runPythonJson(
    `
_px = importlib.import_module("chirp.drivers.puxing_px888k")
try:
    _px.pipewrite(WebSerialPipe(), _px.HANDSHAKE_OUT)
    _pipewrite_error = ""
except Exception as _exc:
    _pipewrite_error = "%s: %s" % (type(_exc).__name__, _exc)
json.dumps({"error": _pipewrite_error})
    `,
  );
  assert.equal(result.error, "");
});

// Issue #77: thd72 calls `self.pipe.setRTS()` with no argument and guards only
// against AttributeError, so a required parameter here aborts the clone with a
// TypeError before the first block. The lines must also actually reach the
// transport -- storing a boolean makes every mid-clone toggle inert.
test("pipe control lines default to asserted and reach the serial bridge", async () => {
  const harness = await getHarness();
  const before = harness.serialBridge.signalCalls.length;
  const result = await harness.runPythonJson(
    `
_pipe = WebSerialPipe(dtr=False, rts=False)
_seeded = [_pipe.dtr, _pipe.rts]
_pipe.setRTS()
_after_bare_setrts = [_pipe.dtr, _pipe.rts]
_pipe.dtr = True
_pipe.setDTR(False)
json.dumps({
  "seeded": _seeded,
  "afterBareSetRts": _after_bare_setrts,
  "final": [_pipe.dtr, _pipe.rts],
})
    `,
  );

  assert.deepEqual(result.seeded, [false, false]);
  assert.deepEqual(result.afterBareSetRts, [false, true], "setRTS() must default to True");
  assert.deepEqual(result.final, [false, true]);
  // Seeding the constructor must not touch the port: _prepare_clone_session()
  // owns the initial assertion, together with the settle delay.
  assert.deepEqual(harness.serialBridge.signalCalls.slice(before), [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: true, requestToSend: true },
    { dataTerminalReady: false, requestToSend: true },
  ]);
});

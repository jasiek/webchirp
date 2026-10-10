import assert from "node:assert/strict";
import test from "node:test";

import { readImage, sharedHarness } from "../support/chirp.mjs";

// The UV-5R Mini family (chirp/drivers/baofeng_uv17Pro.py) asks CHIRP's
// platform.is_ble_serial(self.pipe) at the top of sync_in() and sync_out(), to
// pick a smaller upload block over Bluetooth. Under Pyodide that is
// UnixPlatform's check, which reads pipe.port -- an attribute WebSerialPipe
// did not have, so every UV-5R Mini download and upload died with
// AttributeError before a byte was sent (Sentry WEBCHIRP-FRONTEND-1F).
//
// These run the real driver class through the real clone entry points. Only
// the step after CHIRP's check -- the wire transfer, which the stub bridge
// cannot answer -- is replaced, by a recorder that keeps what the driver
// concluded and hands back CHIRP's own UV-5R Mini test image.
const RUN_CLONE = `
import base64

from chirp import memmap
from chirp.drivers import baofeng_uv17Pro

_cls = baofeng_uv17Pro.UV5RMini
_seen = []
_image = base64.b64decode(_image_b64)


def _transfer_owner(name):
    """The class whose method UV5RMini's super() call reaches."""
    return next(c for c in _cls.__mro__[1:] if name in c.__dict__)


def _record_sync_in(self):
    _seen.append(["sync_in", self.pipe.port, self._is_on_ble])
    self._mmap = memmap.MemoryMapBytes(_image[: self.MEM_TOTAL])
    self.process_mmap()


def _record_sync_out(self):
    _seen.append(["sync_out", self.pipe.port, self._is_on_ble])


_in_owner = _transfer_owner("sync_in")
_out_owner = _transfer_owner("sync_out")
_saved = (_in_owner.__dict__["sync_in"], _out_owner.__dict__["sync_out"])
_in_owner.sync_in = _record_sync_in
_out_owner.sync_out = _record_sync_out
try:
    _session = open_radio_session("baofeng_uv17Pro", "UV5RMini")
    _download_selected_radio_sync(_session)
    _upload_selected_radio_sync(_session, [])
    close_session(_session.session_id)
finally:
    _in_owner.sync_in, _out_owner.sync_out = _saved
json.dumps({"seen": _seen})
`;

// Clone a UV-5R Mini over a port of the given transport and return what the
// driver's Bluetooth check concluded on download and on upload.
async function cloneOver(transport) {
  const harness = await sharedHarness();
  const image = await readImage("Baofeng_UV-5R_Mini.img");
  const previous = harness.serialBridge.transport;
  harness.serialBridge.transport = transport;
  try {
    return (await harness.runPythonJson(RUN_CLONE, { _image_b64: image.toString("base64") })).seen;
  } finally {
    harness.serialBridge.transport = previous;
  }
}

test("a UV-5R Mini clones over a cable and is told it is not on Bluetooth", async () => {
  const seen = await cloneOver("webserial");
  assert.deepEqual(seen, [
    ["sync_in", "webchirp:webserial", false],
    ["sync_out", "webchirp:webserial", false],
  ]);
});

test("a UV-5R Mini on Web Bluetooth is told so, for its smaller upload blocks", async () => {
  const seen = await cloneOver("webbluetooth");
  assert.deepEqual(seen.map(([step, , onBle]) => [step, onBle]), [
    ["sync_in", true],
    ["sync_out", true],
  ]);
});

test("a pipe made without a transport still answers CHIRP's port check", async () => {
  const harness = await sharedHarness();
  const result = await harness.runPythonJson(`
from chirp import platform

_pipe = WebSerialPipe()
json.dumps({"port": _pipe.port, "ble": platform.get_platform().is_ble_serial(_pipe)})
  `);
  assert.deepEqual(result, { port: "webchirp:unknown", ble: false });
});

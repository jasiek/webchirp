import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

// CHIRP's clone dialog calls rclass.detect_from_serial(pipe) before sync_in().
// For ga510 and tdh8 that call is where the program handshake is sent -- their
// download paths deliberately do not repeat it -- so a bridge that skips it
// leaves those radios silent, and drivers like leixen/h777/uvk5 clone against
// the wrong variant class (issue #81). These tests pin the three properties the
// fix depends on: detection runs, it runs on the pipe the clone then uses, and
// the class it returns is the one that clones and owns the cached image.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let harnessPromise = null;

function getHarness() {
  if (!harnessPromise) {
    harnessPromise = createTestRadioHarness({ repoRoot });
  }
  return harnessPromise;
}

// A synthetic driver module registered under chirp.drivers.* so the bridge's
// normal module/class selection path reaches it. Using a fake driver rather
// than a real one keeps the test about detection wiring instead of about one
// radio's wire protocol.
const INSTALL_FAKE_DRIVER = `
import sys
import types

import chirp.drivers

_events = []


class _FakeBase(chirp_common.CloneModeRadio):
    VENDOR = "WebChirpTest"
    MODEL = "DetectBase"
    BAUD_RATE = 9600
    _memsize = 8
    _fill = 0xA1

    def get_features(self):
        rf = chirp_common.RadioFeatures()
        rf.has_settings = False
        rf.memory_bounds = (0, 0)
        rf.valid_modes = ["FM"]
        return rf

    def get_memory(self, number):
        mem = chirp_common.Memory()
        mem.number = number
        mem.empty = True
        return mem

    def set_memory(self, mem):
        return

    @classmethod
    def detect_from_serial(cls, pipe):
        _events.append(("detect", cls.__name__, id(pipe)))
        return _FakeVariant

    def sync_in(self):
        _events.append(("sync_in", type(self).__name__, id(self.pipe)))
        self._mmap = memmap.MemoryMapBytes(bytes([type(self)._fill] * self._memsize))
        self.process_mmap()

    def sync_out(self):
        _events.append(("sync_out", type(self).__name__, id(self.pipe)))


class _FakeVariant(_FakeBase):
    MODEL = "DetectVariant"
    _fill = 0xB2


class _FakeUndetectable(_FakeBase):
    MODEL = "Undetectable"
    _fill = 0xC3

    # Inherits DetectableInterface.detect_from_serial via CloneModeRadio, whose
    # NotImplementedError is CHIRP's "nothing to detect, use me as selected".
    detect_from_serial = chirp_common.DetectableInterface.detect_from_serial


class _FakeReturnsJunk(_FakeBase):
    MODEL = "ReturnsJunk"

    @classmethod
    def detect_from_serial(cls, pipe):
        return "not-a-class"


class _FakeRaises(_FakeBase):
    MODEL = "Raises"

    @classmethod
    def detect_from_serial(cls, pipe):
        raise errors.RadioNoResponse()


_module = types.ModuleType("chirp.drivers.webchirp_detect_fake")
for _name in ("_FakeBase", "_FakeVariant", "_FakeUndetectable",
              "_FakeReturnsJunk", "_FakeRaises"):
    setattr(_module, _name, locals()[_name])
sys.modules["chirp.drivers.webchirp_detect_fake"] = _module
chirp.drivers.webchirp_detect_fake = _module
`;

async function withFakeDriver(harness, python, vars = {}) {
  return harness.runPythonJson(`${INSTALL_FAKE_DRIVER}\n${python}`, vars);
}

test("detection picks the class and hands it the pipe the clone runs on", async () => {
  const harness = await getHarness();
  const result = await withFakeDriver(
    harness,
    `
_events.clear()
_radio = _create_radio_for_serial(_FakeBase)
json.dumps({
  "instantiated": type(_radio).__name__,
  "pipeId": id(_radio.pipe),
  "events": [list(map(str, e)) for e in _events],
})
    `,
  );

  assert.equal(result.instantiated, "_FakeVariant");
  assert.equal(result.events.length, 1);
  const [kind, detectedOn, detectPipeId] = result.events[0];
  assert.equal(kind, "detect");
  assert.equal(detectedOn, "_FakeBase");
  // The same pipe object, not merely an equivalent one: ga510 and tdh8 leave
  // the radio mid-handshake on the pipe they detected over, and the returned
  // class is expected to carry on from there.
  assert.equal(detectPipeId, String(result.pipeId));
});

test("a driver with nothing to detect clones as the class the user selected", async () => {
  const harness = await getHarness();
  const result = await withFakeDriver(
    harness,
    `
json.dumps({
  "undetectable": _detect_radio_class(_FakeUndetectable, None).__name__,
  "junk": _detect_radio_class(_FakeReturnsJunk, None).__name__,
})
    `,
  );

  assert.equal(result.undetectable, "_FakeUndetectable");
  // A driver that answers with something that is not a radio class is a driver
  // bug, not a reason to abort a clone the selected class can still perform.
  assert.equal(result.junk, "_FakeReturnsJunk");
});

test("a failed detection handshake surfaces instead of cloning blind", async () => {
  const harness = await getHarness();
  const result = await withFakeDriver(
    harness,
    `
try:
    _detect_radio_class(_FakeRaises, None)
    _outcome = "returned"
except errors.RadioNoResponse:
    _outcome = "raised"
json.dumps({"outcome": _outcome})
    `,
  );

  assert.equal(result.outcome, "raised");
});

test("download clones as the detected class and upload reuses it", async () => {
  const harness = await getHarness();
  const result = await withFakeDriver(
    harness,
    `
_events.clear()
_module_name = "webchirp_detect_fake"
_class_name = "_FakeBase"
_download_selected_radio_sync(_module_name, _class_name)
_key = _driver_cache_key(_module_name, _class_name)
_cached = LAST_IMAGE_BY_DRIVER[_key]
_upload_selected_radio_sync(_module_name, _class_name, [])
json.dumps({
  "imageClass": _cached_image_class(_module_name, _class_name, _FakeBase).__name__,
  "cachedFill": list(_cached[:1]),
  "events": [list(map(str, e))[:2] for e in _events],
})
    `,
  );

  // The variant's own fill byte proves the download ran on the detected class.
  assert.deepEqual(result.cachedFill, [0xb2]);
  assert.equal(result.imageClass, "_FakeVariant");
  // Upload does not re-detect -- CHIRP writes back with the class that read the
  // image, and drivers like ga510 send their own handshake from do_upload().
  assert.deepEqual(result.events, [
    ["detect", "_FakeBase"],
    ["sync_in", "_FakeVariant"],
    ["sync_out", "_FakeVariant"],
  ]);
});

// The radio session: one object per radio the user is working on.
//
// Every radio-bound RPC method takes a session_id
// (web/python/webchirp_bridge/session.py) instead of a driver name, and the
// session owns what used to be three module-level dicts keyed by driver: the
// clone image and where it came from, the class detection resolved to, and
// the channels the driver could not decode. These tests pin the contract that
// replaced those dicts -- open/close and the registry, a call on a closed
// session failing as a precondition, the upload gate reading the image's
// origin rather than its presence, and undecodable channels protecting only
// the session that recorded them -- and, on the browser side
// (web/js/ui/radio-session.js), that a response for a session the selection
// has moved on from is dropped by identity rather than by counting.

import assert from "node:assert/strict";
import test from "node:test";

import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import {
  createDeferred,
  flushMicrotasks,
  installFakeDom,
  selectRadioBySearch,
} from "../support/fake-dom.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const DRIVER = { module: "uv5r", className: "BaofengUV5R" };

// A clone-mode driver whose clone touches no wire, registered under
// chirp.drivers.* so open_radio_session imports it like any other. sync_in
// fills the map with a known byte and sync_out records what it would have
// written, so a test can tell a download from an export and count uploads.
const INSTALL_FAKE_DRIVER = `
import sys
import types

import chirp.drivers

_writes = []


class _SessionFake(chirp_common.CloneModeRadio):
    VENDOR = "WebChirpTest"
    MODEL = "SessionFake"
    BAUD_RATE = 9600
    _memsize = 16

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

    def sync_in(self):
        self._mmap = memmap.MemoryMapBytes(bytes([0x5A] * self._memsize))
        self.process_mmap()

    def sync_out(self):
        _writes.append(bytes(self._mmap.get_packed()))


_module = types.ModuleType("chirp.drivers.webchirp_session_fake")
_module._SessionFake = _SessionFake
sys.modules["chirp.drivers.webchirp_session_fake"] = _module
chirp.drivers.webchirp_session_fake = _module
`;

test("a session opens for a driver, describes itself, and closes exactly once", async () => {
  const harness = await sharedHarness();
  await ensureModule(harness, DRIVER.module);

  const opened = await harness.rpc("open_session", {
    module_name: DRIVER.module,
    class_name: DRIVER.className,
  });
  assert.ok(opened.sessionId, "open_session should hand back an id");
  assert.match(opened.sessionId, /^uv5r\.BaofengUV5R:/, "the id names its driver for the debug panel");
  assert.equal(opened.module, DRIVER.module);
  assert.equal(opened.className, DRIVER.className);
  assert.equal(opened.imageOrigin, "none");
  assert.equal(opened.hasBackingImage, false);
  assert.equal(opened.detectedClass, "");
  assert.deepEqual(opened.unreadableChannels, []);

  // Two opens for the same driver are two sessions: the id is what the
  // browser tells a current response from a stale one by.
  const second = await harness.rpc("open_session", {
    module_name: DRIVER.module,
    class_name: DRIVER.className,
  });
  assert.notEqual(second.sessionId, opened.sessionId);

  const registered = await harness.runPythonJson("json.dumps(open_session_ids())");
  assert.ok(registered.includes(opened.sessionId));
  assert.ok(registered.includes(second.sessionId));

  assert.deepEqual(await harness.rpc("close_session", { session_id: opened.sessionId }), {
    closed: true,
    sessionId: opened.sessionId,
  });
  // Closing again is not an error: the browser closes the previous selection's
  // session without knowing whether it ever finished opening.
  assert.deepEqual(await harness.rpc("close_session", { session_id: opened.sessionId }), {
    closed: false,
    sessionId: opened.sessionId,
  });
  const remaining = await harness.runPythonJson("json.dumps(open_session_ids())");
  assert.ok(!remaining.includes(opened.sessionId));
  assert.ok(remaining.includes(second.sessionId));
  await harness.rpc("close_session", { session_id: second.sessionId });
});

test("a call on a closed session fails as a precondition that names the session", async () => {
  const harness = await sharedHarness();
  await ensureModule(harness, DRIVER.module);
  const { sessionId } = await harness.rpc("open_session", {
    module_name: DRIVER.module,
    class_name: DRIVER.className,
  });
  await harness.rpc("close_session", { session_id: sessionId });

  for (const [method, params] of [
    ["get_radio_column_metadata", {}],
    ["get_radio_settings", {}],
    ["validate_radio_settings", { settings_groups: [] }],
    ["get_channel_extra", { location: "1" }],
    ["export_image_base64", { rows: [], settings_groups: [] }],
    ["get_cached_image_base64", {}],
    ["download_selected_radio", {}],
    ["upload_selected_radio", { rows: [], settings_groups: [] }],
    ["normalize_rows", { rows: [] }],
    ["validate_rows_for_upload", { rows: [] }],
  ]) {
    await assert.rejects(
      harness.rpc(method, { session_id: sessionId, ...params }),
      (error) => {
        const message = String(error?.message || error);
        assert.match(message, /RuntimePreconditionError/, `${method}: not a precondition error`);
        assert.ok(message.includes(sessionId), `${method}: the message should name the session`);
        assert.match(message, /is not open/, method);
        return true;
      },
    );
  }

  // An id that was never handed out fails the same way.
  await assert.rejects(
    harness.rpc("get_radio_settings", { session_id: "never-opened" }),
    /RuntimePreconditionError.*never-opened.*is not open/s,
  );

  // The two methods that work without a radio read an empty id as "none
  // selected", which is a choice rather than a closed session.
  const csv = await harness.rpc("normalize_rows", { rows: [], session_id: "" });
  assert.match(csv, /^Location,Name,Frequency/);
  const preflight = await harness.rpc("validate_rows_for_upload", { rows: [], session_id: "" });
  assert.equal(preflight.valid, true);

  // A driver that does not exist fails at open time, not on the first call.
  await assert.rejects(
    harness.rpc("open_session", { module_name: "no_such_driver", class_name: "Nope" }),
    /ModuleNotFoundError/,
  );
});

test("upload is refused on a synthetic export and allowed on a downloaded image", async () => {
  const harness = await sharedHarness();
  const result = await harness.runPythonJson(`${INSTALL_FAKE_DRIVER}
_writes.clear()
_session = open_radio_session("webchirp_session_fake", "_SessionFake")

# Offline export: a file the user may keep, recorded for what it is.
_exported = export_image_base64(_session.session_id, [], [])
_after_export = _session.describe()
try:
    get_cached_image_base64(_session.session_id)
    _cached_error = ""
except Exception as _exc:
    _cached_error = str(_exc)
try:
    _upload_selected_radio_sync(_session, [])
    _refused = ""
except RuntimePreconditionError as _exc:
    _refused = str(_exc)
_writes_after_refusal = len(_writes)

# A download puts a radio image on the same session, and the write goes out.
_download_selected_radio_sync(_session)
_after_download = _session.describe()
_upload_selected_radio_sync(_session, [])
_after_upload = _session.describe()
_cached = get_cached_image_base64(_session.session_id)
close_session(_session.session_id)
json.dumps({
    "exportSize": _exported["size"],
    "afterExport": _after_export,
    "cachedError": _cached_error,
    "refused": _refused,
    "writesAfterRefusal": _writes_after_refusal,
    "afterDownload": _after_download,
    "afterUpload": _after_upload,
    "writes": len(_writes),
    "cachedSize": _cached["size"],
    "writtenFill": list(_writes[0][:1]) if _writes else [],
})
  `);

  assert.ok(result.exportSize > 0, "the offline export still produces a file");
  assert.equal(result.afterExport.imageOrigin, "synthetic");
  assert.equal(result.afterExport.hasBackingImage, false);
  assert.match(result.cachedError, /No cached radio image/);
  assert.match(result.refused, /Download from radio first/);
  assert.equal(result.writesAfterRefusal, 0, "a refused upload must not reach sync_out");

  assert.equal(result.afterDownload.imageOrigin, "radio");
  assert.equal(result.afterDownload.hasBackingImage, true);
  assert.equal(result.writes, 1, "the upload after the download reaches the radio");
  assert.deepEqual(result.writtenFill, [0x5a], "what is written is the downloaded image");
  assert.equal(result.afterUpload.imageOrigin, "radio", "an upload keeps the image's origin");
  assert.ok(result.cachedSize > 0);
});

test("undecodable channels protect the session that recorded them, and no other", async () => {
  const harness = await sharedHarness();
  await ensureModule(harness, "h777");
  const result = await harness.runPythonJson(`
_cls = _import_radio_class("h777", "H777Radio")

def _seeded():
    _radio = _cls(None)
    _radio._mmap = memmap.MemoryMapBytes(bytes(_radio._memsize))
    _radio.process_mmap()
    for _number, _freq in ((1, 446006250), (2, 446093750)):
        _mem = chirp_common.Memory()
        _mem.number = _number
        _mem.freq = _freq
        _mem.mode = "FM"
        _radio.set_memory(_mem)
    return _radio

_rows, _ = _radio_rows_from_instance(_seeded())
_rows_without_2 = [_row for _row in _rows if _row["Location"] != "2"]

# The session whose read could not decode channel 2: its absence from the
# rows is not a deletion.
_protected = open_radio_session("h777", "H777Radio")
_record_session_image(_protected, _seeded(), ImageOrigin.RADIO)
_protected.record_unreadable_channels([2])
_kept = load_image_base64(
    export_image_base64(_protected.session_id, _rows_without_2, [])["imageBase64"]
)

# Another session for the same driver and the same image, which read it
# cleanly: there the same rows mean channel 2 was deleted.
_other = open_radio_session("h777", "H777Radio")
_record_session_image(_other, _seeded(), ImageOrigin.RADIO)
_lost = load_image_base64(
    export_image_base64(_other.session_id, _rows_without_2, [])["imageBase64"]
)

# A later clean read of the protected session drops the protection.
_protected.record_unreadable_channels([])
_dropped = load_image_base64(
    export_image_base64(_protected.session_id, _rows_without_2, [])["imageBase64"]
)

_state = {"protected": _protected.describe(), "other": _other.describe()}
for _sid in (_protected.session_id, _other.session_id, _kept["sessionId"],
             _lost["sessionId"], _dropped["sessionId"]):
    close_session(_sid)
json.dumps({
    "kept": sorted(int(_row["Location"]) for _row in _kept["rows"]),
    "lost": sorted(int(_row["Location"]) for _row in _lost["rows"]),
    "dropped": sorted(int(_row["Location"]) for _row in _dropped["rows"]),
    "state": _state,
})
  `);

  assert.deepEqual(result.kept, [1, 2], "the undecodable channel survives the export");
  assert.deepEqual(result.lost, [1], "another session's export erases it as a deletion");
  assert.deepEqual(result.dropped, [1], "protection ends with the next clean read");
  assert.deepEqual(result.state.protected.unreadableChannels, []);
  assert.deepEqual(result.state.other.unreadableChannels, []);
});

const CATALOG = [
  { vendor: "SlowCo", model: "Slow", module: "slow", className: "SlowRadio", key: "slow:SlowRadio", isLiveRadio: false },
  { vendor: "FastCo", model: "Fast", module: "fast", className: "FastRadio", key: "fast:FastRadio", isLiveRadio: false },
];

const EMPTY_SETTINGS = { supported: false, available: false, requiresImage: false, message: "", groups: [] };

function tableHeaderTexts(document) {
  const headerRow = document.querySelector("#mem-table thead").children[0];
  return (headerRow?.children || []).map((th) => th.textContent);
}

test("the UI drops a response for a session it has since closed, and reuses a loaded one", async () => {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const slowMetadata = createDeferred();
  const opens = [];
  const closes = [];

  const api = withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async ({ module }) => {
      if (module === "slow") {
        return slowMetadata.promise;
      }
      return { headers: ["Location", "FastHeader"], columns: {} };
    },
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });
  // Observe the session calls the wrapper answers, without replacing them.
  const open = api.openRadioSession;
  const close = api.closeRadioSession;
  api.openRadioSession = async (payload) => {
    const result = await open(payload);
    opens.push({ module: payload.module, sessionId: result.sessionId });
    return result;
  };
  api.closeRadioSession = async (payload) => {
    closes.push(payload.sessionId);
    return close(payload);
  };
  ui.setRuntimeApi(api);
  await ui.init(true);

  // Selecting Slow opens a session; its metadata stays in flight.
  selectRadioBySearch(document, "SlowCo Slow");
  await flushMicrotasks();
  assert.equal(opens.length, 1);
  assert.equal(opens[0].module, "slow");
  const slowSession = opens[0].sessionId;

  // Moving on to Fast closes Slow's session and opens Fast's own.
  selectRadioBySearch(document, "FastCo Fast");
  await flushMicrotasks();
  assert.deepEqual(closes, [slowSession]);
  assert.equal(opens.length, 2);
  assert.equal(opens[1].module, "fast");
  assert.ok(tableHeaderTexts(document).includes("FastHeader"));

  // Slow's answer arrives for a session that is closed: nothing applies it.
  slowMetadata.resolve({ headers: ["Location", "SlowHeader"], columns: {} });
  await flushMicrotasks();
  const headers = tableHeaderTexts(document);
  assert.ok(headers.includes("FastHeader"));
  assert.ok(!headers.includes("SlowHeader"));

  // Reselecting the loaded radio keeps its session: no open, no close.
  selectRadioBySearch(document, "FastCo Fast");
  await flushMicrotasks();
  assert.equal(opens.length, 2);
  assert.deepEqual(closes, [slowSession]);
});

test("an image load hands its session to the selection it makes", async () => {
  const { document, window } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const metadataSessions = [];
  const closes = [];

  const api = withRadioSessions({
    listRadios: async () => ({ radios: CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name", "Frequency"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
    loadImage: async () => ({
      module: "fast",
      className: "FastRadio",
      vendor: "FastCo",
      model: "Fast",
      headers: ["Location", "Name", "Frequency"],
      rows: [{ Location: "1", Name: "FromImg", Frequency: "146.000000" }],
      settings: [],
    }),
  });
  const metadata = api.getRadioMetadata;
  api.getRadioMetadata = async (payload) => {
    metadataSessions.push(payload.sessionId);
    return metadata(payload);
  };
  const close = api.closeRadioSession;
  api.closeRadioSession = async (payload) => {
    closes.push(payload.sessionId);
    return close(payload);
  };
  ui.setRuntimeApi(api);
  await ui.init(true);

  // A radio selected by hand, then an image for another driver dropped in.
  selectRadioBySearch(document, "SlowCo Slow");
  await flushMicrotasks();
  const slowSession = metadataSessions.at(-1);
  assert.match(slowSession, /^slow:SlowRadio#/);

  await window.emit("drop", {
    dataTransfer: {
      types: ["Files"],
      files: [{ name: "codeplug.img", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }],
    },
  });
  await flushMicrotasks();

  // The schema was read through the session the load opened for the image's
  // driver -- the one holding the image -- and the hand-picked radio's session
  // was closed when the selection moved to the image's radio.
  const imageSession = metadataSessions.at(-1);
  assert.match(imageSession, /^fast:FastRadio#/);
  assert.deepEqual(closes, [slowSession]);
  assert.deepEqual(ui.selectedRowsForOperations().map((row) => row.Name), ["FromImg"]);

  // Reselecting the image's radio keeps the image's session and asks nothing.
  selectRadioBySearch(document, "FastCo Fast");
  await flushMicrotasks();
  assert.equal(metadataSessions.at(-1), imageSession);
  assert.equal(metadataSessions.filter((id) => id === imageSession).length, 1);
});

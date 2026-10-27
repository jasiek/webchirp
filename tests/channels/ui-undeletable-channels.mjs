import assert from "node:assert/strict";
import test from "node:test";

// Desktop CHIRP refuses to delete or cut a memory whose driver lists "empty"
// as immutable ("Memory %i is not deletable", chirp/chirp/wxui/memedit.py),
// and an upload that omits one keeps it on the radio. The grid used to let
// the user delete such a row anyway, so the deletion silently did not happen
// (Sentry WEBCHIRP-FRONTEND-2N, a GM-15Pro with its fixed GMRS channels).
//
// The page is index.html in jsdom, and what it is handed is the real
// runtime's: the GM-15Pro's rows and column metadata read from CHIRP's GM-30
// test image (the GM-15Pro inherits its layout), and the per-edit check
// answered by normalize_and_validate_rows itself. Only the transport between
// them is a stub, so the Location column's "undeletable" list is checked
// from the driver to the status line.
import { readImage, sharedHarness } from "../support/chirp.mjs";
import { installIndexPage } from "../support/index-page.mjs";
import {
  channelRows,
  clickLocationButton,
  dispatch,
  emit,
  flushMicrotasks,
} from "../support/ui-interactions.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";

const MODULE = "radioddity_gm30";
const CLASS_NAME = "BaofengGM15Pro";

// An image load of the GM-30 image into a GM-15Pro session, as
// load_image_base64 does once it has detected the driver. The session stays
// open for the per-edit check.
const LOAD_PROBE = `
import base64, json

ensure_radio_module(_module)
_cls = _import_radio_class(_module, _class_name)
_session = open_radio_session(_module, _class_name)
_session.record_image(base64.b64decode(_image_b64), _cls, ImageOrigin.FILE)
_payload = _read_radio_payload(_session, _session.radio_instance(), ImageOrigin.FILE)
json.dumps({
    "sessionId": _session.session_id,
    "vendor": _cls.VENDOR,
    "model": _cls.MODEL,
    "rows": _payload["rows"],
    "headers": _payload["headers"],
    "metadata": get_radio_column_metadata(_session.session_id),
})
`;

async function loadGm15Pro(t) {
  const harness = await sharedHarness();
  const raw = await readImage("Radioddity_GM-30.img");
  const loaded = await harness.runPythonJson(LOAD_PROBE, {
    _image_b64: raw.toString("base64"),
    _module: MODULE,
    _class_name: CLASS_NAME,
  });
  t.after(() => harness.rpc("close_session", { session_id: loaded.sessionId }));
  return { harness, loaded };
}

// The page with the GM-15Pro image dropped on it. checks holds every
// per-edit call the grid made, for a test to await the runtime's answers.
async function pageWithImage(t) {
  const { harness, loaded } = await loadGm15Pro(t);
  const checks = [];
  const { document, window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  const radio = {
    vendor: loaded.vendor,
    model: loaded.model,
    module: MODULE,
    className: CLASS_NAME,
    key: `${MODULE}:${CLASS_NAME}`,
    isLiveRadio: false,
  };
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [radio] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: loaded.headers, columns: {} }),
    getRadioMetadata: async () => loaded.metadata,
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    loadImage: async () => ({
      module: MODULE,
      className: CLASS_NAME,
      vendor: loaded.vendor,
      model: loaded.model,
      headers: loaded.headers,
      rows: loaded.rows.map((row) => ({ ...row })),
      settings: [],
      unreadableChannels: [],
    }),
    normalizeAndValidateRows: ({ rows }) => {
      const check = harness.rpc("normalize_and_validate_rows", { session_id: loaded.sessionId, rows });
      checks.push(check);
      return check;
    },
  }));
  await ui.init(true);
  const file = { name: "gm15pro.img", arrayBuffer: async () => new Uint8Array([0]).buffer };
  await emit(window, "drop", { dataTransfer: { types: ["Files"], files: [file] } });
  await flushMicrotasks();
  return { document, window, loaded, checks };
}

function locations(document) {
  return channelRows(document).map((tr) => tr.children[0].children[0].textContent.trim());
}

function rowIndexOf(document, location) {
  return locations(document).indexOf(String(location));
}

function lastStatus(document) {
  const lines = document.querySelector("#debug-output").value.split("\n");
  return lines.filter((line) => line.includes("STATUS ")).at(-1)?.replace(/^.*STATUS /, "") ?? "";
}

function cell(document, rowIdx, column) {
  return Array.from(channelRows(document)[rowIdx].children).find((td) => td.dataset.column === column);
}

test("a fixed channel cannot be removed, alone or with an ordinary one", async (t) => {
  const { document, loaded } = await pageWithImage(t);
  const before = locations(document);
  assert.equal(before.length, loaded.rows.length, "every channel of the image is in the grid");
  assert.equal(before[0], "1");
  const ordinary = before.find((location) => Number(location) > 54);
  assert.ok(ordinary, "the fixture should hold an ordinary channel");

  clickLocationButton(document, 0);
  await dispatch(document.querySelector("#channel-remove"), "click");
  assert.deepEqual(locations(document), before);
  assert.equal(lastStatus(document), "Channel 1 cannot be deleted on this radio; nothing was removed.");

  // Channel 54 and the ordinary channel after it: the whole removal is
  // refused, as desktop CHIRP refuses a cut, rather than half done.
  clickLocationButton(document, rowIndexOf(document, 54));
  clickLocationButton(document, rowIndexOf(document, ordinary), { shiftKey: true });
  await dispatch(document.querySelector("#channel-remove"), "click");
  assert.deepEqual(locations(document), before);
  assert.equal(lastStatus(document), "Channel 54 cannot be deleted on this radio; nothing was removed.");

  clickLocationButton(document, rowIndexOf(document, ordinary));
  await dispatch(document.querySelector("#channel-remove"), "click");
  assert.deepEqual(locations(document), before.filter((location) => location !== ordinary));
  assert.equal(lastStatus(document), "Removed 1 selected channel(s).");
});

test("a fixed channel cannot be cut, and nothing reaches the clipboard", async (t) => {
  const { document, window } = await pageWithImage(t);
  const before = locations(document);
  const written = [];
  window.navigator.clipboard = { writeText: async (text) => { written.push(text); } };

  clickLocationButton(document, 0);
  clickLocationButton(document, 3, { shiftKey: true });
  await dispatch(document.querySelector("#channel-cut"), "click");
  assert.deepEqual(written, []);
  assert.deepEqual(locations(document), before);
  assert.equal(lastStatus(document), "Channels 1, 2, 3 and 1 more cannot be deleted on this radio; nothing was cut.");

  // The keyboard's cut, which writes the event's clipboardData instead.
  const clipboard = new Map();
  await dispatch(document.body, "cut", { clipboardData: { setData: (type, text) => clipboard.set(type, text) } });
  assert.equal(clipboard.size, 0);
  assert.deepEqual(locations(document), before);
  assert.match(lastStatus(document), /cannot be deleted on this radio; nothing was cut\.$/);
});

test("clearing a fixed channel's Frequency keeps it, with the reason on the cell", async (t) => {
  const { document, loaded, checks } = await pageWithImage(t);
  const frequency = loaded.rows.find((row) => row.Location === "1").Frequency;

  const editor = cell(document, 0, "Frequency").children[0];
  editor.value = "";
  editor.focus();
  editor.blur();
  await flushMicrotasks();
  assert.equal(checks.length, 1, "the cleared cell went to the runtime");
  await Promise.all(checks);
  await flushMicrotasks();

  const committed = cell(document, 0, "Frequency");
  assert.equal(committed.children[0].value, frequency);
  assert.equal(committed.classList.contains("is-pending"), false);
  assert.equal(committed.title, "Channel 1 cannot be deleted on this radio; kept the previous value");
});

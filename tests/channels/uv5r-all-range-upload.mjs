import assert from "node:assert/strict";
import test from "node:test";

import { isPythonError } from "../../web/js/runtime-errors.ts";
import { readCatalog, readImage, sharedHarness, loadImageFor } from "../support/chirp.mjs";
import { SimulatedUv5rBridge } from "../support/simulated-uv5r.mjs";

// CHIRP's uv5r driver reports a finished upload with the Range Override
// Parameter set ("UseAtOwnRisk") by raising a RadioError that says it is not
// an error (_do_upload in chirp/chirp/drivers/uv5r.py). Treated as a failure,
// the user saw an upload error after a write that had reached the radio
// (Sentry WEBCHIRP-FRONTEND-22). These tests run the real
// driver against a simulated radio, through the same RPC the browser calls:
// the finished upload succeeds and is recorded on the session, and a real
// failure on the same path still fails. The fix is a workaround
// (web/python/webchirp_bridge/workarounds/uv5r.py); the last test shows the
// driver still needs it.

const IMAGE = "Baofeng_UV-5R.img";
const OVERRIDE = "UseAtOwnRisk";
const EDITED_NAME = "ALLRNG";

// Every radio address uv5r sends with the override set: its _ranges_main
// (image 0x0008-0x1808, radio 0x0000-0x1800) and _ranges_aux (0x1EC0-0x2000),
// in 0x10-byte blocks.
const ALL_RANGE_ADDRESSES = [
  ...Array.from({ length: 0x1800 / 0x10 }, (_, i) => i * 0x10),
  ...Array.from({ length: 0x140 / 0x10 }, (_, i) => 0x1ec0 + i * 0x10),
];

// The serialized settings with the Range Override Parameter set, the way the
// settings panel submits it when the user types the value.
function withRangeOverride(groups) {
  let found = false;
  const visit = (node) => {
    if (node.kind === "setting" && node.id === "allrange") {
      found = true;
      return { ...node, values: node.values.map((value) => ({ ...value, current: OVERRIDE })) };
    }
    return node.children ? { ...node, children: node.children.map(visit) } : node;
  };
  const edited = groups.map(visit);
  assert.ok(found, "the uv5r settings should carry the Range Override Parameter");
  return edited;
}

// A booted runtime whose serial port is a simulated UV-5R holding the test
// image, with that image loaded into a session as a user's file load would.
async function loadOntoSimulatedRadio(bridgeOptions = {}) {
  const image = await readImage(IMAGE);
  const radio = new SimulatedUv5rBridge(image, bridgeOptions);
  const harness = await sharedHarness({ serialBridge: radio });
  const { loaded } = await loadImageFor(harness, await readCatalog(), IMAGE);
  // uv5r paces every block with time.sleep(0.05), which Pyodide busy-waits:
  // 404 blocks spent 20 s idle against a radio that answers at once. A custom
  // bridge gets a runtime of its own, so no other test sees the patch.
  await harness.runPython(`
import types
import chirp.drivers.uv5r as _uv5r
_uv5r.time = types.SimpleNamespace(sleep=lambda _seconds: None)
`);
  return { harness, radio, loaded };
}

test("a uv5r upload with the range override finishes as a success", async () => {
  const { harness, radio, loaded } = await loadOntoSimulatedRadio();
  const firstIndex = loaded.rows.findIndex((row) => String(row.Frequency || "").trim());
  assert.ok(firstIndex >= 0, `${IMAGE} should hold at least one channel`);
  const rows = loaded.rows.map((row, index) =>
    index === firstIndex ? { ...row, Name: EDITED_NAME } : row,
  );

  const result = await harness.rpc("upload_selected_radio", {
    session_id: loaded.sessionId,
    rows,
    settings_groups: withRangeOverride(loaded.settings),
  });

  assert.equal(result.uploaded, true);
  // The driver really sent every range before it raised: this is the finished
  // upload, not one abandoned part way that happened to look the same.
  assert.deepEqual(radio.writtenAddresses, ALL_RANGE_ADDRESSES);
  // The session holds what was written, as after any upload: a download or an
  // export that follows starts from the radio's new contents.
  const cached = await harness.rpc("get_cached_image_base64", { session_id: loaded.sessionId });
  const sessionImage = Buffer.from(cached.imageBase64, "base64");
  assert.ok(sessionImage.includes(Buffer.from(EDITED_NAME)), "the session should hold the uploaded edit");
  assert.ok(Buffer.from(radio.memory).includes(Buffer.from(EDITED_NAME)), "the radio should hold the uploaded edit");
});

test("a uv5r upload with the range override that the radio refuses still fails", async () => {
  // Refused part way through the main block, before the driver's success
  // report: the override is set, but this RadioError is a real failure.
  const { harness, radio, loaded } = await loadOntoSimulatedRadio({ refuseWriteAt: 0x0800 });

  await assert.rejects(
    harness.rpc("upload_selected_radio", {
      session_id: loaded.sessionId,
      rows: loaded.rows,
      settings_groups: withRangeOverride(loaded.settings),
    }),
    (error) => {
      assert.ok(isPythonError(error, "RadioError"), `expected a RadioError, got ${error}`);
      assert.match(error.message, /refused to accept block 0x0800/);
      return true;
    },
  );
  assert.equal(radio.writtenAddresses.at(-1), 0x07f0);
});

test("without its workaround, the uv5r driver still reports a finished override upload as an error", async () => {
  // When this fails, the pinned CHIRP no longer raises after a finished
  // override upload (kk7ds/chirp#1677): delete workarounds/uv5r.py, its entry
  // in the sync_out hook, and this test.
  const { harness, radio, loaded } = await loadOntoSimulatedRadio();
  // This runtime is the test's own (a custom bridge is never shared), so
  // emptying the hook's table reaches no other test.
  await harness.runPython(`
import webchirp_bridge.workarounds as _workarounds
_workarounds._SYNC_OUT.clear()
`);

  await assert.rejects(
    harness.rpc("upload_selected_radio", {
      session_id: loaded.sessionId,
      rows: loaded.rows,
      settings_groups: withRangeOverride(loaded.settings),
    }),
    (error) => {
      assert.ok(isPythonError(error, "RadioError"), `expected a RadioError, got ${error}`);
      assert.match(error.message, /This is NOT an error/);
      return true;
    },
  );
  assert.deepEqual(radio.writtenAddresses, ALL_RANGE_ADDRESSES);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

// The browser can only re-rate the port if Python tells it which rate the
// driver wants. This covers that hand-off: _prepare_clone_session() has to send
// the selected driver's BAUD_RATE on every clone, because the port may have
// been opened for a different radio (issue #76). The reopen itself is covered
// by scripts/test-clone-baud-rate.mjs.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Two clone-mode drivers whose declared rates differ by more than a decimal
// point: cloning one at the other's rate returns timeouts or garbage.
const SLOW_RADIO = { module: "uv5r", className: "BaofengUV5R", baudRate: 9600 };
const FAST_RADIO = { module: "retevis_ra25", className: "RA25UVRadio", baudRate: 115200 };

let harnessPromise = null;

function getHarness() {
  if (!harnessPromise) {
    harnessPromise = createTestRadioHarness({ repoRoot });
  }
  return harnessPromise;
}

async function prepareCloneFor(harness, radio) {
  await harness.runPythonJson(
    `
ensure_radio_module(_sel_module)
_cls = _import_radio_class(_sel_module, _sel_class)
_prepare_clone_session(_cls)
json.dumps({"prepared": True})
    `,
    { _sel_module: radio.module, _sel_class: radio.className },
  );
  return harness.serialBridge.prepareCloneCalls.at(-1);
}

test("preparing a clone sends the selected driver's declared baud rate", async () => {
  const harness = await getHarness();

  const slow = await prepareCloneFor(harness, SLOW_RADIO);
  assert.equal(slow.baudRate, SLOW_RADIO.baudRate);

  // The same session, a different radio: the rate has to follow the driver,
  // not the one the port was connected with.
  const fast = await prepareCloneFor(harness, FAST_RADIO);
  assert.equal(fast.baudRate, FAST_RADIO.baudRate);

  // The rest of the clone preflight is unchanged by the added argument.
  assert.equal(fast.settleMs, 350);
  assert.equal(typeof fast.wantsDtr, "boolean");
  assert.equal(typeof fast.wantsRts, "boolean");
});

test("a driver that declares no baud rate leaves the open port's rate alone", async () => {
  const harness = await getHarness();
  const call = await harness.runPythonJson(
    `
class _NoBaudRadio:
    WANTS_DTR = True
    WANTS_RTS = True

_prepare_clone_session(_NoBaudRadio)
json.dumps({"baudRate": _driver_baud_rate(_NoBaudRadio)})
    `,
  );
  // 0 is the bridge's "keep what you have"; None would reach JS as null and
  // reopen at a made-up default.
  assert.equal(call.baudRate, null);
  assert.equal(harness.serialBridge.prepareCloneCalls.at(-1).baudRate, 0);
});

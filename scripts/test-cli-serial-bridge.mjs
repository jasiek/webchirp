import assert from "node:assert/strict";
import test from "node:test";
import { NodeSerialBridge } from "./test-radio-harness.mjs";

// The serial bridge behind the agent CLI (npm run radio:read / radio:write).
// It has the same two entry points as the browser bridge -- a clone-start
// re-rate and a mid-clone reconfigure -- and the same way of getting them
// wrong: two records of the port's settings that disagree, so one path skips a
// change the other already made.

// A stand-in for the node-serialport handle, recording update() calls. Enough
// for the settings bookkeeping, which is where the bug was; the open/close path
// needs a real device.
function attachFakePort(bridge, { baudRate = 9600 } = {}) {
  const updates = [];
  bridge.port = {
    isOpen: true,
    update(options, cb) {
      updates.push({ ...options });
      cb(null);
    },
  };
  bridge.portOptions = { baudRate, dataBits: 8, stopBits: 1, parity: "none" };
  return updates;
}

test("the reported rate is derived from the port settings, not cached beside them", async () => {
  const bridge = new NodeSerialBridge("/dev/fake");
  attachFakePort(bridge);

  await bridge.reconfigure({ baudRate: 57600 });

  assert.equal(bridge.baudRate, 57600);
  assert.equal(bridge.portOptions.baudRate, 57600);
});

// The drift this replaced: reconfigure() moved one record and applyBaudRate()
// compared the other, so the clone after a mid-clone rate change ran at the
// previous driver's rate.
test("a clone after a mid-clone rate change still re-rates the port", async () => {
  const bridge = new NodeSerialBridge("/dev/fake");
  const updates = attachFakePort(bridge);

  await bridge.reconfigure({ baudRate: 57600 });
  const applied = await bridge.applyBaudRate(9600);

  assert.equal(applied.changed, true, "the port must be taken back to 9600");
  assert.equal(bridge.baudRate, 9600);
  assert.deepEqual(updates.map((u) => u.baudRate), [57600, 9600]);
});

test("a clone at the settings the port already has does not touch it", async () => {
  const bridge = new NodeSerialBridge("/dev/fake");
  const updates = attachFakePort(bridge);

  const applied = await bridge.applyBaudRate(9600);

  assert.equal(applied.changed, false);
  assert.deepEqual(updates, []);
});

// update() carries only the baud rate, so framing has to go through a reopen.
// Reporting it as applied without one is what the browser bridge refuses to do
// on adapters that cannot honour it, and what this used to do silently.
test("a framing change is not reported as applied through update()", async () => {
  const bridge = new NodeSerialBridge("/dev/fake");
  const updates = attachFakePort(bridge);
  // The reopen needs a real device, so this only pins that update() is not
  // silently used for framing; the reopen path itself needs hardware.
  await assert.rejects(() => bridge.reconfigure({ parity: "even" }));
  assert.deepEqual(updates, [], "framing must never be smuggled through update()");
  assert.equal(bridge.portOptions.parity, "none", "settings must record only what landed");
});

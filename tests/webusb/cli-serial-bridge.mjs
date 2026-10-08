import assert from "node:assert/strict";
import test from "node:test";
import { SerialPortMock } from "serialport";
import { NodeSerialBridge } from "../support/radio-harness.mjs";

// The serial bridge behind the agent CLI (npm run radio:read / radio:write):
// the browser's SerialBridge over node-serialport. It has the same two entry
// points as the browser -- a clone-start re-rate and a mid-clone reconfigure --
// and the same way of getting them wrong: two records of the port's settings
// that disagree, so one path skips a change the other already made.
//
// serialport's SerialPortMock runs the real stream code over MockBinding, so
// the open/close path, update() and the framing reopen are all exercised
// without a device.

const MockBinding = SerialPortMock.binding;
let portCounter = 0;

// Open a bridge on a fresh echoing mock tty and record every update() the
// bridge sends through its node-serialport handle.
async function openBridge(t) {
  const path = `/dev/cli-bridge-${portCounter += 1}`;
  MockBinding.createPort(path, { echo: true });
  const bridge = new NodeSerialBridge(path, { SerialPortClass: SerialPortMock });
  t.after(async () => {
    await bridge.close();
  });
  await bridge.open(9600);
  const updates = [];
  const handle = bridge.port.nodePort;
  const update = handle.update.bind(handle);
  handle.update = (options, callback) => {
    updates.push({ ...options });
    return update(options, callback);
  };
  return { bridge, updates };
}

// What the mock device was actually opened or re-rated with.
function deviceSettings(bridge) {
  return bridge.port.nodePort.port.port.openOpt;
}

test("the reported rate is derived from the port settings, not cached beside them", async (t) => {
  const { bridge } = await openBridge(t);

  await bridge.reconfigure({ baudRate: 57600 });

  assert.equal(bridge.baudRate, 57600);
  assert.equal(bridge.portOptions.baudRate, 57600);
  assert.equal(deviceSettings(bridge).baudRate, 57600);
});

// The drift this replaced: reconfigure() moved one record and applyBaudRate()
// compared the other, so the clone after a mid-clone rate change ran at the
// previous driver's rate.
test("a clone after a mid-clone rate change still re-rates the port", async (t) => {
  const { bridge, updates } = await openBridge(t);

  await bridge.reconfigure({ baudRate: 57600 });
  const applied = await bridge.applyBaudRate(9600);

  assert.equal(applied.changed, true, "the port must be taken back to 9600");
  assert.equal(bridge.baudRate, 9600);
  assert.deepEqual(updates.map((u) => u.baudRate), [57600, 9600]);
});

test("a clone at the settings the port already has does not touch it", async (t) => {
  const { bridge, updates } = await openBridge(t);

  const applied = await bridge.applyBaudRate(9600);

  assert.equal(applied.changed, false);
  assert.deepEqual(updates, []);
});

// update() carries only the baud rate, so a framing change reopens the handle
// -- underneath the bridge's reader, which the transport keeps -- and is never
// smuggled through update() and reported as applied.
test("a framing change reopens the handle, not update(), and lands on the device", async (t) => {
  const { bridge, updates } = await openBridge(t);
  const reader = bridge.reader;

  await bridge.reconfigure({ parity: "even" });

  assert.deepEqual(updates, [], "framing must never be smuggled through update()");
  assert.equal(deviceSettings(bridge).parity, "even");
  assert.equal(bridge.portOptions.parity, "even");
  assert.equal(bridge.reader, reader, "the in-place reconfigure keeps the bridge's reader");

  // The reopened handle carries traffic through the same streams.
  await bridge.writeBytes([0x51, 0x58]);
  assert.deepEqual(await bridge.readBytes(2, 500), [0x51, 0x58]);
});

test("the connect result names the tty", async (t) => {
  const path = `/dev/cli-bridge-${portCounter += 1}`;
  MockBinding.createPort(path, { echo: true });
  const bridge = new NodeSerialBridge(path, { SerialPortClass: SerialPortMock });
  t.after(() => bridge.close());

  const result = await bridge.open(19200);

  assert.equal(result.connected, true);
  assert.equal(result.transport, "node");
  assert.equal(result.deviceName, path);
  assert.equal(result.message, "Connected at 19200 baud");
});

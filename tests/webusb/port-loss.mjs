import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge } from "../../web/js/serial.js";
import { makeEmitter, makeRecordingPort } from "../support/fake-serial.mjs";
import { tick, withNavigator } from "../support/globals.mjs";

// An adapter that disappears mid-session (unplugged, or powered down with the
// radio) is reported by its transport through onDisconnect(), in one shape
// whatever the transport (web/js/serial-transport.mjs). The bridge has to close
// the port it holds and say so once. How each transport recognises its own
// loss -- by event target, by USBDevice identity, by GATT link -- is
// tests/webusb/serial-transport-conformance.mjs; this file is the bridge's
// half, plus the native wrapper end to end, since that is the path a desktop
// browser takes.

async function openNativeBridge(t) {
  const port = makeRecordingPort();
  const serial = makeEmitter({ requestPort: async () => port });
  withNavigator(t, { serial });
  const bridge = new BrowserSerialBridge();
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, port, serial, lost };
}

test("a native Web Serial disconnect for the open port closes it and reports it", async (t) => {
  const { bridge, port, serial, lost } = await openNativeBridge(t);
  assert.equal(serial.listenerCount("disconnect"), 1);

  // Web Serial fires the event at the SerialPort itself.
  serial.emit("disconnect", { target: port });
  await tick();

  assert.equal(lost.length, 1);
  assert.equal(lost[0].deviceName, "USB VID:PID 0x0403:0x6015");
  assert.equal(bridge.port, null);
  assert.equal(port.closed, true);
  assert.equal(bridge.getPortInfo().connected, false);
  // The watch is torn down with the port, not left behind on the transport.
  assert.equal(serial.listenerCount("disconnect"), 0);
});

test("another device disconnecting leaves the open port alone", async (t) => {
  const { bridge, serial, lost } = await openNativeBridge(t);

  serial.emit("disconnect", { target: makeRecordingPort() });
  await tick();

  assert.equal(lost.length, 0);
  assert.equal(bridge.getPortInfo().connected, true);
  await bridge.close();
  assert.equal(serial.listenerCount("disconnect"), 0);
});

test("a normal disconnect stops the watch without reporting a loss", async (t) => {
  const { bridge, serial, lost } = await openNativeBridge(t);
  await bridge.close();

  assert.equal(lost.length, 0);
  assert.equal(serial.listenerCount("disconnect"), 0);
  // A late event for the port that was just closed must stay silent.
  serial.emit("disconnect", { target: makeRecordingPort() });
  assert.equal(lost.length, 0);
});

// The same path for a port the bridge holds as itself (here through a
// stand-in WebUSB provider): the bridge acts on the contract's report and
// decodes no transport event of its own.
async function openContractBridge(t, port) {
  withNavigator(t, { usb: makeEmitter() });
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({ requestPort: async () => port }),
  });
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, lost };
}

test("a transport's loss report closes the port and is reported once", async (t) => {
  const port = makeRecordingPort({ device: { vendorId: 0x0403, productId: 0x6015 } });
  const { bridge, lost } = await openContractBridge(t, port);

  assert.equal(port.unplug(), true);
  await tick();

  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015" }]);
  assert.equal(bridge.port, null);
  assert.equal(port.closed, true);
  // The closed port cannot report again, and nothing would be listening.
  assert.equal(port.unplug(), false);
  assert.equal(lost.length, 1);
});

test("a port the bridge has let go of cannot tear down the next session", async (t) => {
  const first = makeRecordingPort();
  const second = makeRecordingPort();
  let next = first;
  withNavigator(t, { usb: makeEmitter() });
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({ requestPort: async () => next }),
  });
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  await bridge.close();
  next = second;
  await bridge.open(9600);

  // Re-armed by hand so the first port reports a loss again: the bridge's
  // subscription to it ended with its session and must not hear it.
  await first.open({ baudRate: 9600 });
  first.unplug();
  await tick();

  assert.equal(lost.length, 0);
  assert.equal(bridge.port, second);
  await bridge.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge } from "../../web/js/serial.ts";
import { SerialBridge } from "../../web/js/serial-bridge.ts";
import { makeEmitter, makeRecordingPort } from "../support/fake-serial.mjs";
import { tick, withNavigator } from "../support/globals.mjs";

// An adapter that disappears mid-session (unplugged, or powered down with the
// radio) is reported by its transport through onDisconnect(), in one shape
// whatever the transport (web/js/serial-transport.ts). The bridge has to close
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

// WEBCHIRP-FRONTEND-1X/-1Y: Upload stayed enabled for half an hour while every
// attempt failed with "Port is not connected.", because the bridge had let go
// of the port without onPortLost ever reaching the UI. These pin the rule
// behind the fix: whatever drops the port, the UI hears it, once.

// A vanished device's close() may take arbitrarily long or never settle. The
// bridge used to await it before reporting, so a stalled close left it holding
// a port with no writer -- the exact state that answers a clone with "Port is
// not connected." -- and the UI never told.
test("a lost port is reported even when its close never settles", async (t) => {
  const port = makeRecordingPort();
  port.close = () => new Promise(() => {});
  const { bridge, lost } = await openContractBridge(t, port);

  port.unplug();
  await tick();

  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015" }]);
  assert.equal(bridge.port, null);
  assert.equal(bridge.writer, null);
  assert.equal(bridge.getPortInfo().connected, false);
  await assert.rejects(() => bridge.prepareClone(true, true, 0, 9600), /Port is not connected/);
  assert.equal(lost.length, 1, "a loss already reported is not reported again");
});

// The backstop for a path nobody has found yet: a teardown that skipped the
// report stands in for it. The call that finds the port gone reports it, so
// the clone buttons go after one failed attempt instead of never.
test("a port dropped without a report is reported by the next call that needs it", async (t) => {
  const { bridge, lost } = await openContractBridge(t, makeRecordingPort());
  await bridge._teardown();
  assert.equal(lost.length, 0);

  await assert.rejects(() => bridge.prepareClone(true, true, 0, 9600), /Port is not connected/);

  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015", reason: "not-connected" }]);
  await assert.rejects(() => bridge.writeBytes([0x01]), /Port is not connected/);
  assert.equal(lost.length, 1);
});

// The half-held shape the report describes: the port still referenced, its
// writer gone. It is released as well as reported, so a reconnect starts
// clean instead of tripping over it.
test("a port held without its streams is let go of when a call finds it", async (t) => {
  const port = makeRecordingPort();
  const { bridge, lost } = await openContractBridge(t, port);
  await bridge._releaseStreams();
  assert.equal(bridge.port, port);

  await assert.rejects(() => bridge.prepareClone(true, true, 0, 9600), /Port is not connected/);
  await tick();

  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015", reason: "not-connected" }]);
  assert.equal(bridge.port, null);
  assert.equal(port.closed, true);
});

test("a call after an intentional close is refused without reporting a loss", async (t) => {
  const { bridge, lost } = await openContractBridge(t, makeRecordingPort());
  await bridge.close();

  await assert.rejects(() => bridge.prepareClone(true, true, 0, 9600), /Port is not connected/);
  await assert.rejects(() => bridge.readBytes(1, 0), /Port is not connected/);

  assert.equal(lost.length, 0);
});

// A read loop that dies on its own -- the device stopped feeding the stream,
// as after a sleep -- used to leave the port held and deaf: the next clone
// timed out as "radio did not respond" while the UI offered it as connected.
test("a read error on the held port ends the session and is reported", async (t) => {
  const port = makeRecordingPort();
  const { bridge, lost } = await openContractBridge(t, port);
  const debug = [];
  bridge.onDebug = (message) => debug.push(message);

  port.failRead(new Error("The device has been lost."));
  await tick();
  await tick();

  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015", reason: "read-stopped" }]);
  assert.equal(bridge.port, null);
  assert.equal(port.closed, true);
  assert.ok(debug.includes("Serial read loop ended: read error: The device has been lost."));
  // The transport's own report of the same loss, arriving after, is not a second one.
  port.unplug();
  await tick();
  assert.equal(lost.length, 1);
});

test("a stream that ends while the port is still held is a loss too", async (t) => {
  const port = makeRecordingPort();
  const { bridge, lost } = await openContractBridge(t, port);

  // The transport closing under the bridge, which never asked it to.
  await port.close();
  await tick();
  await tick();

  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015", reason: "read-stopped" }]);
  assert.equal(bridge.port, null);
});

// The bridge ends its own read loops on every reopen and teardown; none of
// those is the port stopping.
test("ending the read loop itself is never reported as a loss", async (t) => {
  const port = makeRecordingPort();
  const { bridge, lost } = await openContractBridge(t, port);

  await bridge.applyBaudRate(57600);
  await bridge.reconfigure({ parity: "even" });
  await bridge.close();
  await tick();

  assert.equal(lost.length, 0);
});

// TLC's counterexample to NoNullDeref on specs/SerialBridgeNode.cfg, replayed
// against the real bridge (FINDINGS.md:
// serial-bridge-in-place-reconfigure-outlives-the-port). On a transport that
// re-rates in place and whose reconfigure() can still resolve once its close()
// has started (node-serialport's may; WebBluetooth's cannot), the read loop
// stops while port.reconfigure() is pending:
// the bridge reports the loss and lets go of the port, then the reconfigure
// resolves and _reopenPort() returns as if it had worked. Marked todo until
// _reopenPort() checks it still holds its port after each await.
async function openInPlaceBridge() {
  const port = makeRecordingPort({
    capabilities: { framing: true, signals: true, reconfigure: "update" },
  });
  // Each reconfigure() parks until the test settles it, which is the window
  // the model found.
  const reconfigures = [];
  port.reconfigure = (options) => new Promise((resolve, reject) => {
    reconfigures.push({ options, resolve, reject });
  });
  const bridge = new SerialBridge({ requestTransport: async () => port });
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, port, lost, reconfigures };
}

// Steps 11-14 of the trace: the read fails, the loop gives up the port, the
// teardown closes it, and only then does the reconfigure resolve.
async function loseThePortMidReconfigure({ port, lost, bridge, reconfigures }) {
  await tick();
  assert.equal(reconfigures.length, 1, "parked at await port.reconfigure()");
  port.failRead(new Error("The device has been lost."));
  await tick();
  await tick();
  assert.deepEqual(lost, [{ deviceName: "USB VID:PID 0x0403:0x6015", reason: "read-stopped" }]);
  assert.equal(bridge.port, null);
  reconfigures[0].resolve();
}

test(
  "a port lost during an in-place re-rate fails prepareClone() as not connected",
  { todo: "serial-bridge-in-place-reconfigure-outlives-the-port" },
  async () => {
    const session = await openInPlaceBridge();
    const { bridge, lost } = session;

    const clone = bridge.prepareClone(true, true, 0, 19200);
    await loseThePortMidReconfigure(session);
    const error = await clone.then(() => null, (caught) => caught);

    assert.ok(error, "prepareClone() succeeded on a port the bridge had dropped");
    assert.notEqual(error.name, "TypeError", `prepareClone() dereferenced a null port: ${error.message}`);
    assert.equal(bridge.portOptions, null);
    assert.equal(lost.length, 1);
  },
);

test(
  "a port lost during an in-place re-rate is never answered as connected",
  { todo: "serial-bridge-in-place-reconfigure-outlives-the-port" },
  async () => {
    const session = await openInPlaceBridge();
    const { bridge, lost } = session;

    // open() at another rate on a held port takes the reuse path.
    const reopened = bridge.open(19200);
    await loseThePortMidReconfigure(session);
    const outcome = await reopened.then((result) => result, (caught) => caught);

    assert.equal(bridge.getPortInfo().connected, false);
    assert.notEqual(outcome.connected, true, `open() answered "${outcome.message}" holding no port`);
    // The UI heard of the loss once; the next call must not tell it again.
    await assert.rejects(() => bridge.prepareClone(true, true, 0, 9600), /Port is not connected/);
    assert.equal(lost.length, 1);
  },
);

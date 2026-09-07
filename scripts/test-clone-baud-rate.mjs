import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge, createSerialRpcHandler } from "../web/js/serial.js";
import { makeEmitter, makeRecordingPort } from "./test-support/fake-serial.mjs";
import { withNavigator } from "./test-support/globals.mjs";

// Every CHIRP driver declares its own BAUD_RATE, but a port's line rate is
// latched when it opens. Connecting with a 9600-baud radio selected and then
// cloning a 115200-baud one used to run the transfer at 9600 with no hint why
// (issue #76). The bridge now re-rates the port it already holds, per clone.

// Open a bridge on a recording port, counting how often the port picker was
// shown; portOptions are makeRecordingPort's.
async function openBridge(t, portOptions) {
  const port = makeRecordingPort(portOptions);
  let requestPortCalls = 0;
  withNavigator(t, {
    serial: makeEmitter({
      requestPort: async () => {
        requestPortCalls += 1;
        return port;
      },
    }),
  });
  const bridge = new BrowserSerialBridge();
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, port, lost, requestPortCalls: () => requestPortCalls };
}

test("preparing a clone re-rates the open port to the driver's baud rate", async (t) => {
  const { bridge, port, requestPortCalls } = await openBridge(t);
  assert.deepEqual(port.opens.map((call) => call.baudRate), [9600]);
  assert.equal(bridge.baudRate, 9600);

  const result = await bridge.prepareClone(true, false, 0, 115200);

  assert.equal(result.prepared, true);
  assert.equal(result.baudRateChanged, true);
  assert.equal(result.baudRate, 115200);
  assert.equal(bridge.baudRate, 115200);
  // Closed and reopened, and the port picker was never shown a second time:
  // the browser's grant survives a reopen of the same port handle.
  assert.equal(port.closes, 1);
  assert.deepEqual(port.opens.map((call) => call.baudRate), [9600, 115200]);
  assert.equal(requestPortCalls(), 1);
  // Control lines and the buffer flush apply to the reopened port, not the old one.
  assert.deepEqual(port.signals.at(-1), { dataTerminalReady: true, requestToSend: false });
  assert.equal(bridge.getPortInfo().baudRate, 115200);

  await bridge.close();
});

test("the reopened port is the one that carries the clone", async (t) => {
  const { bridge, port } = await openBridge(t);
  await bridge.prepareClone(true, true, 0, 115200);

  // Reads come from the new stream: a read loop left pinned to the closed
  // reader would hand back nothing here.
  port.push([0xaa, 0x55]);
  const read = await bridge.readHex(2, 500);
  assert.equal(read.hex, "AA 55");
  assert.equal(read.timedOut, false);

  await bridge.writeBytes([0x01, 0x02]);
  assert.deepEqual(port.written, [0x01, 0x02]);

  await bridge.close();
});

test("a clone at the rate the port already has does not disturb it", async (t) => {
  const { bridge, port } = await openBridge(t);

  const same = await bridge.prepareClone(true, true, 0, 9600);
  assert.equal(same.baudRateChanged, false);
  assert.equal(same.baudRate, 9600);

  // A driver that declares no BAUD_RATE reaches the bridge as 0 and must leave
  // the connected rate alone rather than reopening at some default.
  const unknown = await bridge.prepareClone(true, true, 0, 0);
  assert.equal(unknown.baudRateChanged, false);
  assert.equal(unknown.baudRate, 9600);

  assert.equal(port.closes, 0);
  assert.deepEqual(port.opens.map((call) => call.baudRate), [9600]);

  await bridge.close();
});

test("a port that will not reopen ends the session instead of faking one", async (t) => {
  const { bridge, port, lost } = await openBridge(t, {
    // The first open succeeds; every reopen is refused.
    failOpenWhen: (options, attempt) => (attempt === 0 ? null : "device busy"),
  });

  await assert.rejects(
    () => bridge.prepareClone(true, true, 0, 115200),
    /Could not reopen the serial port at 115200 baud/,
  );

  assert.equal(bridge.port, null);
  assert.equal(bridge.baudRate, 0);
  assert.equal(bridge.getPortInfo().connected, false);
  // Half-open is the state that must not survive: writes have to fail loudly.
  await assert.rejects(() => bridge.writeBytes([0x00]), /Port is not connected/);
  assert.equal(port.closes >= 1, true);
  // Reported on the same channel an unplug uses, so the UI drops the clone
  // buttons instead of leaving them lit against a port it no longer has.
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, "baud-rate-change");
  assert.equal(lost[0].deviceName, "USB VID:PID 0x0403:0x6015");
});

test("connecting again at a different rate re-rates instead of reporting success", async (t) => {
  const { bridge, port } = await openBridge(t);

  const result = await bridge.open(115200);
  assert.equal(result.connected, true);
  assert.equal(result.message, "Reopened at 115200 baud");
  assert.deepEqual(port.opens.map((call) => call.baudRate), [9600, 115200]);

  const again = await bridge.open(115200);
  assert.equal(again.message, "Already connected.");
  assert.deepEqual(port.opens.map((call) => call.baudRate), [9600, 115200]);

  await bridge.close();
});

test("the clone RPC forwards the driver's rate and logs which one was used", async (t) => {
  const { bridge, port } = await openBridge(t);
  const lines = [];
  const handleSerialRpc = createSerialRpcHandler({
    serialBridge: bridge,
    logSerial: (message) => lines.push(message),
  });

  const res = await handleSerialRpc({
    op: "prepareClone",
    payload: { wantsDtr: true, wantsRts: true, settleMs: 0, baudRate: 115200 },
  });

  assert.equal(res.baudRateChanged, true);
  assert.deepEqual(port.opens.map((call) => call.baudRate), [9600, 115200]);
  assert.equal(
    lines.at(-1),
    "Prepared clone session (DTR=true RTS=true baud=115200, reopened)",
  );

  await bridge.close();
});

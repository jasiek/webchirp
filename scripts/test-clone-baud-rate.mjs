import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge, createSerialRpcHandler } from "../web/js/serial.js";

// Every CHIRP driver declares its own BAUD_RATE, but a port's line rate is
// latched when it opens. Connecting with a 9600-baud radio selected and then
// cloning a 115200-baud one used to run the transfer at 9600 with no hint why
// (issue #76). The bridge now re-rates the port it already holds, per clone.

// A port whose readable/writable are rebuilt on each open(), so a test can tell
// a genuine close/reopen cycle from a no-op and can read through the new stream.
function makeStreams() {
  const chunks = [];
  const written = [];
  let wake = null;
  let ended = false;
  const settle = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  return {
    written,
    push(bytes) {
      chunks.push(Uint8Array.from(bytes));
      settle();
    },
    end() {
      ended = true;
      settle();
    },
    readable: {
      getReader: () => ({
        async read() {
          for (;;) {
            if (chunks.length > 0) {
              return { value: chunks.shift(), done: false };
            }
            if (ended) {
              return { value: undefined, done: true };
            }
            await new Promise((resolve) => {
              wake = resolve;
            });
          }
        },
        async cancel() {
          ended = true;
          settle();
        },
        releaseLock() {},
      }),
    },
    writable: {
      getWriter: () => ({
        async write(bytes) {
          written.push(...bytes);
        },
        releaseLock() {},
      }),
    },
  };
}

function makeFakePort({ failFromOpenNumber = 0 } = {}) {
  const port = {
    openCalls: [],
    closeCount: 0,
    signals: null,
    streams: null,
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6015 }),
    async open(options) {
      port.openCalls.push({ ...options });
      if (failFromOpenNumber > 0 && port.openCalls.length >= failFromOpenNumber) {
        throw new Error("device busy");
      }
      port.streams = makeStreams();
      port.readable = port.streams.readable;
      port.writable = port.streams.writable;
    },
    async close() {
      port.closeCount += 1;
      port.streams?.end();
    },
    async setSignals(signals) {
      port.signals = signals;
    },
  };
  return port;
}

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

async function openBridge(portOptions) {
  const port = makeFakePort(portOptions);
  let requestPortCalls = 0;
  setNavigator({
    serial: {
      addEventListener() {},
      removeEventListener() {},
      requestPort: async () => {
        requestPortCalls += 1;
        return port;
      },
    },
  });
  const bridge = new BrowserSerialBridge();
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, port, lost, requestPortCalls: () => requestPortCalls };
}

test("preparing a clone re-rates the open port to the driver's baud rate", async () => {
  const { bridge, port, requestPortCalls } = await openBridge();
  assert.deepEqual(port.openCalls.map((call) => call.baudRate), [9600]);
  assert.equal(bridge.baudRate, 9600);

  const result = await bridge.prepareClone(true, false, 0, 115200);

  assert.equal(result.prepared, true);
  assert.equal(result.baudRateChanged, true);
  assert.equal(result.baudRate, 115200);
  assert.equal(bridge.baudRate, 115200);
  // Closed and reopened, and the port picker was never shown a second time:
  // the browser's grant survives a reopen of the same port handle.
  assert.equal(port.closeCount, 1);
  assert.deepEqual(port.openCalls.map((call) => call.baudRate), [9600, 115200]);
  assert.equal(requestPortCalls(), 1);
  // Control lines and the buffer flush apply to the reopened port, not the old one.
  assert.deepEqual(port.signals, { dataTerminalReady: true, requestToSend: false });
  assert.equal(bridge.getPortInfo().baudRate, 115200);

  await bridge.close();
});

test("the reopened port is the one that carries the clone", async () => {
  const { bridge, port } = await openBridge();
  await bridge.prepareClone(true, true, 0, 115200);

  // Reads come from the new stream: a read loop left pinned to the closed
  // reader would hand back nothing here.
  port.streams.push([0xaa, 0x55]);
  const read = await bridge.readHex(2, 500);
  assert.equal(read.hex, "AA 55");
  assert.equal(read.timedOut, false);

  await bridge.writeBytes([0x01, 0x02]);
  assert.deepEqual(port.streams.written, [0x01, 0x02]);

  await bridge.close();
});

test("a clone at the rate the port already has does not disturb it", async () => {
  const { bridge, port } = await openBridge();

  const same = await bridge.prepareClone(true, true, 0, 9600);
  assert.equal(same.baudRateChanged, false);
  assert.equal(same.baudRate, 9600);

  // A driver that declares no BAUD_RATE reaches the bridge as 0 and must leave
  // the connected rate alone rather than reopening at some default.
  const unknown = await bridge.prepareClone(true, true, 0, 0);
  assert.equal(unknown.baudRateChanged, false);
  assert.equal(unknown.baudRate, 9600);

  assert.equal(port.closeCount, 0);
  assert.deepEqual(port.openCalls.map((call) => call.baudRate), [9600]);

  await bridge.close();
});

test("a port that will not reopen ends the session instead of faking one", async () => {
  const { bridge, port, lost } = await openBridge({ failFromOpenNumber: 2 });

  await assert.rejects(
    () => bridge.prepareClone(true, true, 0, 115200),
    /Could not reopen the serial port at 115200 baud/,
  );

  assert.equal(bridge.port, null);
  assert.equal(bridge.baudRate, 0);
  assert.equal(bridge.getPortInfo().connected, false);
  // Half-open is the state that must not survive: writes have to fail loudly.
  await assert.rejects(() => bridge.writeBytes([0x00]), /Port is not connected/);
  assert.equal(port.closeCount >= 1, true);
  // Reported on the same channel an unplug uses, so the UI drops the clone
  // buttons instead of leaving them lit against a port it no longer has.
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, "baud-rate-change");
  assert.equal(lost[0].deviceName, "USB VID:PID 0x0403:0x6015");
});

test("connecting again at a different rate re-rates instead of reporting success", async () => {
  const { bridge, port } = await openBridge();

  const result = await bridge.open(115200);
  assert.equal(result.connected, true);
  assert.equal(result.message, "Reopened at 115200 baud");
  assert.deepEqual(port.openCalls.map((call) => call.baudRate), [9600, 115200]);

  const again = await bridge.open(115200);
  assert.equal(again.message, "Already connected.");
  assert.deepEqual(port.openCalls.map((call) => call.baudRate), [9600, 115200]);

  await bridge.close();
});

test("the clone RPC forwards the driver's rate and logs which one was used", async () => {
  const { bridge, port } = await openBridge();
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
  assert.deepEqual(port.openCalls.map((call) => call.baudRate), [9600, 115200]);
  assert.equal(
    lines.at(-1),
    "Prepared clone session (DTR=true RTS=true baud=115200, reopened)",
  );

  await bridge.close();
});

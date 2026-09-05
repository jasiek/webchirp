import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge, createSerialRpcHandler } from "../web/js/serial.js";

// A port that records every setSignals() call, standing in for Web Serial or
// one of the WebUSB adapter shims.
function fakePort({ failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async setSignals(signals) {
      if (failWith) {
        throw new Error(failWith);
      }
      calls.push(signals);
    },
  };
}

test("setSignals asserts only the lines the caller named", async () => {
  const bridge = new BrowserSerialBridge();
  const port = fakePort();
  bridge.port = port;

  await bridge.setSignals(true, false);
  // thd72 raises RTS alone mid-clone; DTR must be left where it was.
  await bridge.setSignals(null, true);
  const res = await bridge.setSignals(null, null);

  assert.deepEqual(port.calls, [
    { dataTerminalReady: true, requestToSend: false },
    { requestToSend: true },
  ]);
  assert.equal(res.applied, false);
});

test("setSignals refuses to run without an open port", async () => {
  const bridge = new BrowserSerialBridge();
  await assert.rejects(() => bridge.setSignals(true, true), /not connected/);
});

test("setSignals op forwards both lines through the RPC handler", async () => {
  const calls = [];
  const logs = [];
  const handler = createSerialRpcHandler({
    serialBridge: {
      async setSignals(dtr, rts) {
        calls.push([dtr, rts]);
        return { applied: true };
      },
    },
    logSerial: (msg) => logs.push(msg),
  });

  await handler({
    op: "setSignals",
    payload: { dataTerminalReady: null, requestToSend: true },
  });

  assert.deepEqual(calls, [[null, true]]);
  assert.deepEqual(logs, ["Set control lines (RTS=true)"]);
});

// Control lines are advisory: several USB adapters cannot change them, and a
// clone that would otherwise succeed must not be aborted by that.
test("a port that cannot change control lines does not fail the clone", async () => {
  const logs = [];
  const bridge = new BrowserSerialBridge();
  bridge.port = fakePort({ failWith: "setSignals is not supported" });
  const handler = createSerialRpcHandler({
    serialBridge: bridge,
    logSerial: (msg) => logs.push(msg),
  });

  const res = await handler({
    op: "setSignals",
    payload: { dataTerminalReady: true, requestToSend: true },
  });

  assert.equal(res.applied, false);
  assert.match(logs[0], /Control lines unchanged \(DTR=true RTS=true\)/);
  assert.match(logs[0], /setSignals is not supported/);
});

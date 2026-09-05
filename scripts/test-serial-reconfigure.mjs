import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge, createSerialRpcHandler } from "../web/js/serial.js";

// CHIRP drivers change the port's baud rate part-way through a clone: thd72
// jumps to 57600 after the PROGRAM handshake, icf.start_hispeed_clone to 38400,
// tk8180/nx800 to 19200, and several drivers probe four to six rates before the
// radio answers. Web Serial has no live rate change, so the bridge closes the
// port and opens it again -- on the same port object, so the permission the
// user granted survives and no second device picker appears.

function makeEmitter(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}

// A port that records how it was opened and closed, parks its read loop until
// cancelled (as a real one does), and can be told to refuse the next open.
function makeFakePort({ failOpenWhen = () => null } = {}) {
  let releaseRead = () => {};
  return {
    opens: [],
    closes: 0,
    signals: [],
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6015 }),
    async open(options) {
      const failure = failOpenWhen(options, this.opens.length);
      this.opens.push({ ...options });
      if (failure) {
        throw new Error(failure);
      }
    },
    async close() {
      this.closes += 1;
    },
    async setSignals(signals) {
      this.signals.push({ ...signals });
    },
    readable: {
      getReader: () => ({
        read: () => new Promise((resolve) => {
          releaseRead = () => resolve({ done: true });
        }),
        async cancel() {
          releaseRead();
        },
        releaseLock() {},
      }),
    },
    writable: {
      getWriter: () => ({ write: async () => {}, releaseLock() {} }),
    },
  };
}

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

async function openBridge(portOptions = {}) {
  const port = makeFakePort(portOptions);
  setNavigator({ serial: makeEmitter({ requestPort: async () => port }) });
  const bridge = new BrowserSerialBridge();
  const debug = [];
  bridge.onDebug = (msg) => debug.push(msg);
  await bridge.open(9600);
  return { bridge, port, debug };
}

test("a rate change reopens the same port with the merged options", async () => {
  const { bridge, port } = await openBridge();

  const res = await bridge.reconfigure({ baudRate: 57600 });

  assert.equal(res.reconfigured, true);
  assert.deepEqual(res.changed, ["baudRate"]);
  assert.equal(port.closes, 1);
  assert.equal(port.opens.length, 2);
  // Options the caller did not name keep the value the port was opened with,
  // rather than silently reverting to Web Serial's defaults.
  assert.deepEqual(port.opens[1], {
    baudRate: 57600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
  });
});

test("framing options ride the same reopen as the rate", async () => {
  const { bridge, port } = await openBridge();

  const res = await bridge.reconfigure({ stopBits: 2, parity: "even" });

  assert.deepEqual(res.changed.sort(), ["parity", "stopBits"]);
  assert.equal(port.opens[1].stopBits, 2);
  assert.equal(port.opens[1].parity, "even");
  assert.equal(port.opens[1].baudRate, 9600);
});

// Drivers assign the rate they are already running at -- tk8180's reset path
// writes 9600 when 9600 is current, and a probe loop re-asserts its winner.
// Reopening for that would restart the adapter mid-clone for nothing.
test("assigning the current settings does not reopen the port", async () => {
  const { bridge, port } = await openBridge();

  const res = await bridge.reconfigure({ baudRate: 9600, parity: "none" });

  assert.equal(res.reconfigured, false);
  assert.deepEqual(res.changed, []);
  assert.equal(port.closes, 0);
  assert.equal(port.opens.length, 1);
});

// pyserial changes the rate with TCSANOW, which does not flush the input queue,
// so bytes received before the switch stay readable. Drivers are written
// against that: thd72 reads a byte immediately after going to 57600.
test("bytes buffered before the switch survive the reopen", async () => {
  const { bridge, debug } = await openBridge();
  bridge.readBuffer = Uint8Array.from([0x06, 0x16]);

  await bridge.reconfigure({ baudRate: 57600 });

  assert.deepEqual(Array.from(bridge.readBuffer), [0x06, 0x16]);
  assert.ok(
    debug.some((line) => /Kept 2 buffered byte\(s\)/.test(line)),
    `expected the retained bytes to be reported, got ${JSON.stringify(debug)}`,
  );
});

// Closing a port drops DTR/RTS back to the adapter's defaults. thd72 sets the
// rate and then raises RTS two lines later, so a reopen that forgot the lines
// would undo whichever of the two came first.
test("control lines set before the change are re-asserted after it", async () => {
  const { bridge, port } = await openBridge();
  await bridge.prepareClone(true, false, 0);
  await bridge.setSignals(null, true);
  port.signals.length = 0;

  await bridge.reconfigure({ baudRate: 57600 });

  assert.deepEqual(port.signals, [{ dataTerminalReady: true, requestToSend: true }]);
});

test("a port with no known line state is not given one by a reopen", async () => {
  const { bridge, port } = await openBridge();

  await bridge.reconfigure({ baudRate: 57600 });

  assert.deepEqual(port.signals, []);
});

// The port is already closed when the new options are refused, so leaving it
// that way would strand the session on a port the app still thinks is open.
test("a refused reopen restores the previous settings and reports the failure", async () => {
  const { bridge, port } = await openBridge({
    failOpenWhen: (options) => (options.baudRate === 57600 ? "unsupported baud rate" : null),
  });

  await assert.rejects(
    () => bridge.reconfigure({ baudRate: 57600 }),
    /Could not reconfigure the port \(baudRate\): unsupported baud rate/,
  );

  assert.equal(bridge.port, port, "the port must still be held");
  assert.deepEqual(bridge.portOptions.baudRate, 9600);
  assert.equal(port.opens.at(-1).baudRate, 9600, "the port must be reopened as it was");
  assert.equal(bridge.getPortInfo().connected, true);
});

test("a reopen that cannot be undone leaves no zombie port behind", async () => {
  const { bridge } = await openBridge({
    failOpenWhen: (options, attempt) => (attempt === 0 ? null : "device is gone"),
  });

  await assert.rejects(() => bridge.reconfigure({ baudRate: 57600 }), /Could not reconfigure/);

  assert.equal(bridge.port, null);
  assert.equal(bridge.getPortInfo().connected, false);
});

test("reconfigure refuses to run without an open port", async () => {
  const bridge = new BrowserSerialBridge();
  await assert.rejects(() => bridge.reconfigure({ baudRate: 9600 }), /not connected/);
});

test("the reconfigure op names the changed options in the debug panel", async () => {
  const logs = [];
  const handler = createSerialRpcHandler({
    serialBridge: {
      async reconfigure(options) {
        return { reconfigured: true, options, changed: ["baudRate"] };
      },
    },
    logSerial: (msg) => logs.push(msg),
  });

  await handler({ op: "reconfigure", payload: { options: { baudRate: 57600 } } });

  assert.deepEqual(logs, ["Reopened port (baudRate=57600)"]);
});

// Unlike DTR/RTS, this one is not advisory: the radio has already switched, so
// a port left at the old rate cannot finish the clone. Swallowing the error
// would turn it into an unexplained read timeout much later.
test("a failed reconfigure propagates instead of being logged and swallowed", async () => {
  const handler = createSerialRpcHandler({
    serialBridge: {
      async reconfigure() {
        throw new Error("port is gone");
      },
    },
    logSerial: () => {},
  });

  await assert.rejects(
    () => handler({ op: "reconfigure", payload: { options: { baudRate: 57600 } } }),
    /port is gone/,
  );
});

// Framing is per-driver and sticky: tk280 asks for even parity, tg_uv2p for two
// stop bits, and both land on the port mid-session. The next clone must start
// from the defaults rather than inherit them, or a radio that never asked for
// even parity reads every byte through it.
test("a clone does not inherit the framing the previous clone's driver set", async () => {
  const { bridge, port } = await openBridge();
  await bridge.reconfigure({ parity: "even", stopBits: 2 });
  assert.equal(port.opens.at(-1).parity, "even");

  // Same rate as the port already has: the reset must still happen.
  const res = await bridge.applyBaudRate(9600);

  assert.equal(res.changed, true);
  assert.deepEqual(port.opens.at(-1), {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
  });
});

test("a clone at the settings the port already has still does not reopen", async () => {
  const { bridge, port } = await openBridge();
  const opens = port.opens.length;

  const res = await bridge.applyBaudRate(9600);

  assert.equal(res.changed, false);
  assert.equal(port.opens.length, opens);
});

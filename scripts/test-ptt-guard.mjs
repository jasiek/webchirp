import assert from "node:assert/strict";
import test from "node:test";
import { createPttGuard } from "../web/js/ptt-guard.js";
import { BrowserSerialBridge } from "../web/js/serial.js";

// Web Serial-shaped fakes: ports that track open/close, and a provider that
// can emit connect/disconnect events like navigator.serial.
class FakeGuardPort {
  constructor(name, { failOpen = false } = {}) {
    this.name = name;
    this.failOpen = failOpen;
    this.opened = false;
    this.openCalls = 0;
    this.lastOptions = null;
  }

  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }

  async open(options) {
    if (this.failOpen) {
      throw new Error(`${this.name} refuses to open`);
    }
    if (this.opened) {
      throw new Error(`${this.name} is already open`);
    }
    this.opened = true;
    this.openCalls += 1;
    this.lastOptions = options;
  }

  async close() {
    this.opened = false;
  }
}

class FakeSerialProvider {
  constructor(ports = []) {
    this.ports = ports;
    this.listeners = new Map();
  }

  async getPorts() {
    return [...this.ports];
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  emit(type, port) {
    this.listeners.get(type)?.({ port, target: port });
  }
}

test("start() opens every already-granted port with an 8N1 configuration", async () => {
  const ports = [new FakeGuardPort("a"), new FakeGuardPort("b")];
  const provider = new FakeSerialProvider(ports);
  const guard = createPttGuard({ serial: provider, onLog: () => {} });

  guard.start();
  await guard.flush();

  for (const port of ports) {
    assert.equal(port.opened, true, `${port.name} should be parked`);
    assert.deepEqual(port.lastOptions, {
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
  }
  assert.equal(guard.parkedCount(), 2);
});

test("a granted cable plugged in later is parked via the connect event", async () => {
  const provider = new FakeSerialProvider([]);
  const guard = createPttGuard({ serial: provider, onLog: () => {} });
  guard.start();

  const port = new FakeGuardPort("late");
  provider.emit("connect", port);
  await guard.flush();

  assert.equal(port.opened, true);
  assert.equal(guard.parkedCount(), 1);

  provider.emit("disconnect", port);
  assert.equal(guard.parkedCount(), 0);
});

test("suspend() releases parked ports and blocks parking until resume()", async () => {
  const port = new FakeGuardPort("a");
  const provider = new FakeSerialProvider([port]);
  const guard = createPttGuard({ serial: provider, onLog: () => {} });
  guard.start();

  await guard.suspend();
  assert.equal(port.opened, false, "suspend must close parked ports");
  assert.equal(guard.parkedCount(), 0);

  // While suspended, a fresh plug-in must stay untouched — the app may be
  // about to open it itself.
  const during = new FakeGuardPort("during");
  provider.ports.push(during);
  provider.emit("connect", during);
  await Promise.resolve();
  assert.equal(during.opened, false);

  await guard.resume();
  assert.equal(port.opened, true, "resume must re-park granted ports");
  assert.equal(during.opened, true);
  assert.equal(guard.parkedCount(), 2);
});

test("a port that fails to open is skipped, logged, and does not stop the rest", async () => {
  const bad = new FakeGuardPort("bad", { failOpen: true });
  const good = new FakeGuardPort("good");
  const provider = new FakeSerialProvider([bad, good]);
  const logs = [];
  const guard = createPttGuard({ serial: provider, onLog: (m) => logs.push(m) });

  guard.start();
  await guard.flush();

  assert.equal(good.opened, true);
  assert.equal(guard.parkedCount(), 1);
  assert.ok(
    logs.some((m) => m.includes("could not open")),
    "the failed open should be logged",
  );
});

test("guard without a provider (no native Web Serial) is inert", async () => {
  const guard = createPttGuard({ serial: undefined, onLog: () => {} });
  guard.start();
  await guard.suspend();
  await guard.resume();
  await guard.flush();
  assert.equal(guard.parkedCount(), 0);
});

// The bridge's webusb transport probes `navigator.usb` for capability before
// using the injected provider; Node's built-in navigator global has no usb.
if (!globalThis.navigator?.usb) {
  Object.defineProperty(globalThis, "navigator", {
    value: { usb: {} },
    configurable: true,
  });
}

// A minimal Web Serial-shaped port for BrowserSerialBridge: enough for open()
// and close() to run their full paths (read loop included).
function makeBridgePort() {
  return {
    async open() {},
    async close() {},
    getInfo() {
      return {};
    },
    readable: {
      getReader() {
        return {
          read: () => new Promise(() => {}),
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
    writable: {
      getWriter() {
        return { releaseLock() {} };
      },
    },
  };
}

test("bridge calls onBeforeOpen before the port picker and onAfterTeardown on close", async () => {
  const order = [];
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({
      async requestPort() {
        order.push("requestPort");
        return makeBridgePort();
      },
    }),
  });
  bridge.setPreferredTransport("webusb");
  bridge.onBeforeOpen = async () => {
    order.push("beforeOpen");
  };
  bridge.onAfterTeardown = () => {
    order.push("afterTeardown");
  };

  await bridge.open(9600);
  await bridge.close();

  assert.deepEqual(order, ["beforeOpen", "requestPort", "afterTeardown"]);
});

test("a throwing onBeforeOpen hook does not block connecting", async () => {
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({
      async requestPort() {
        return makeBridgePort();
      },
    }),
  });
  bridge.setPreferredTransport("webusb");
  bridge.onBeforeOpen = async () => {
    throw new Error("guard exploded");
  };

  const result = await bridge.open(9600);
  assert.equal(result.connected, true);
  await bridge.close();
});

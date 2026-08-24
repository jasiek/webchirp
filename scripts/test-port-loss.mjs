import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge } from "../web/js/serial.js";

// An adapter that disappears mid-session (unplugged, or powered down with the
// radio) is reported by the browser as a "disconnect" event on the transport
// API, not on the port. The bridge has to recognize the ones that concern the
// port it holds open, close it, and say so — while ignoring every other device
// on the machine going away.

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
    emit(type, event) {
      for (const fn of Array.from(listeners.get(type) || [])) {
        fn(event);
      }
    },
  };
}

// A port whose read loop parks until the bridge cancels it, so the loop behaves
// like a real one instead of spinning through the test.
function makeFakePort({ usbVendorId = 0x0403, usbProductId = 0x6015, device } = {}) {
  let releaseRead = () => {};
  const port = {
    device,
    opened: false,
    closed: false,
    getInfo: () => ({ usbVendorId, usbProductId }),
    async open() {
      this.opened = true;
    },
    async close() {
      this.closed = true;
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
  if (!device) {
    delete port.device;
  }
  return port;
}

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

async function openNativeBridge() {
  const port = makeFakePort();
  const serial = makeEmitter({ requestPort: async () => port });
  setNavigator({ serial });
  const bridge = new BrowserSerialBridge();
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, port, serial, lost };
}

test("a native Web Serial disconnect for the open port closes it and reports it", async () => {
  const { bridge, port, serial, lost } = await openNativeBridge();
  assert.equal(serial.listenerCount("disconnect"), 1);

  // Web Serial fires the event at the SerialPort itself.
  serial.emit("disconnect", { target: port });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lost.length, 1);
  assert.equal(lost[0].deviceName, "USB VID:PID 0x0403:0x6015");
  assert.equal(bridge.port, null);
  assert.equal(port.closed, true);
  assert.equal(bridge.getPortInfo().connected, false);
  // The watch is torn down with the port, not left behind on the transport.
  assert.equal(serial.listenerCount("disconnect"), 0);
});

test("another device disconnecting leaves the open port alone", async () => {
  const { bridge, serial, lost } = await openNativeBridge();

  serial.emit("disconnect", { target: makeFakePort() });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lost.length, 0);
  assert.equal(bridge.getPortInfo().connected, true);
  await bridge.close();
  assert.equal(serial.listenerCount("disconnect"), 0);
});

test("a normal disconnect stops the watch without reporting a loss", async () => {
  const { bridge, serial, lost } = await openNativeBridge();
  await bridge.close();

  assert.equal(lost.length, 0);
  assert.equal(serial.listenerCount("disconnect"), 0);
  // A late event for the port that was just closed must stay silent.
  serial.emit("disconnect", { target: makeFakePort() });
  assert.equal(lost.length, 0);
});

async function openWebUsbBridge(port) {
  const usb = makeEmitter();
  setNavigator({ usb });
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({ requestPort: async () => port }),
  });
  const lost = [];
  bridge.onPortLost = (info) => lost.push(info);
  await bridge.open(9600);
  return { bridge, usb, lost };
}

test("a WebUSB disconnect is matched by the USBDevice behind the port", async () => {
  const device = { vendorId: 0x0403, productId: 0x6015 };
  const port = makeFakePort({ device });
  const { bridge, usb, lost } = await openWebUsbBridge(port);

  // WebUSB fires at navigator.usb and names the device.
  usb.emit("disconnect", { target: usb, device: { vendorId: 0x0403, productId: 0x6015 } });
  await new Promise((resolve) => setImmediate(resolve));
  // A different USBDevice object, even with identical ids, is a different
  // adapter — the port stays open.
  assert.equal(lost.length, 0);
  assert.equal(bridge.getPortInfo().connected, true);

  usb.emit("disconnect", { target: usb, device });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lost.length, 1);
  assert.equal(bridge.port, null);
});

test("a port that hides its USBDevice falls back to the reported USB ids", async () => {
  // The polyfilled CDC port keeps its device private; the ids it reports are
  // the only handle the bridge has on which adapter went away.
  const port = makeFakePort({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
  const { bridge, usb, lost } = await openWebUsbBridge(port);

  usb.emit("disconnect", { target: usb, device: { vendorId: 0x067b, productId: 0x2303 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lost.length, 0);

  usb.emit("disconnect", { target: usb, device: { vendorId: 0x1a86, productId: 0x7523 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lost.length, 1);
  assert.equal(bridge.getPortInfo().connected, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge } from "../../web/js/serial.js";
import { isPortSelectionCancelled } from "../../web/js/serial-errors.js";
import { WebBluetoothSerialPort, createWebBluetoothSerial } from "../../web/js/webbluetooth-serial.js";
import { makeBluetoothDongle } from "../support/fake-bluetooth.mjs";
import { withNavigator, tick } from "../support/globals.mjs";

// Open the actual provider without its hardware settling delay in unit tests.
async function openPort(t, dongle = makeBluetoothDongle()) {
  const port = new WebBluetoothSerialPort(dongle.device, { settleMs: 0 });
  t.after(() => port.close());
  await port.open({ baudRate: 9600 });
  return { port, ...dongle };
}

// Exercise the existing buffering/reconfigure bridge with the real BLE port.
async function openBridge(t, dongle = makeBluetoothDongle()) {
  withNavigator(t, { bluetooth: { requestDevice() {} } });
  const port = new WebBluetoothSerialPort(dongle.device, { settleMs: 0 });
  const bridge = new BrowserSerialBridge({
    createWebBluetoothSerial: () => ({ requestPort: async () => port }),
  });
  bridge.setPreferredTransport("webbluetooth");
  t.after(() => bridge.close());
  await bridge.open(9600);
  return { bridge, port, ...dongle };
}

test("Bluetooth chooser filters BF98 advertising and grants the distinct FF00 UART service", async (t) => {
  const dongle = makeBluetoothDongle();
  let requested;
  withNavigator(t, { bluetooth: { async requestDevice(options) { requested = options; return dongle.device; } } });
  const port = await createWebBluetoothSerial().requestPort();
  assert.equal(port.device, dongle.device);
  assert.deepEqual(requested, {
    filters: [{ services: ["0000bf98-0000-1000-8000-00805f9b34fb"] }],
    optionalServices: ["0000ff00-0000-1000-8000-00805f9b34fb"],
  });
});

test("open subscribes to FF01 and sends baud as LE32 to AE10 with a write response", async (t) => {
  const { calls, port } = await openPort(t);
  assert.deepEqual(calls, [
    { operation: "connect" },
    { operation: "service:0000ff00-0000-1000-8000-00805f9b34fb" },
    { operation: "characteristic:ff02" },
    { operation: "characteristic:ff01" },
    { operation: "characteristic:ae10" },
    { operation: "ff01:subscribe" },
    { operation: "ae10:response", bytes: [0x80, 0x25, 0, 0] },
  ]);
  await port.reconfigure({ baudRate: 115200 });
  assert.deepEqual(calls.at(-1), { operation: "ae10:response", bytes: [0, 0xc2, 1, 0] });
  const count = calls.length;
  await port.reconfigure({ baudRate: 115200 });
  assert.equal(calls.length, count, "unchanged rate must not reset the UART");
});

test("raw UART writes keep byte windows, twenty-byte chunks and GATT operation order", async (t) => {
  let active = false;
  const dongle = makeBluetoothDongle({ async onOperation(call) {
    if (!call.operation.endsWith(":command") && !call.operation.endsWith(":response")) return;
    assert.equal(active, false, "GATT writes must never overlap");
    active = true;
    await tick();
    active = false;
  } });
  const { port, calls } = await openPort(t, dongle);
  const writer = port.writable.getWriter();
  const source = Uint8Array.from({ length: 47 }, (_, i) => i);
  const write = writer.write(source.subarray(1, 46));
  await tick();
  await Promise.all([write, port.reconfigure({ baudRate: 19200 })]);
  await writer.write(Uint8Array.of(0x06));
  writer.releaseLock();
  assert.deepEqual(calls.filter((call) => call.operation === "ff02:command").map((call) => call.bytes), [
    Array.from(source.slice(1, 21)), Array.from(source.slice(21, 41)), Array.from(source.slice(41, 46)), [6],
  ]);
  assert.deepEqual(calls.slice(-5).map((call) => call.operation), [
    "ff02:command", "ff02:command", "ff02:command", "ae10:response", "ff02:command",
  ]);
});

test("FF01 preserves offset DataViews, buffer ownership and coalesced ACK bytes", async (t) => {
  const { bridge, notify } = await openBridge(t);
  const buffer = Uint8Array.of(0xee, 0x06, 0x41, 0x42, 0x06, 0xff);
  notify(new DataView(buffer.buffer, 1, 4));
  buffer.fill(0);
  notify(new DataView(Uint8Array.of(0x43, 0x44).buffer));
  assert.deepEqual(await bridge.readBytes(1, 100), [6]);
  assert.deepEqual(await bridge.readBytes(5, 100), [0x41, 0x42, 6, 0x43, 0x44]);
});

test("mid-clone baud changes keep the GATT link, streams and buffered input", async (t) => {
  let dongle;
  dongle = makeBluetoothDongle({ async onOperation(call) {
    if (call.operation === "ae10:response" && call.bytes[0] === 0x00) {
      dongle.notify(new DataView(Uint8Array.of(0x22).buffer));
    }
  } });
  const { bridge, port, calls, notify } = await openBridge(t, dongle);
  const reader = bridge.reader;
  const writer = bridge.writer;
  notify(new DataView(Uint8Array.of(0x11).buffer));
  await tick();
  await bridge.reconfigure({ baudRate: 115200 });
  assert.equal(bridge.port, port);
  assert.equal(bridge.reader, reader);
  assert.equal(bridge.writer, writer);
  assert.equal(bridge.baudRate, 115200);
  assert.deepEqual(await bridge.readBytes(2, 100), [0x11, 0x22]);
  assert.equal(calls.filter((call) => call.operation === "connect").length, 1);
  assert.equal(calls.filter((call) => call.operation === "disconnect").length, 0);
});

test("intentional close removes notification listeners without reporting port loss", async (t) => {
  const { port, device, rx } = await openPort(t);
  let losses = 0;
  port.addEventListener("disconnect", () => { losses += 1; });
  const reader = port.readable.getReader();
  const pendingRead = reader.read();
  await port.close();
  assert.deepEqual(await pendingRead, { done: true, value: undefined });
  reader.releaseLock();
  assert.equal(device.gatt.connected, false);
  assert.equal(losses, 0);
  assert.equal(device.listenerCount("gattserverdisconnected"), 0);
  assert.equal(rx.listenerCount("characteristicvaluechanged"), 0);
  assert.equal(port.readable, null);
  assert.equal(port.writable, null);
});

test("unexpected BLE link loss tears down the bridge and reports the device", async (t) => {
  const { bridge, device, rx } = await openBridge(t);
  const lost = new Promise((resolve) => { bridge.onPortLost = resolve; });
  device.gatt.disconnect();
  const event = await lost;
  assert.match(event.deviceName, /BF_Writer/);
  assert.equal(bridge.port, null);
  assert.equal(bridge.writer, null);
  assert.equal(rx.listenerCount("characteristicvaluechanged"), 0);
});

test("failed partial opens clean up both GATT and event listeners before retry", async () => {
  for (const stage of ["characteristic:ae10", "ff01:subscribe", "ae10:response"]) {
    let fail = true;
    const dongle = makeBluetoothDongle({ async onOperation(call) {
      if (fail && call.operation === stage) throw new Error(`failed ${stage}`);
    } });
    const port = new WebBluetoothSerialPort(dongle.device, { settleMs: 0 });
    await assert.rejects(port.open({ baudRate: 9600 }), /failed/);
    assert.equal(dongle.device.gatt.connected, false);
    assert.equal(dongle.device.listenerCount("gattserverdisconnected"), 0);
    assert.equal(dongle.rx.listenerCount("characteristicvaluechanged"), 0);
    assert.equal(port.readable, null);
    assert.equal(port.writable, null);
    fail = false;
    await port.open({ baudRate: 9600 });
    assert.equal(dongle.device.gatt.connected, true);
    await port.close();
  }
});

test("unsupported serial framing and invalid rates are rejected before touching hardware", async () => {
  const dongle = makeBluetoothDongle();
  const port = new WebBluetoothSerialPort(dongle.device, { settleMs: 0 });
  for (const options of [{ baudRate: 0 }, { baudRate: 1.5 }, { baudRate: 2 ** 32 },
    { baudRate: 9600, parity: "even" }, { baudRate: 9600, stopBits: 2 },
    { baudRate: 9600, dataBits: 7 }, { baudRate: 9600, flowControl: "hardware" }]) {
    await assert.rejects(port.open(options), /baud rate|8N1/);
  }
  assert.deepEqual(dongle.calls, []);
});

test("BLE-only browsers advertise capability and chooser dismissal is a cancellation", async (t) => {
  withNavigator(t, { bluetooth: { async requestDevice() { throw new DOMException("User cancelled", "NotFoundError"); } } });
  const bridge = new BrowserSerialBridge();
  assert.deepEqual(bridge.getCapability(), { supported: true, native: false, webusb: false, webbluetooth: true });
  bridge.setPreferredTransport("webbluetooth");
  await assert.rejects(bridge.open(9600), isPortSelectionCancelled);
  assert.equal(bridge.port, null);
  assert.equal(bridge.writer, null);
});

test("explicit Bluetooth selection overrides wired providers and fails clearly when absent", async (t) => {
  const native = { requestPort() {} };
  const bluetooth = { requestPort() {} };
  withNavigator(t, { serial: native, usb: {}, bluetooth: { requestDevice() {} } });
  const bridge = new BrowserSerialBridge({ createWebBluetoothSerial: () => bluetooth });
  assert.equal(await bridge._ensureSerial(), native, "auto preserves native serial priority");
  bridge.setPreferredTransport("webbluetooth");
  assert.equal(await bridge._ensureSerial(), bluetooth);
  assert.equal(bridge.transport, "webbluetooth");
  delete navigator.bluetooth;
  bridge.setPreferredTransport("webbluetooth");
  await assert.rejects(bridge._ensureSerial(), /Web Bluetooth is not supported/);
});

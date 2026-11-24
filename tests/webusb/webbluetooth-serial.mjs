import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge } from "../../web/js/serial.ts";
import { isPortSelectionCancelled } from "../../web/js/serial-errors.ts";
import { WebBluetoothSerialPort, createWebBluetoothSerial } from "../../web/js/webbluetooth-serial.ts";
import { bt1adDriver } from "../../web/js/webbluetooth/bt-1ad.ts";
import { ffe0UartDriver } from "../../web/js/webbluetooth/ffe0-uart.ts";
import { makeBluetoothDongle, makeBluetoothRadio } from "../support/fake-bluetooth.mjs";
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

test("Bluetooth chooser lists BT-1AD and built-in FFE0 radios and grants both UART services", async (t) => {
  const dongle = makeBluetoothDongle();
  let requested;
  withNavigator(t, { bluetooth: { async requestDevice(options) { requested = options; return dongle.device; } } });
  const port = await createWebBluetoothSerial().requestPort();
  assert.equal(port.device, dongle.device);
  assert.deepEqual(requested, {
    filters: [
      { services: ["0000bf98-0000-1000-8000-00805f9b34fb"] },
      { services: ["0000ffe0-0000-1000-8000-00805f9b34fb"] },
      { namePrefix: "walkie-talkie" },
    ],
    optionalServices: ["0000ff00-0000-1000-8000-00805f9b34fb", "0000ffe0-0000-1000-8000-00805f9b34fb"],
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
  port.onDisconnect(() => { losses += 1; });
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
  assert.match(event.deviceName, /BT-1AD/);
  assert.equal(bridge.port, null);
  assert.equal(bridge.writer, null);
  // The report does not wait for the transport's close (a lost device's may
  // never settle); this one does settle, and drops its listener.
  await new Promise((resolve) => setTimeout(resolve, 10));
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

test("unsupported BT-1AD UART settings are rejected before subscription or writes", async () => {
  const dongle = makeBluetoothDongle();
  const port = new WebBluetoothSerialPort(dongle.device, { settleMs: 0 });
  for (const options of [{ baudRate: 0 }, { baudRate: 1.5 }, { baudRate: 2 ** 32 },
    { baudRate: 9600, parity: "even" }, { baudRate: 9600, stopBits: 2 },
    { baudRate: 9600, dataBits: 7 }, { baudRate: 9600, flowControl: "hardware" }]) {
    await assert.rejects(port.open(options), /baud rate|8N1/);
  }
  assert.ok(dongle.calls.every((call) => !/:subscribe|:response|:command/.test(call.operation)));
  assert.equal(dongle.device.gatt.connected, false);
});

test("driver probing skips unmatched profiles and identifies BT-1AD without its advertised name", async (t) => {
  const dongle = makeBluetoothDongle();
  dongle.device.name = "Custom advertised name";
  const probes = [];
  const drivers = [
    { async probe() { probes.push("unmatched"); return null; } },
    bt1adDriver,
    { async probe() { throw new Error("Must stop at the first match"); } },
  ];
  const port = new WebBluetoothSerialPort(dongle.device, { drivers, settleMs: 0 });
  t.after(() => port.close());
  await port.open({ baudRate: 9600 });
  assert.deepEqual(probes, ["unmatched"]);
  assert.equal(port.driverName, "BT-1AD");
});

test("missing or incompatible BT-1AD characteristics reject the device without protocol writes", async () => {
  for (const mismatch of ["missing", "properties"]) {
    const dongle = makeBluetoothDongle();
    if (mismatch === "missing") dongle.characteristics.delete("ae10");
    else dongle.rx.properties.indicate = false;
    const port = new WebBluetoothSerialPort(dongle.device, { settleMs: 0 });
    await assert.rejects(port.open({ baudRate: 9600 }), /No supported BLE serial driver/);
    assert.equal(dongle.device.gatt.connected, false);
    assert.equal(dongle.device.listenerCount("gattserverdisconnected"), 0);
    assert.ok(dongle.calls.every((call) => !/:subscribe|:response|:command/.test(call.operation)));
  }
});

test("probe link failures propagate without trying another driver", async () => {
  const dongle = makeBluetoothDongle({ async onOperation(call) {
    if (call.operation.startsWith("service:")) throw new DOMException("Lost link", "NetworkError");
  } });
  const port = new WebBluetoothSerialPort(dongle.device, { drivers: [bt1adDriver,
    { async probe() { assert.fail("Link failures are not profile mismatches"); } },
  ] });
  await assert.rejects(port.open({ baudRate: 9600 }), /Lost link/);
  assert.equal(dongle.device.gatt.connected, false);
});

test("chooser includes every registered profile and deduplicates service permissions", async (t) => {
  const dongle = makeBluetoothDongle();
  let requested;
  withNavigator(t, { bluetooth: { async requestDevice(options) { requested = options; return dongle.device; } } });
  const second = { filters: [{ namePrefix: "Future adapter" }], optionalServices: ["other-service", ...bt1adDriver.optionalServices] };
  await createWebBluetoothSerial({ drivers: [bt1adDriver, second] }).requestPort();
  assert.deepEqual(requested.filters, [...bt1adDriver.filters, ...second.filters]);
  assert.deepEqual(requested.optionalServices, [...bt1adDriver.optionalServices, "other-service"]);
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
  assert.equal(bridge._ensureSerial(), native, "auto preserves native serial priority");
  bridge.setPreferredTransport("webbluetooth");
  assert.equal(bridge._ensureSerial(), bluetooth);
  assert.equal(bridge.transport, "webbluetooth");
  delete navigator.bluetooth;
  bridge.setPreferredTransport("webbluetooth");
  assert.throws(() => bridge._ensureSerial(), /Web Bluetooth is not supported/);
});

// Built-in radio Bluetooth (FFE0/FFE1): one characteristic both ways, no rate.
async function openRadio(t, radio = makeBluetoothRadio()) {
  const port = new WebBluetoothSerialPort(radio.device, { settleMs: 0 });
  t.after(() => port.close());
  await port.open({ baudRate: 115200 });
  return { port, ...radio };
}

test("a built-in FFE0 radio is matched after BT-1AD misses, subscribed and never sent a rate", async (t) => {
  const { calls, port } = await openRadio(t);
  assert.equal(port.driverName, "Built-in Bluetooth (FFE0)");
  assert.deepEqual(calls, [
    { operation: "connect" },
    { operation: "service:0000ff00-0000-1000-8000-00805f9b34fb" },
    { operation: "service:0000ffe0-0000-1000-8000-00805f9b34fb" },
    { operation: "characteristic:ffe1" },
    { operation: "ffe1:subscribe" },
  ]);
  await port.reconfigure({ baudRate: 9600 });
  assert.equal(calls.length, 5, "a rate change must not touch the radio");
  assert.deepEqual(port.capabilities, { framing: false, signals: false, reconfigure: "update" });
});

test("FFE1 writes go out in acknowledged twenty-byte chunks, in order", async (t) => {
  const { calls, port } = await openRadio(t);
  const writer = port.writable.getWriter();
  const bytes = Uint8Array.from({ length: 45 }, (_, i) => i);
  await writer.write(bytes);
  writer.releaseLock();
  const writes = calls.filter((call) => call.operation.startsWith("ffe1:") && call.bytes);
  assert.deepEqual(writes.map((call) => call.operation), ["ffe1:response", "ffe1:response", "ffe1:response"]);
  assert.deepEqual(writes.flatMap((call) => call.bytes), Array.from(bytes));
  assert.deepEqual(writes.map((call) => call.bytes.length), [20, 20, 5]);
});

test("FFE1 without write responses falls back to unacknowledged writes", async (t) => {
  const radio = makeBluetoothRadio({ properties: { writeWithoutResponse: true, notify: true } });
  const { calls, port } = await openRadio(t, radio);
  const writer = port.writable.getWriter();
  await writer.write(Uint8Array.of(1, 2, 3));
  writer.releaseLock();
  assert.deepEqual(calls.at(-1), { operation: "ffe1:command", bytes: [1, 2, 3] });
});

test("FFE1 notifications reach the readable stream", async (t) => {
  const radio = makeBluetoothRadio({ echo: true });
  const { port } = await openRadio(t, radio);
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  await writer.write(Uint8Array.of(0x06));
  writer.releaseLock();
  const { value } = await reader.read();
  reader.releaseLock();
  assert.deepEqual(Array.from(value), [0x06]);
});

test("an FFE1 that cannot notify or be written is not a radio UART", async () => {
  for (const properties of [{ write: true }, { notify: true }]) {
    const radio = makeBluetoothRadio({ properties });
    const port = new WebBluetoothSerialPort(radio.device, { settleMs: 0 });
    await assert.rejects(port.open({ baudRate: 115200 }), /No supported BLE serial driver/);
    assert.equal(radio.device.gatt.connected, false);
    assert.ok(radio.calls.every((call) => !/:subscribe|:response|:command/.test(call.operation)));
  }
});

test("built-in Bluetooth refuses settings other than 8N1 before subscribing", async () => {
  const radio = makeBluetoothRadio();
  const port = new WebBluetoothSerialPort(radio.device, { drivers: [ffe0UartDriver] });
  await assert.rejects(port.open({ baudRate: 115200, parity: "even" }), /8N1/);
  assert.ok(radio.calls.every((call) => call.operation !== "ffe1:subscribe"));
});

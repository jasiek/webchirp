import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SerialPortMock } from "serialport";
import { NativeSerialPort } from "../../web/js/native-serial-port.js";
import { SerialBridge } from "../../web/js/serial-bridge.mjs";
import { assertSerialTransport } from "../../web/js/serial-transport.mjs";
import { WebBluetoothSerialPort } from "../../web/js/webbluetooth-serial.js";
import { CdcSerialPort } from "../../web/js/webusb-serial.js";
import { makeBluetoothDongle } from "../support/fake-bluetooth.mjs";
import { makeEmitter } from "../support/fake-serial.mjs";
import { tick } from "../support/globals.mjs";
import { CHIP_NAMES, createChipLoopbackPort, createEchoPort } from "../support/loopback-harness.mjs";
import { NodeSerialPort } from "../support/node-serial-port.mjs";

// One set of cases, run against every implementation of the serial transport
// contract (web/js/serial-transport.mjs), each over the fake that stands in
// for its hardware:
//
//   ftdi, pl2303, ch340, cp2102  the real chip drivers over a looped-back fake
//                                USBDevice (tests/support/loopback-harness.mjs)
//   cdc-polyfill                 CdcSerialPort around a looped-back stand-in for
//                                the CDN polyfill, which cannot load offline
//   webserial-native             NativeSerialPort around a looped-back
//                                Web Serial-shaped port
//   webbluetooth-bt1ad           WebBluetoothSerialPort over the BT-1AD GATT
//                                fake with TX jumpered to RX
//   node-serialport              NodeSerialPort over serialport's own
//                                SerialPortMock (MockBinding, echo on), which
//                                runs the real stream code without a device
//
// Where a transport declares it cannot do something (capabilities), the case
// checks that it is refused exactly as declared rather than skipping it.
// Protocol details that belong to one chip stay in that chip's own test file.

const NO_SIGNALS = null;

// A chip driver over a looped-back fake USBDevice. A line change is seen as a
// control transfer reaching the device; loss is navigator.usb's event.
function chipFixture(chip) {
  const usb = makeEmitter();
  const { port, device, controlLog } = createChipLoopbackPort(chip, { usb, latencyMs: 1 });
  return {
    port,
    usbDevice: device,
    deviceLineWrites: () => controlLog.filter((entry) => entry.direction === "out").length,
    loseDevice: () => usb.emit("disconnect", { target: usb, device }),
    loseOtherDevice: () => usb.emit("disconnect", {
      target: usb, device: { vendorId: device.vendorId, productId: device.productId },
    }),
  };
}

// The polyfill's stand-in records the device it was built for, as the real
// one does, and loops TX to RX.
function cdcFixture() {
  const usb = makeEmitter();
  const device = { vendorId: 0x2341, productId: 0x0043 };
  const polyfillPort = createEchoPort();
  polyfillPort.getInfo = () => ({ usbVendorId: device.vendorId, usbProductId: device.productId });
  let lineWrites = 0;
  const setSignals = polyfillPort.setSignals.bind(polyfillPort);
  polyfillPort.setSignals = async (signals) => {
    lineWrites += 1;
    return setSignals(signals);
  };
  return {
    port: new CdcSerialPort(polyfillPort, device, { usb }),
    usbDevice: device,
    deviceLineWrites: () => lineWrites,
    loseDevice: () => usb.emit("disconnect", { target: usb, device }),
    loseOtherDevice: () => usb.emit("disconnect", { target: usb, device: { ...device } }),
  };
}

// Native Web Serial: the browser fires "disconnect" at the SerialPort, which
// bubbles to navigator.serial.
function nativeFixture() {
  const serial = makeEmitter();
  const nativePort = createEchoPort();
  let lineWrites = 0;
  const setSignals = nativePort.setSignals.bind(nativePort);
  nativePort.setSignals = async (signals) => {
    lineWrites += 1;
    return setSignals(signals);
  };
  return {
    port: new NativeSerialPort(nativePort, { events: serial }),
    usbDevice: null,
    deviceLineWrites: () => lineWrites,
    loseDevice: () => serial.emit("disconnect", { target: nativePort }),
    loseOtherDevice: () => serial.emit("disconnect", { target: createEchoPort() }),
  };
}

// BT-1AD over GATT: loss is the link dropping. It has no DTR/RTS command, so
// its line writes are never observed.
function bluetoothFixture() {
  const dongle = makeBluetoothDongle({ echo: true });
  return {
    port: new WebBluetoothSerialPort(dongle.device, { settleMs: 0 }),
    usbDevice: null,
    deviceLineWrites: NO_SIGNALS,
    loseDevice: () => dongle.device.emit("gattserverdisconnected", { target: dongle.device }),
    loseOtherDevice: () => makeBluetoothDongle().device.emit("gattserverdisconnected", {}),
  };
}

let mockPortCount = 0;

// node-serialport over MockBinding. A line change is the binding's set(); loss
// is the stream's own disconnect path, which a failed binding read takes.
function nodeFixture() {
  const path = `/dev/conformance-${mockPortCount += 1}`;
  SerialPortMock.binding.createPort(path, { echo: true });
  const port = new NodeSerialPort(path, { SerialPortClass: SerialPortMock });
  let lineWrites = 0;
  const watchBinding = () => {
    const binding = port.nodePort?.port;
    if (binding && !binding.countedSet) {
      const set = binding.set.bind(binding);
      binding.set = async (options) => {
        lineWrites += 1;
        return set(options);
      };
      binding.countedSet = true;
    }
  };
  const open = port.open.bind(port);
  port.open = async (options) => {
    await open(options);
    watchBinding();
  };
  return {
    port,
    usbDevice: null,
    deviceLineWrites: () => lineWrites,
    // No handle while closed, so nothing to lose.
    loseDevice: () => port.nodePort?._disconnected(new Error("device unplugged")),
    loseOtherDevice: () => {
      const other = `/dev/conformance-${mockPortCount += 1}`;
      SerialPortMock.binding.createPort(other);
      new SerialPortMock({ path: other, baudRate: 9600 }, () => {}).on("open", function onOpen() {
        this._disconnected(new Error("another device unplugged"));
      });
    },
  };
}

const TRANSPORTS = [
  ...CHIP_NAMES.map((chip) => ({ name: chip, create: () => chipFixture(chip) })),
  { name: "cdc-polyfill", create: cdcFixture },
  { name: "webserial-native", create: nativeFixture },
  { name: "webbluetooth-bt1ad", create: bluetoothFixture },
  { name: "node-serialport", create: nodeFixture },
];

const OPEN_OPTIONS = { baudRate: 57600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };

// Write bytes through the port's own streams and read them back off the
// loopback, as many chunks as it takes.
async function roundTrip(port, bytes) {
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  try {
    await writer.write(Uint8Array.from(bytes));
    const received = [];
    const deadline = Date.now() + 2000;
    while (received.length < bytes.length && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: null, done: false }), 100)),
      ]);
      if (done) {
        break;
      }
      if (value) {
        received.push(...value);
      }
    }
    return received;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
  }
}

// Open the port behind a SerialBridge, the way the app and the CLI use it,
// and record every option set the bridge hands the port.
async function openThroughBridge(port) {
  const applied = [];
  for (const method of ["open", "reconfigure"]) {
    if (typeof port[method] === "function") {
      const original = port[method].bind(port);
      port[method] = async (options) => {
        applied.push({ method, ...options });
        return original(options);
      };
    }
  }
  const bridge = new SerialBridge({ requestTransport: async () => port });
  await bridge.open(57600);
  return { bridge, applied };
}

// Wait until the bridge has buffered at least count bytes.
async function waitForBuffered(bridge, count) {
  const deadline = Date.now() + 2000;
  while (bridge.readBuffer.length < count && Date.now() < deadline) {
    await bridge.inWaiting(50);
  }
  return bridge.readBuffer.length;
}

for (const { name, create } of TRANSPORTS) {
  describe(`${name} transport`, () => {
    test("assertSerialTransport passes, closed and open", async () => {
      const { port } = create();
      assert.equal(assertSerialTransport(port), port);
      await port.open(OPEN_OPTIONS);
      assert.equal(assertSerialTransport(port), port);
      await port.close();
    });

    test("open, write and read round-trip bytes through a loopback", async () => {
      const { port } = create();
      await port.open(OPEN_OPTIONS);
      // 0x11/0x13 are the bytes software flow control would eat.
      const bytes = [0x00, 0x11, 0x13, 0x55, 0xaa, 0xff];
      assert.deepEqual(await roundTrip(port, bytes), bytes);
      await port.close();
    });

    test("setSignals reaches the device, or is refused as capabilities.signals says", async () => {
      const fixture = create();
      const { port } = fixture;
      await port.open(OPEN_OPTIONS);
      if (port.capabilities.signals) {
        const before = fixture.deviceLineWrites();
        await port.setSignals({ dataTerminalReady: true, requestToSend: false });
        assert.ok(fixture.deviceLineWrites() > before, "the line change never reached the device");
      } else {
        assert.equal(fixture.deviceLineWrites, NO_SIGNALS);
        await assert.rejects(() => port.setSignals({ dataTerminalReady: true }));
        // The bridge refuses up front, naming the adapter, rather than
        // leaving it to the transport's own error.
        const bridge = new SerialBridge({ requestTransport: async () => port });
        await port.close();
        await bridge.open(57600);
        await assert.rejects(() => bridge.setSignals(true, null), /cannot set DTR\/RTS/);
        await bridge.close();
        return;
      }
      await port.close();
    });

    test("close releases the device and a second open works", async () => {
      const { port } = create();
      await port.open(OPEN_OPTIONS);
      assert.deepEqual(await roundTrip(port, [0x01, 0x02]), [0x01, 0x02]);
      await port.close();
      assert.equal(port.readable ?? null, null, "a closed port keeps no readable");
      await port.open(OPEN_OPTIONS);
      assert.deepEqual(await roundTrip(port, [0x03, 0x04]), [0x03, 0x04]);
      await port.close();
    });

    test("a framing change succeeds or is refused exactly as capabilities.framing says", async () => {
      const { port } = create();
      const { bridge, applied } = await openThroughBridge(port);
      const before = applied.length;
      if (port.capabilities.framing) {
        const res = await bridge.reconfigure({ parity: "even", stopBits: 2 });
        assert.equal(res.reconfigured, true);
        const last = applied.at(-1);
        assert.equal(last.method, port.capabilities.reconfigure === "update" ? "reconfigure" : "open");
        assert.equal(last.parity, "even");
        assert.equal(last.stopBits, 2);
      } else {
        await assert.rejects(
          () => bridge.reconfigure({ parity: "even" }),
          /cannot change parity: it runs at 8N1 only/,
        );
        assert.equal(applied.length, before, "a refused change must not touch the port");
        assert.equal(bridge.portOptions.parity, "none");
      }
      await bridge.close();
    });

    test("a reconfigure keeps buffered bytes", async () => {
      const { port } = create();
      const { bridge, applied } = await openThroughBridge(port);
      await bridge.writeBytes([0x06, 0x16]);
      assert.equal(await waitForBuffered(bridge, 2), 2);

      const res = await bridge.reconfigure({ baudRate: 115200 });

      assert.equal(res.reconfigured, true);
      assert.equal(applied.at(-1).baudRate, 115200);
      assert.equal(
        applied.at(-1).method,
        port.capabilities.reconfigure === "update" ? "reconfigure" : "open",
        "the bridge must take the route the transport declares",
      );
      assert.deepEqual(await bridge.readBytes(2, 500), [0x06, 0x16]);
      // And the line still carries traffic at the new rate.
      await bridge.writeBytes([0x51]);
      assert.deepEqual(await bridge.readBytes(1, 1000), [0x51]);
      await bridge.close();
    });

    test("disconnect fires the normalised callback once, and only for this port", async () => {
      const fixture = create();
      const { port } = fixture;
      const seen = [];
      port.onDisconnect((payload) => seen.push(payload));

      // Not while closed, not for another device, not on an intentional close.
      fixture.loseDevice();
      await port.open(OPEN_OPTIONS);
      fixture.loseOtherDevice();
      await tick();
      await port.close();
      await tick();
      assert.equal(seen.length, 0);

      await port.open(OPEN_OPTIONS);
      fixture.loseDevice();
      await tick();
      fixture.loseDevice();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0]).sort(), ["port", "transport"]);
      assert.equal(seen[0].port, port);
      assert.equal(seen[0].transport, port.transport);
      // The bridge closes a lost port; that must still work.
      await port.close();
    });

    test("usbDevice is the USBDevice behind the port, or null", () => {
      const fixture = create();
      assert.equal(fixture.port.usbDevice, fixture.usbDevice);
    });
  });
}

// The declared capabilities, pinned per transport: a change here is a
// behaviour change for the radios that need framing or control lines, so it
// has to be made on purpose.
test("each transport declares the capabilities its adapter has", async () => {
  const declared = {};
  for (const { name, create } of TRANSPORTS) {
    const { port } = create();
    await port.open(OPEN_OPTIONS);
    declared[name] = { transport: port.transport, ...port.capabilities };
    await port.close();
  }
  const chip = { transport: "webusb", framing: false, signals: true, reconfigure: "reopen" };
  assert.deepEqual(declared, {
    ftdi: chip,
    pl2303: chip,
    ch340: chip,
    cp2102: chip,
    "cdc-polyfill": { transport: "webusb", framing: true, signals: true, reconfigure: "reopen" },
    "webserial-native": { transport: "webserial", framing: true, signals: true, reconfigure: "reopen" },
    "webbluetooth-bt1ad": { transport: "webbluetooth", framing: false, signals: false, reconfigure: "update" },
    "node-serialport": { transport: "node", framing: true, signals: true, reconfigure: "update" },
  });
});

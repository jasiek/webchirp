import assert from "node:assert/strict";
import test from "node:test";
import {
  CH340_DEVICE_IDS,
  Ch340SerialPort,
  ch340GetDivisor,
  isCh340Device,
} from "../web/js/ch340-webusb.js";
import { createWebUsbSerial } from "../web/js/webusb-serial.js";

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

// Fake USBDevice for a CH340: bulk OUT + bulk IN + interrupt IN (modem status)
// endpoints, recording every control transfer and answering the version read
// and the register-read quirk probe.
function makeFakeDevice({
  version = 0x31,
  readRegStatus = "ok",
  transferResults = [],
} = {}) {
  const controlIn = [];
  const controlOut = [];
  const clearHaltCalls = [];
  const transferInCalls = [];
  const device = {
    vendorId: 0x1a86,
    productId: 0x7523,
    configuration: {
      interfaces: [
        {
          interfaceNumber: 0,
          alternate: {
            endpoints: [
              { type: "bulk", direction: "out", endpointNumber: 1, packetSize: 32 },
              { type: "bulk", direction: "in", endpointNumber: 2, packetSize: 32 },
              { type: "interrupt", direction: "in", endpointNumber: 3, packetSize: 8 },
            ],
          },
        },
      ],
    },
    open: async () => {},
    claimInterface: async () => {},
    releaseInterface: async () => {},
    close: async () => {},
    controlTransferIn: async (setup, length) => {
      controlIn.push({ ...setup, length });
      if (setup.request === 0x5f) {
        return { status: "ok", data: new DataView(new Uint8Array([version, 0x00]).buffer) };
      }
      if (setup.request === 0x95) {
        if (readRegStatus !== "ok") {
          return { status: readRegStatus };
        }
        return { status: "ok", data: new DataView(new Uint8Array([0x00, 0x00]).buffer) };
      }
      return { status: "ok", data: new DataView(new ArrayBuffer(length)) };
    },
    controlTransferOut: async (setup) => {
      controlOut.push({ request: setup.request, value: setup.value, index: setup.index });
      return { status: "ok" };
    },
    clearHalt: async (direction, endpoint) => {
      clearHaltCalls.push({ direction, endpoint });
    },
    transferIn: async (endpointNumber, length) => {
      transferInCalls.push({ endpointNumber, length });
      const next = transferResults.shift();
      if (next) {
        return next;
      }
      return new Promise(() => {}); // no further data; hang like real hardware
    },
    transferOut: async () => ({ status: "ok" }),
  };
  return { device, controlIn, controlOut, clearHaltCalls, transferInCalls };
}

test("ch340GetDivisor matches known CH341 prescaler/divisor encodings", () => {
  // Values published for the CH341 baud generator (high byte = 0x100 - div,
  // low byte = fact<<2 | ps), before the version-dependent bit 7 is applied.
  assert.equal(ch340GetDivisor(9600), 0xb202);
  assert.equal(ch340GetDivisor(19200), 0xd902);
  assert.equal(ch340GetDivisor(38400), 0x6403);
  assert.equal(ch340GetDivisor(57600), 0x9803);
  assert.equal(ch340GetDivisor(115200), 0xcc03);
  assert.throws(() => ch340GetDivisor(0), /Invalid CH340 baud rate/);
  assert.throws(() => ch340GetDivisor("nope"), /Invalid CH340 baud rate/);
});

test("ch340GetDivisor clamps out-of-range rates instead of failing", () => {
  // The kernel clamps to [46, 3000000] rather than rejecting, so a caller
  // asking for something absurd still gets a usable line speed.
  assert.equal(ch340GetDivisor(1), ch340GetDivisor(46));
  assert.equal(ch340GetDivisor(12000000), ch340GetDivisor(3000000));
});

test("the limited-prescaler quirk leaves every standard radio baud unchanged", () => {
  // Clone silicon cannot use the faster base clocks. It only ever changes the
  // encoding when the first-pass divisor comes out odd, which no rate CHIRP
  // uses does — worth pinning, since it means the quirk cannot regress a
  // working cable.
  for (const baud of [9600, 19200, 38400, 57600, 115200]) {
    assert.equal(
      ch340GetDivisor(baud, { limitedPrescaler: true }),
      ch340GetDivisor(baud),
      `quirk changed the encoding for ${baud} baud`,
    );
  }
  // A rate that does land on an odd divisor takes the halved base clock.
  assert.equal(ch340GetDivisor(14851), 0x9b06);
  assert.equal(ch340GetDivisor(14851, { limitedPrescaler: true }), 0xcd02);
});

test("isCh340Device recognizes the CH340/CH341 vendor and product pairs", () => {
  // The concrete cable this driver was written for.
  assert.ok(isCh340Device({ vendorId: 0x1a86, productId: 0x7523 }));
  assert.ok(isCh340Device({ vendorId: 0x1a86, productId: 0x5523 }));
  assert.ok(isCh340Device({ vendorId: 0x4348, productId: 0x5523 })); // clone id
  // Same vendor, but a CH9102/CH343 that enumerates as CDC-ACM: must fall
  // through to the polyfill rather than get the CH340 register map.
  assert.ok(!isCh340Device({ vendorId: 0x1a86, productId: 0x55d4 }));
  assert.ok(!isCh340Device({ vendorId: 0x0403, productId: 0x6015 })); // FTDI
  assert.ok(!isCh340Device(null));
});

test("WebUSB provider dispatches CH340 devices to the CH340 driver", async () => {
  let requestedOptions = null;
  setNavigator({
    usb: {
      requestDevice: async (options) => {
        requestedOptions = options;
        return { vendorId: 0x1a86, productId: 0x7523 };
      },
    },
  });
  const serial = createWebUsbSerial({
    loadCdcSerialPort: async () => {
      throw new Error("CDC polyfill should not load for CH340 devices");
    },
  });
  const port = await serial.requestPort();
  assert.ok(port instanceof Ch340SerialPort);
  assert.deepEqual(port.getInfo(), { usbVendorId: 0x1a86, usbProductId: 0x7523 });
  // The chooser must filter on every CH340 id pair, or the device is never
  // shown. Filtering by vendor id alone would also list WCH's CDC parts.
  for (const id of CH340_DEVICE_IDS) {
    assert.ok(
      requestedOptions?.filters?.some(
        (f) => f.vendorId === id.vendorId && f.productId === id.productId,
      ),
      `requestDevice must filter on ${id.vendorId.toString(16)}:${id.productId.toString(16)}`,
    );
  }
});

test("Ch340SerialPort.open() runs the init sequence for a modern chip", async () => {
  const { device, controlIn, controlOut } = makeFakeDevice({ version: 0x31 });
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.equal(port.version, 0x31);
  assert.equal(port.limitedPrescaler, false);
  // Version read first (it gates the two branches below), then the break
  // register probe used for quirk detection.
  assert.deepEqual(controlIn, [
    { requestType: "vendor", recipient: "device", request: 0x5f, value: 0, index: 0, length: 2 },
    { requestType: "vendor", recipient: "device", request: 0x95, value: 0x05, index: 0, length: 2 },
  ]);
  assert.deepEqual(controlOut, [
    { request: 0xa1, value: 0x0000, index: 0x0000 }, // SERIAL_INIT
    // Divisor/prescaler register pair; 0xb202 for 9600 baud, plus bit 7 so the
    // chip stops holding data back until a full 32-byte packet.
    { request: 0x9a, value: 0x1312, index: 0xb282 },
    { request: 0x9a, value: 0x2518, index: 0x00c3 }, // LCR pair: 8N1, RX+TX on
    { request: 0xa4, value: 0xffff, index: 0x0000 }, // DTR/RTS low (inverted)
  ]);
  assert.ok(port.readable, "readable stream must be set up");
  assert.ok(port.writable, "writable stream must be set up");
});

test("Ch340SerialPort.open() skips the LCR write and bit 7 on pre-0x30 chips", async () => {
  const { device, controlOut } = makeFakeDevice({ version: 0x27 });
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 115200 });

  // Chips at 0x27 configure framing through separate registers (left at their
  // 8N1 defaults) and want bit 7 clear.
  assert.deepEqual(controlOut, [
    { request: 0xa1, value: 0x0000, index: 0x0000 },
    { request: 0x9a, value: 0x1312, index: 0xcc03 },
    { request: 0xa4, value: 0xffff, index: 0x0000 },
  ]);
});

test("Ch340SerialPort.open() falls back to the quirk when register reads stall", async () => {
  const { device } = makeFakeDevice({ readRegStatus: "stall" });
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.equal(port.limitedPrescaler, true);
});

test("Ch340SerialPort.setSignals writes the inverted modem control byte", async () => {
  const { device, controlOut } = makeFakeDevice();
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 9600 });
  controlOut.length = 0;

  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  assert.deepEqual(controlOut, [{ request: 0xa4, value: 0xff9f, index: 0x0000 }]);

  // Unspecified lines keep their cached state: only RTS drops here.
  await port.setSignals({ requestToSend: false });
  assert.deepEqual(controlOut.at(-1), { request: 0xa4, value: 0xffdf, index: 0x0000 });

  // A no-op change must not spend a control transfer.
  const before = controlOut.length;
  await port.setSignals({ requestToSend: false });
  assert.equal(controlOut.length, before);
});

test("Ch340SerialPort read path clears a stalled IN endpoint and passes raw bytes", async () => {
  // Unlike FTDI, CH340 bulk IN carries no status header — every byte is
  // payload, and empty packets must not resolve the pull (that wedges reads).
  const { device, clearHaltCalls } = makeFakeDevice({
    transferResults: [
      { status: "stall" },
      { status: "ok", data: new DataView(new Uint8Array([]).buffer) },
      { status: "ok", data: new DataView(new Uint8Array([0xaa, 0xbb, 0xcc]).buffer) },
    ],
  });
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const { value } = await reader.read();

  assert.deepEqual(clearHaltCalls, [{ direction: "in", endpoint: 2 }]);
  assert.deepEqual(Array.from(value), [0xaa, 0xbb, 0xcc]);
});

test("Ch340SerialPort keeps several bulk IN transfers queued at once", async () => {
  // With a single transfer outstanding the host has no IN request queued
  // between one completing and the next being issued. The chip's 32-byte
  // endpoint needs one every 2.8 ms at 115200 — shorter than a USB round trip
  // on Android — so its RX FIFO overruns in the gap and drops bytes silently.
  // Measured on a Pixel 10: one transfer in flight lost bytes on every 16 KB
  // echo at 115200; a pipeline lost none.
  const { device, transferInCalls } = makeFakeDevice();
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 115200 });
  // The stream pulls as soon as it is constructed, which primes the queue.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(
    transferInCalls.length > 1,
    `expected several transfers queued at once, saw ${transferInCalls.length}`,
  );
});

test("Ch340SerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // A bulk IN transfer ends on a short packet or on the full requested length,
  // and this chip sends nothing to terminate one. Requesting more than a packet
  // therefore strands any reply whose length is an exact multiple of the packet
  // size — measured against a 512-byte request, 32-, 64- and 96-byte replies
  // never arrived at all. Throughput must come from queue depth, not from
  // asking for more bytes per transfer.
  const { device, transferInCalls } = makeFakeDevice();
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 115200 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(transferInCalls.length > 0, "expected the read path to queue a transfer");
  for (const call of transferInCalls) {
    assert.equal(call.endpointNumber, 2);
    assert.equal(call.length, 32, "bulk IN transfers must request exactly one packet");
  }
});

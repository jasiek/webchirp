import assert from "node:assert/strict";
import test from "node:test";
import {
  CH340_DEVICE_IDS,
  Ch340SerialPort,
  ch340GetDivisor,
  ch340LineControl,
  isCh340Device,
} from "../../web/js/ch340-webusb.ts";
import { createWebUsbSerial } from "../../web/js/webusb-serial.ts";
import { makeFakeUsbDevice } from "../support/fake-usb.mjs";
import { withNavigator } from "../support/globals.mjs";
import {
  expectFullPipeline,
  expectOnePacketPerTransfer,
  expectStallRecovery,
} from "../support/usb-read-path.mjs";
import {
  expectShortWriteResumed,
  expectStalledWriteFails,
  expectStuckWriteFails,
} from "../support/usb-write-path.mjs";

// Fake USBDevice for a CH340: bulk OUT + bulk IN + interrupt IN (modem status)
// endpoints, recording every control transfer and answering the version read
// and the register-read quirk probe.
function makeFakeDevice({
  version = 0x31,
  readRegStatus = "ok",
  cancelOnClearHalt = false,
} = {}) {
  const controlIn = [];
  const controlOut = [];
  const fake = makeFakeUsbDevice({
    vendorId: 0x1a86,
    productId: 0x7523,
    endpoints: [
      { type: "bulk", direction: "out", endpointNumber: 1, packetSize: 32 },
      { type: "bulk", direction: "in", endpointNumber: 2, packetSize: 32 },
      { type: "interrupt", direction: "in", endpointNumber: 3, packetSize: 8 },
    ],
    cancelOnClearHalt,
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
  });
  return { ...fake, controlIn, controlOut };
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

test("WebUSB provider dispatches CH340 devices to the CH340 driver", async (t) => {
  let requestedOptions = null;
  withNavigator(t, {
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

test("ch340LineControl builds the LCR as the kernel's ch341_set_termios does", () => {
  // RX+TX enable (0xc0), CS7 0x02 / CS8 0x03, parity enable 0x08 plus 0x10 for
  // even, 0x04 for two stop bits.
  assert.equal(ch340LineControl({ dataBits: 8, parity: "none", stopBits: 1 }), 0xc3);
  assert.equal(ch340LineControl({ dataBits: 8, parity: "even", stopBits: 1 }), 0xdb);
  assert.equal(ch340LineControl({ dataBits: 7, parity: "even", stopBits: 1 }), 0xda);
  assert.equal(ch340LineControl({ dataBits: 8, parity: "none", stopBits: 2 }), 0xc7);
  assert.equal(ch340LineControl({ dataBits: 8, parity: "odd", stopBits: 1 }), 0xcb);
});

for (const [label, options, lcr] of [
  ["8E1", { dataBits: 8, parity: "even", stopBits: 1 }, 0xdb],
  ["7E1", { dataBits: 7, parity: "even", stopBits: 1 }, 0xda],
  ["8N2", { dataBits: 8, parity: "none", stopBits: 2 }, 0xc7],
]) {
  test(`Ch340SerialPort.open() programs ${label} in the LCR pair`, async () => {
    const { device, controlOut } = makeFakeDevice({ version: 0x31 });
    const port = new Ch340SerialPort(device);
    await port.open({ baudRate: 9600, ...options });

    assert.deepEqual(
      controlOut.filter((call) => call.request === 0x9a && call.value === 0x2518),
      [{ request: 0x9a, value: 0x2518, index: lcr }],
    );
  });
}

test("Ch340SerialPort declares framing only once it knows the chip keeps it in the LCR", async () => {
  // The version is learnt at open(); before that the port answers
  // conservatively, and a pre-0x30 part stays 8N1 only, so the bridge refuses
  // a framing change on it instead of reopening into a frame it never got.
  const modern = new Ch340SerialPort(makeFakeDevice({ version: 0x31 }).device);
  assert.equal(modern.capabilities.framing, false);
  await modern.open({ baudRate: 9600 });
  assert.equal(modern.capabilities.framing, true);

  const old = new Ch340SerialPort(makeFakeDevice({ version: 0x27 }).device);
  await old.open({ baudRate: 9600 });
  assert.equal(old.capabilities.framing, false);
});

test("Ch340SerialPort.open() refuses a non-8N1 frame on a pre-0x30 chip and hands the device back", async () => {
  const { device, controlOut } = makeFakeDevice({ version: 0x27 });
  let released = 0;
  let closed = 0;
  device.releaseInterface = async () => { released += 1; };
  device.close = async () => { closed += 1; };
  const port = new Ch340SerialPort(device);

  await assert.rejects(
    port.open({ baudRate: 9600, parity: "even" }),
    /^UsbChipSetupFailedError: CH340: chip version 0x27 runs at 8N1 only \(asked for 8E1\)/,
  );
  assert.deepEqual(controlOut, [], "nothing may be configured for a frame the chip cannot carry");
  assert.equal(released, 1);
  assert.equal(closed, 1);
});

test("Ch340SerialPort.open() refuses a frame it cannot program before touching the chip", async () => {
  const { device, controlIn, controlOut } = makeFakeDevice();
  const port = new Ch340SerialPort(device);

  await assert.rejects(
    port.open({ baudRate: 9600, stopBits: 1.5 }),
    /CH340: cannot program 1.5 stop bits/,
  );
  assert.deepEqual(controlIn, []);
  assert.deepEqual(controlOut, []);
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
  //
  // The halt is cleared with a queue of transfers still outstanding, and
  // clearHalt() cancels every one of them. Chromium reports a cancellation as a
  // rejected promise (AbortError), not as a result carrying a status, so a read
  // path that keeps the pre-stall queue awaits a cancelled transfer on its next
  // turn and errors the stream for good. This test fails that way if the queue
  // is not retired before the halt is cleared.
  await expectStallRecovery({
    Port: Ch340SerialPort,
    fake: makeFakeDevice({ cancelOnClearHalt: true }),
    endpointNumber: 2,
    payload: [0xaa, 0xbb, 0xcc],
  });
});

test("Ch340SerialPort keeps a full pipeline of bulk IN transfers queued", async () => {
  // With a single transfer outstanding the host has no IN request queued
  // between one completing and the next being issued. The chip's 32-byte
  // endpoint needs one every 2.8 ms at 115200 — shorter than a USB round trip
  // on Android — so its RX FIFO overruns in the gap and drops bytes silently.
  // Measured on a Pixel 10: one transfer in flight lost bytes on every 16 KB
  // echo at 115200; a pipeline lost none.
  //
  // Both halves of that fix are load-bearing and both are pinned here by the
  // call count. No reader is attached, so the only thing driving further pulls
  // is the stream's own high-water mark: 16 transfers are queued up front, and
  // each of the 15 pulls after the first replenishes exactly one. A shallower
  // depth, or the default queue of one, yields a smaller number.
  await expectFullPipeline({ Port: Ch340SerialPort, fake: makeFakeDevice() });
});

test("Ch340SerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // A bulk IN transfer ends on a short packet or on the full requested length,
  // and this chip sends nothing to terminate one. Requesting more than a packet
  // therefore strands any reply whose length is an exact multiple of the packet
  // size — measured against a 512-byte request, 32-, 64- and 96-byte replies
  // never arrived at all. Throughput must come from queue depth, not from
  // asking for more bytes per transfer.
  await expectOnePacketPerTransfer({
    Port: Ch340SerialPort,
    fake: makeFakeDevice(),
    endpointNumber: 2,
    packetSize: 32,
  });
});

test("Ch340SerialPort write path reports a stalled bulk OUT instead of losing bytes", async () => {
  // WebUSB resolves a failed bulk OUT with a status rather than rejecting, so a
  // write path that ignores the result reports success on a protocol block that
  // went nowhere: an upload truncated silently, surfacing later as a read
  // timeout, with the endpoint left halted for every retry.
  await expectStalledWriteFails({
    Port: Ch340SerialPort,
    fake: makeFakeDevice(),
    chip: "CH340",
    endpointNumber: 1,
  });
});

test("Ch340SerialPort write path resumes a short bulk OUT transfer", async () => {
  // bytesWritten can be less than the chunk; assuming a partial write was a
  // whole one drops the tail of a frame silently.
  await expectShortWriteResumed({
    Port: Ch340SerialPort,
    fake: makeFakeDevice(),
    endpointNumber: 1,
  });
});

test("Ch340SerialPort write path gives up on a transfer that never progresses", async () => {
  await expectStuckWriteFails({
    Port: Ch340SerialPort,
    fake: makeFakeDevice(),
    chip: "CH340",
  });
});

test("Ch340SerialPort.getSignals reads the inverted modem status register", async () => {
  // The kernel's ch341_get_status(): READ_REG of 0x0706, first byte inverted,
  // CTS 0x01, DSR 0x02, RI 0x04, DCD 0x08.
  const { device, controlIn } = makeFakeDevice();
  let raw = ~(0x01 | 0x04) & 0xff;
  const answer = device.controlTransferIn;
  device.controlTransferIn = async (setup, length) => {
    if (setup.request === 0x95 && setup.value === 0x0706) {
      controlIn.push({ ...setup, length });
      return { status: "ok", data: new DataView(new Uint8Array([raw, 0xee]).buffer) };
    }
    return answer(setup, length);
  };
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 9600 });
  controlIn.length = 0;

  assert.deepEqual(await port.getSignals(), {
    clearToSend: true,
    dataSetReady: false,
    dataCarrierDetect: false,
    ringIndicator: true,
  });
  assert.deepEqual(controlIn, [
    { requestType: "vendor", recipient: "device", request: 0x95, value: 0x0706, index: 0, length: 2 },
  ]);

  // The high bits of the register are not modem lines and must not leak in.
  raw = ~(0x02 | 0x08) & 0x0f;
  assert.deepEqual(await port.getSignals(), {
    clearToSend: false,
    dataSetReady: true,
    dataCarrierDetect: true,
    ringIndicator: false,
  });
});

test("Ch340SerialPort.getSignals reports a failed register read", async () => {
  // Clone silicon that rejects register reads cannot report its lines either.
  const { device } = makeFakeDevice({ readRegStatus: "stall" });
  const port = new Ch340SerialPort(device);
  await port.open({ baudRate: 9600 });

  await assert.rejects(port.getSignals(), /CH340 control read 0x95 failed: stall/);
});

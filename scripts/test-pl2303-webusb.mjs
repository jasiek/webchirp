import assert from "node:assert/strict";
import test from "node:test";
import {
  PL2303_TYPE_01,
  PL2303_TYPE_HX,
  PL2303_TYPE_HXN,
  PL2303_TYPE_T,
  PROLIFIC_VENDOR_ID,
  Pl2303SerialPort,
  detectPl2303Type,
  isProlificDevice,
  pickPl2303BaudRate,
} from "../web/js/pl2303-webusb.js";
import { createWebUsbSerial } from "../web/js/webusb-serial.js";

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

// A device descriptor blob for GET_DESCRIPTOR: bcdUSB at bytes 2-3,
// bDeviceClass at 4, bMaxPacketSize0 at 7, bcdDevice at bytes 12-13.
function descriptorBytes({ usbVersion, deviceClass, maxPacketSize0, deviceVersion }) {
  const bytes = new Uint8Array(18);
  bytes[2] = usbVersion & 0xff;
  bytes[3] = (usbVersion >> 8) & 0xff;
  bytes[4] = deviceClass;
  bytes[7] = maxPacketSize0;
  bytes[12] = deviceVersion & 0xff;
  bytes[13] = (deviceVersion >> 8) & 0xff;
  return bytes;
}

// Fake USBDevice for a PL2303: interrupt IN + bulk OUT + bulk IN endpoints,
// records all control transfers, answers GET_DESCRIPTOR and the HX probe.
function makeFakeDevice({
  descriptor,
  hxProbeSucceeds = true,
  cancelOnClearHalt = false,
  endpoints = [
    { type: "interrupt", direction: "in", endpointNumber: 1, packetSize: 10 },
    { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
    { type: "bulk", direction: "in", endpointNumber: 3, packetSize: 64 },
  ],
  interfaceNumber = 0,
}) {
  const controlIn = [];
  const controlOut = [];
  const transferInCalls = [];
  const clearHaltCalls = [];
  // Transfers the driver has queued that the fake has not answered yet.
  const outstanding = [];
  const device = {
    vendorId: 0x067b,
    productId: 0x2303,
    configuration: {
      interfaces: [
        {
          interfaceNumber,
          alternate: { endpoints },
        },
      ],
    },
    open: async () => {},
    claimInterface: async () => {},
    controlTransferIn: async (setup, length) => {
      controlIn.push({ ...setup, length });
      if (setup.requestType === "standard" && setup.request === 0x06) {
        return { status: "ok", data: new DataView(descriptorBytes(descriptor).buffer) };
      }
      if (setup.requestType === "vendor" && setup.value === 0x8080) {
        if (!hxProbeSucceeds) {
          throw new Error("stall");
        }
        return { status: "ok", data: new DataView(new Uint8Array([0]).buffer) };
      }
      return { status: "ok", data: new DataView(new Uint8Array(length || 1).buffer) };
    },
    controlTransferOut: async (setup, data) => {
      controlOut.push({ ...setup, data: data ? new Uint8Array(data.slice ? data.slice(0) : data) : null });
      return { status: "ok" };
    },
    clearHalt: async (direction, endpoint) => {
      clearHaltCalls.push({ direction, endpoint });
      if (cancelOnClearHalt) {
        // Chromium cancels every transfer outstanding on the interface before
        // it clears the endpoint, and Blink rejects a cancelled transfer with
        // AbortError rather than completing it with a status.
        for (const transfer of outstanding.splice(0)) {
          transfer.reject(Object.assign(
            new Error("The transfer was cancelled."),
            { name: "AbortError" },
          ));
        }
      }
    },
    transferIn: async (endpointNumber, length) => {
      transferInCalls.push({ endpointNumber, length });
      // Left unanswered until the test delivers a result, the way real hardware
      // leaves a transfer pending until bytes arrive.
      return new Promise((resolve, reject) => {
        outstanding.push({ resolve, reject });
      });
    },
    transferOut: async () => ({ status: "ok" }),
  };
  // Answer the oldest unanswered transfer — bulk transfers on one endpoint
  // complete in the order they were issued.
  const deliver = (result) => {
    outstanding.shift()?.resolve(result);
  };
  return { device, controlIn, controlOut, transferInCalls, clearHaltCalls, deliver };
}

// Let the stream's pull run: it is invoked off a microtask and awaits transfers.
function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

const HX_DESCRIPTOR = { usbVersion: 0x110, deviceClass: 0, maxPacketSize0: 64, deviceVersion: 0x400 };
const HXN_DESCRIPTOR = { usbVersion: 0x200, deviceClass: 0, maxPacketSize0: 64, deviceVersion: 0x100 };

test("isProlificDevice recognizes the Prolific vendor id", () => {
  assert.equal(PROLIFIC_VENDOR_ID, 0x067b);
  assert.ok(isProlificDevice({ vendorId: 0x067b, productId: 0x2303 }));
  assert.ok(!isProlificDevice({ vendorId: 0x0403, productId: 0x6015 })); // FTDI
  assert.ok(!isProlificDevice(null));
});

test("pickPl2303BaudRate returns exact standard rates and rejects nonsense", () => {
  assert.equal(pickPl2303BaudRate(9600), 9600);
  assert.equal(pickPl2303BaudRate(115200), 115200);
  assert.equal(pickPl2303BaudRate(9500), 9600); // nearest supported
  assert.throws(() => pickPl2303BaudRate(0), /Invalid PL2303 baud rate/);
});

test("detectPl2303Type follows the usb-serial-for-android ladder", () => {
  // CDC device class or 8-byte EP0 -> original chips.
  assert.equal(detectPl2303Type({ deviceClass: 0x02, maxPacketSize0: 64, usbVersion: 0x110, deviceVersion: 0x300, hxStatus: true }), PL2303_TYPE_01);
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 8, usbVersion: 0x110, deviceVersion: 0x300, hxStatus: true }), PL2303_TYPE_01);
  // TA: bcdDevice 3.00 on USB 2.0; TB: bcdDevice 5.00.
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 64, usbVersion: 0x200, deviceVersion: 0x300, hxStatus: true }), PL2303_TYPE_T);
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 64, usbVersion: 0x200, deviceVersion: 0x500, hxStatus: true }), PL2303_TYPE_T);
  // USB 2.0 chip that rejects the legacy register -> HXN family.
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 64, usbVersion: 0x200, deviceVersion: 0x100, hxStatus: false }), PL2303_TYPE_HXN);
  // USB 1.1 -> classic HX.
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 64, usbVersion: 0x110, deviceVersion: 0x400, hxStatus: true }), PL2303_TYPE_HX);
});

test("HX open() runs the legacy startup with kernel-correct request types", async () => {
  const { device, controlOut } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.equal(port.chipType, PL2303_TYPE_HX);
  // Vendor writes must be requestType "vendor" with legacy bRequest 0x01
  // (tidepool/emcee send these as "class", diverging from the kernel).
  const vendorWrites = controlOut.filter((t) => t.requestType === "vendor");
  assert.ok(vendorWrites.length >= 6, "legacy startup must issue vendor writes");
  for (const t of vendorWrites) {
    assert.equal(t.request, 0x01, "non-HXN vendor writes use bRequest 0x01");
    assert.equal(t.recipient, "device");
  }
  // The startup dance ends with register 2 = 0x44 for non-01 chips.
  assert.ok(vendorWrites.some((t) => t.value === 2 && t.index === 0x44));
  // Legacy purge: registers 8 and 9.
  assert.ok(vendorWrites.some((t) => t.value === 8 && t.index === 0));
  assert.ok(vendorWrites.some((t) => t.value === 9 && t.index === 0));
  // Line coding: class/interface SET_LINE (0x20), 7 bytes, 9600 LE32 + 8N1.
  const setLine = controlOut.find((t) => t.requestType === "class" && t.request === 0x20);
  assert.ok(setLine, "line coding must be written");
  assert.deepEqual(Array.from(setLine.data), [0x80, 0x25, 0x00, 0x00, 0, 0, 8]);
  // Bulk endpoints selected, interrupt endpoint skipped.
  assert.equal(port._inEndpoint, 3);
  assert.equal(port._outEndpoint, 2);
});

test("Pl2303SerialPort.open() reports the actual interface when a bulk endpoint is missing", async () => {
  const { device, controlIn, controlOut } = makeFakeDevice({
    descriptor: HX_DESCRIPTOR,
    endpoints: [
      { type: "interrupt", direction: "in", endpointNumber: 1, packetSize: 10 },
      { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
    ],
    interfaceNumber: 7,
  });
  const port = new Pl2303SerialPort(device);

  await assert.rejects(
    port.open({ baudRate: 9600 }),
    /PL2303: bulk IN\/OUT endpoints not found on interface 7/,
  );
  assert.deepEqual(controlIn, [], "endpoint validation must happen before PL2303 probing");
  assert.deepEqual(controlOut, [], "endpoint validation must happen before PL2303 initialization");
});

test("HXN open() skips the legacy startup and uses HXN registers", async () => {
  const { device, controlOut } = makeFakeDevice({
    descriptor: HXN_DESCRIPTOR,
    hxProbeSucceeds: false,
  });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.equal(port.chipType, PL2303_TYPE_HXN);
  const vendorWrites = controlOut.filter((t) => t.requestType === "vendor");
  // No legacy 0x0404 startup writes on HXN silicon.
  assert.ok(!vendorWrites.some((t) => t.value === 0x0404), "HXN must skip legacy startup");
  // All HXN vendor writes use bRequest 0x80.
  for (const t of vendorWrites) {
    assert.equal(t.request, 0x80, "HXN vendor writes use bRequest 0x80");
  }
  // HXN purge: request 0x07 with both pipe bits; HXN flow-control register.
  assert.ok(vendorWrites.some((t) => t.value === 0x07 && t.index === 0x03));
  assert.ok(vendorWrites.some((t) => t.value === 0x0a && t.index === 0xff));
});

test("setSignals sets absolute DTR|RTS value while preserving cached lines", async () => {
  const { device, controlOut } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 9600 });
  controlOut.length = 0;

  await port.setSignals({ dataTerminalReady: true });
  await port.setSignals({ requestToSend: true }); // must keep DTR set
  await port.setSignals({ dataTerminalReady: false }); // must keep RTS set
  await port.setSignals({ requestToSend: true }); // no change -> no transfer

  const controls = controlOut.filter((t) => t.request === 0x22);
  assert.deepEqual(controls.map((t) => t.value), [0x01, 0x03, 0x02]);
  for (const t of controls) {
    assert.equal(t.requestType, "class");
    assert.equal(t.recipient, "interface");
  }
});

test("read path passes bulk payload through unmodified (no status header)", async () => {
  const { device } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const packets = [
    { status: "ok", data: new DataView(new Uint8Array([0x50, 0xbb, 0xff]).buffer) },
  ];
  device.transferIn = async () => packets.shift() ?? new Promise(() => {});
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 9600 });

  const reader = port.readable.getReader();
  const { value } = await reader.read();
  // Unlike FTDI, PL2303 payload has no 2-byte status prefix to strip.
  assert.deepEqual(Array.from(value), [0x50, 0xbb, 0xff]);
});

test("WebUSB provider dispatches Prolific devices to the PL2303 driver", async () => {
  let requestedOptions = null;
  setNavigator({
    usb: {
      requestDevice: async (options) => {
        requestedOptions = options;
        return { vendorId: 0x067b, productId: 0x2303 };
      },
    },
  });
  const serial = createWebUsbSerial({
    loadCdcSerialPort: async () => {
      throw new Error("CDC polyfill should not load for PL2303 devices");
    },
  });
  const port = await serial.requestPort();
  assert.ok(port instanceof Pl2303SerialPort);
  assert.ok(
    requestedOptions?.filters?.some((f) => f.vendorId === PROLIFIC_VENDOR_ID),
    "requestDevice must be called with a Prolific vendor filter",
  );
});

test("Pl2303SerialPort keeps a full pipeline of bulk IN transfers queued", async () => {
  // With a single transfer outstanding the host has no IN request queued
  // between one completing and the next being issued, and the chip's RX FIFO
  // overruns in that gap. The 64-byte endpoint gives twice the CH340's slack,
  // so it only shows on sustained transfers — measured on a Pixel 10, the
  // loopback suite's 16 KB echo at 115200 lost bytes on 3 of 10 runs with one
  // transfer in flight, and none of 12 once queued.
  //
  // Both halves of that fix are pinned by the call count. No reader is
  // attached, so the only thing driving further pulls is the stream's own
  // high-water mark: 16 transfers are queued up front, and each of the 15 pulls
  // after the first replenishes exactly one. A shallower depth, or the default
  // queue of one, yields a smaller number.
  const { device, deliver, transferInCalls } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 115200 });
  // The stream pulls as soon as it is constructed, which primes the queue.
  await tick();

  assert.equal(transferInCalls.length, 16, "the queue must be primed to full depth");

  for (let i = 0; i < 16; i += 1) {
    deliver({ status: "ok", data: new DataView(new Uint8Array([i]).buffer) });
    await tick();
  }

  assert.equal(
    transferInCalls.length,
    31,
    "16 queued up front plus one replenished per pull, with no reader attached",
  );
});

test("Pl2303SerialPort read path recovers when clearHalt cancels the queue", async () => {
  // The halt is cleared with a queue of transfers still outstanding, and
  // clearHalt() cancels every one of them. Chromium reports a cancellation as a
  // rejected promise (AbortError), not as a result carrying a status, so a read
  // path that keeps the pre-stall queue awaits a cancelled transfer on its next
  // turn and errors the stream for good.
  const { device, clearHaltCalls, deliver } = makeFakeDevice({
    descriptor: HX_DESCRIPTOR,
    cancelOnClearHalt: true,
  });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const read = reader.read();
  await tick();

  deliver({ status: "stall" });
  await tick();

  // Empty packets must not resolve the pull either (that wedges reads).
  deliver({ status: "ok", data: new DataView(new Uint8Array([]).buffer) });
  await tick();
  deliver({ status: "ok", data: new DataView(new Uint8Array([0x50, 0xbb, 0xff]).buffer) });

  const { value } = await read;
  assert.deepEqual(clearHaltCalls, [{ direction: "in", endpoint: 3 }]);
  assert.deepEqual(Array.from(value), [0x50, 0xbb, 0xff]);
});

test("Pl2303SerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // Throughput comes from queue depth, not from asking for more bytes per
  // transfer: a request spanning packets can only end on a short packet or an
  // exact fill, which is what strands replies outright on the CH340.
  const { device, transferInCalls } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 115200 });
  await tick();

  assert.ok(transferInCalls.length > 0, "expected the read path to queue a transfer");
  for (const call of transferInCalls) {
    assert.equal(call.endpointNumber, 3);
    assert.equal(call.length, 64, "bulk IN transfers must request exactly one packet");
  }
});

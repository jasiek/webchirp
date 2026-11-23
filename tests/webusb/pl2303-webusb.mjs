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
  pl2303LineCoding,
} from "../../web/js/pl2303-webusb.ts";
import { createWebUsbSerial } from "../../web/js/webusb-serial.ts";
import {
  PL2303_HXN_DESCRIPTOR,
  PL2303_HX_DESCRIPTOR,
  bytesOf,
  deviceDescriptorBytes,
  makeFakeUsbDevice,
} from "../support/fake-usb.mjs";
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
  const fake = makeFakeUsbDevice({
    vendorId: 0x067b,
    productId: 0x2303,
    endpoints,
    interfaceNumber,
    cancelOnClearHalt,
    controlTransferIn: async (setup, length) => {
      controlIn.push({ ...setup, length });
      if (setup.requestType === "standard" && setup.request === 0x06) {
        return { status: "ok", data: new DataView(deviceDescriptorBytes(descriptor).buffer) };
      }
      // HXN silicon stalls every legacy vendor read (bRequest 0x01). WebUSB
      // reports a STALL by resolving with status "stall", not by rejecting.
      if (setup.requestType === "vendor" && setup.request === 0x01 && !hxProbeSucceeds) {
        return { status: "stall", data: new DataView(new ArrayBuffer(0)) };
      }
      if (setup.requestType === "vendor" && setup.value === 0x8080) {
        return { status: "ok", data: new DataView(new Uint8Array([0]).buffer) };
      }
      return { status: "ok", data: new DataView(new Uint8Array(length || 1).buffer) };
    },
    controlTransferOut: async (setup, data) => {
      controlOut.push({ ...setup, data: bytesOf(data) });
      return { status: "ok" };
    },
  });
  return { ...fake, controlIn, controlOut };
}

const HX_DESCRIPTOR = PL2303_HX_DESCRIPTOR;
const HXN_DESCRIPTOR = PL2303_HXN_DESCRIPTOR;

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
  // GT shares TA's bcdDevice 3.00 and GE shares TB's 5.00: the probe decides.
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 64, usbVersion: 0x200, deviceVersion: 0x300, hxStatus: false }), PL2303_TYPE_HXN);
  assert.equal(detectPl2303Type({ deviceClass: 0, maxPacketSize0: 64, usbVersion: 0x200, deviceVersion: 0x500, hxStatus: false }), PL2303_TYPE_HXN);
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

test("pl2303LineCoding lays out the frame as the kernel's pl2303_set_termios does", () => {
  // LE32 baud, then stop bits (0 = 1, 2 = 2), parity (1 odd, 2 even), data bits.
  const bytes = (framing) => Array.from(new Uint8Array(pl2303LineCoding(9600, framing).buffer));
  assert.deepEqual(bytes({ dataBits: 8, parity: "none", stopBits: 1 }), [0x80, 0x25, 0, 0, 0, 0, 8]);
  assert.deepEqual(bytes({ dataBits: 8, parity: "even", stopBits: 1 }), [0x80, 0x25, 0, 0, 0, 2, 8]);
  assert.deepEqual(bytes({ dataBits: 7, parity: "even", stopBits: 1 }), [0x80, 0x25, 0, 0, 0, 2, 7]);
  assert.deepEqual(bytes({ dataBits: 8, parity: "none", stopBits: 2 }), [0x80, 0x25, 0, 0, 2, 0, 8]);
  assert.deepEqual(bytes({ dataBits: 8, parity: "odd", stopBits: 1 }), [0x80, 0x25, 0, 0, 0, 1, 8]);
});

for (const [chip, descriptor, hxProbeSucceeds] of [
  ["HX", HX_DESCRIPTOR, true],
  ["HXN", HXN_DESCRIPTOR, false],
]) {
  for (const [label, options, frameBytes] of [
    ["8E1", { dataBits: 8, parity: "even", stopBits: 1 }, [0, 2, 8]],
    ["7E1", { dataBits: 7, parity: "even", stopBits: 1 }, [0, 2, 7]],
    ["8N2", { dataBits: 8, parity: "none", stopBits: 2 }, [2, 0, 8]],
  ]) {
    test(`${chip} open() programs ${label} in the line coding block`, async () => {
      // Every chip generation takes its frame in the same class request, so
      // the frame open() is asked for has to be the one written there.
      const { device, controlOut } = makeFakeDevice({ descriptor, hxProbeSucceeds });
      const port = new Pl2303SerialPort(device);
      await port.open({ baudRate: 9600, ...options });

      const setLine = controlOut.filter((t) => t.requestType === "class" && t.request === 0x20);
      assert.equal(setLine.length, 1);
      assert.equal(setLine[0].recipient, "interface");
      assert.deepEqual(setLine[0].data, [0x80, 0x25, 0x00, 0x00, ...frameBytes]);
    });
  }
}

test("Pl2303SerialPort.open() refuses a frame it cannot program before touching the chip", async () => {
  const { device, controlIn, controlOut } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const port = new Pl2303SerialPort(device);

  await assert.rejects(
    port.open({ baudRate: 9600, dataBits: 6 }),
    /PL2303: cannot program 6 data bits/,
  );
  assert.deepEqual(controlIn, []);
  assert.deepEqual(controlOut, []);
});

test("Pl2303SerialPort declares framing, since open() programs it", () => {
  const { device } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  assert.equal(new Pl2303SerialPort(device).capabilities.framing, true);
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

// bcdDevice 3.00 is TA or GT and 5.00 is TB or GE on USB 2.0; only the legacy
// 0x8080 probe tells them apart, as the kernel's pl2303_detect_type() does.
for (const [chip, deviceVersion, hxProbeSucceeds, expected] of [
  ["TA", 0x300, true, PL2303_TYPE_T],
  ["GT", 0x300, false, PL2303_TYPE_HXN],
  ["TB", 0x500, true, PL2303_TYPE_T],
  ["GE", 0x500, false, PL2303_TYPE_HXN],
]) {
  test(`${chip} (bcdDevice 0x${deviceVersion.toString(16)}) open() probes the legacy register to pick its chip type`, async () => {
    const { device, controlIn } = makeFakeDevice({
      descriptor: { ...HXN_DESCRIPTOR, deviceVersion },
      hxProbeSucceeds,
    });
    const port = new Pl2303SerialPort(device);
    await port.open({ baudRate: 9600 });

    assert.ok(controlIn.some((t) => t.requestType === "vendor" && t.value === 0x8080), "must probe 0x8080");
    assert.equal(port.chipType, expected);
  });
}

for (const [chip, descriptor, hxProbeSucceeds] of [
  ["HX", HX_DESCRIPTOR, true],
  ["HXN", HXN_DESCRIPTOR, false],
]) {
  test(`${chip} open() deasserts DTR and RTS on the chip`, async () => {
    // A new port object starts with a shadow of 0, but close() never touches
    // the lines, so the chip can still hold DTR or RTS from an earlier
    // session: open() has to write them rather than trust the shadow.
    const { device, controlOut } = makeFakeDevice({ descriptor, hxProbeSucceeds });
    const port = new Pl2303SerialPort(device);
    await port.open({ baudRate: 9600 });

    const controls = controlOut.filter((t) => t.request === 0x22);
    assert.deepEqual(controls.map((t) => t.value), [0]);
    assert.equal(controls[0].requestType, "class");
    assert.equal(controls[0].recipient, "interface");
  });
}

test("reopening a port deasserts the lines the last session asserted", async () => {
  const { device, controlOut } = makeFakeDevice({ descriptor: HX_DESCRIPTOR });
  const port = new Pl2303SerialPort(device);
  await port.open({ baudRate: 9600 });
  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  await port.close();
  controlOut.length = 0;

  await port.open({ baudRate: 9600 });
  // With the shadow back at 0, asserting DTR again must reach the chip.
  await port.setSignals({ dataTerminalReady: true });

  const controls = controlOut.filter((t) => t.request === 0x22);
  assert.deepEqual(controls.map((t) => t.value), [0, 0x01]);
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

test("WebUSB provider dispatches Prolific devices to the PL2303 driver", async (t) => {
  let requestedOptions = null;
  withNavigator(t, {
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
  await expectFullPipeline({
    Port: Pl2303SerialPort,
    fake: makeFakeDevice({ descriptor: HX_DESCRIPTOR }),
  });
});

test("Pl2303SerialPort read path recovers when clearHalt cancels the queue", async () => {
  // The halt is cleared with a queue of transfers still outstanding, and
  // clearHalt() cancels every one of them. Chromium reports a cancellation as a
  // rejected promise (AbortError), not as a result carrying a status, so a read
  // path that keeps the pre-stall queue awaits a cancelled transfer on its next
  // turn and errors the stream for good.
  //
  // Empty packets must not resolve the pull either (that wedges reads).
  await expectStallRecovery({
    Port: Pl2303SerialPort,
    fake: makeFakeDevice({ descriptor: HX_DESCRIPTOR, cancelOnClearHalt: true }),
    endpointNumber: 3,
    payload: [0x50, 0xbb, 0xff],
  });
});

test("Pl2303SerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // Throughput comes from queue depth, not from asking for more bytes per
  // transfer: a request spanning packets can only end on a short packet or an
  // exact fill, which is what strands replies outright on the CH340.
  await expectOnePacketPerTransfer({
    Port: Pl2303SerialPort,
    fake: makeFakeDevice({ descriptor: HX_DESCRIPTOR }),
    endpointNumber: 3,
    packetSize: 64,
  });
});

test("Pl2303SerialPort write path reports a stalled bulk OUT instead of losing bytes", async () => {
  // WebUSB resolves a failed bulk OUT with a status rather than rejecting, so a
  // write path that ignores the result reports success on a protocol block that
  // went nowhere: an upload truncated silently, surfacing later as a read
  // timeout, with the endpoint left halted for every retry.
  await expectStalledWriteFails({
    Port: Pl2303SerialPort,
    fake: makeFakeDevice({ descriptor: HX_DESCRIPTOR }),
    chip: "PL2303",
    endpointNumber: 2,
  });
});

test("Pl2303SerialPort write path resumes a short bulk OUT transfer", async () => {
  // bytesWritten can be less than the chunk; assuming a partial write was a
  // whole one drops the tail of a frame silently.
  await expectShortWriteResumed({
    Port: Pl2303SerialPort,
    fake: makeFakeDevice({ descriptor: HX_DESCRIPTOR }),
    endpointNumber: 2,
  });
});

test("Pl2303SerialPort write path gives up on a transfer that never progresses", async () => {
  await expectStuckWriteFails({
    Port: Pl2303SerialPort,
    fake: makeFakeDevice({ descriptor: HX_DESCRIPTOR }),
    chip: "PL2303",
  });
});

for (const [chip, descriptor, hxProbeSucceeds, request, register, bits] of [
  // usb-serial-for-android's GET_CONTROL_REQUEST / GET_CONTROL_HXN_REQUEST maps.
  ["HX", HX_DESCRIPTOR, true, 0x01, 0x87, { cts: 0x08, dsr: 0x04, dcd: 0x02, ri: 0x01 }],
  ["HXN", HXN_DESCRIPTOR, false, 0x81, 0x80, { cts: 0x08, dsr: 0x20, dcd: 0x40, ri: 0x80 }],
]) {
  test(`${chip} getSignals reads the active-low control-line register`, async () => {
    const { device, controlIn } = makeFakeDevice({ descriptor, hxProbeSucceeds });
    let asserted = bits.cts | bits.ri;
    const answer = device.controlTransferIn;
    device.controlTransferIn = async (setup, length) => {
      if (setup.requestType === "vendor" && setup.value === register) {
        controlIn.push({ ...setup, length });
        return { status: "ok", data: new DataView(new Uint8Array([~asserted & 0xff]).buffer) };
      }
      return answer(setup, length);
    };
    const port = new Pl2303SerialPort(device);
    await port.open({ baudRate: 9600 });
    controlIn.length = 0;

    assert.deepEqual(await port.getSignals(), {
      clearToSend: true,
      dataSetReady: false,
      dataCarrierDetect: false,
      ringIndicator: true,
    });
    assert.deepEqual(controlIn, [
      { requestType: "vendor", recipient: "device", request, value: register, index: 0, length: 1 },
    ]);

    asserted = bits.dsr | bits.dcd;
    assert.deepEqual(await port.getSignals(), {
      clearToSend: false,
      dataSetReady: true,
      dataCarrierDetect: true,
      ringIndicator: false,
    });
  });
}

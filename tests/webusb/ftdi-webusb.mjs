import assert from "node:assert/strict";
import test from "node:test";
import { FtdiSerialPort } from "../../web/js/ftdi-webusb.js";
import { makeFakeUsbDevice, okTransfer } from "../support/fake-usb.mjs";
import { tick } from "../support/globals.mjs";
import {
  expectFullPipeline,
  expectOnePacketPerTransfer,
  expectStallRecovery,
} from "../support/usb-read-path.mjs";

// A fake FTDI USBDevice: a bulk pair (plus whatever endpoints the test adds),
// recording every control write, with bulk IN packets framed the way this
// chip frames them.
function makeFakeDevice({
  cancelOnClearHalt = false,
  endpoints = [
    { type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 },
    { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
  ],
  interfaceNumber = 0,
} = {}) {
  const controlCalls = [];
  const transferOutCalls = [];
  const fake = makeFakeUsbDevice({
    vendorId: 0x0403,
    productId: 0x6001,
    endpoints,
    interfaceNumber,
    cancelOnClearHalt,
    controlTransferOut: async ({ request, value, index }) => {
      controlCalls.push({ request, value, index });
      return { status: "ok" };
    },
    transferOut: async (endpointNumber, data) => {
      transferOutCalls.push({ endpointNumber, data });
      return { status: "ok" };
    },
  });
  // A bulk IN packet as this chip actually sends it: two modem/line status
  // bytes, then whatever payload the wire delivered.
  const deliverPacket = (payload = []) => {
    fake.deliver(okTransfer([0x01, 0x60, ...payload]));
  };

  return { ...fake, controlCalls, transferOutCalls, deliverPacket };
}

test("FtdiSerialPort.open() purges FIFOs and sets the latency timer", async () => {
  const { device, controlCalls } = makeFakeDevice();
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });

  // Init sequence faithful to native drivers: reset, purge RX, purge TX,
  // baud, framing, flow control, latency timer.
  assert.deepEqual(controlCalls, [
    { request: 0x00, value: 0x0000, index: 1 }, // SIO_RESET
    { request: 0x00, value: 0x0001, index: 1 }, // purge RX FIFO
    { request: 0x00, value: 0x0002, index: 1 }, // purge TX FIFO
    { request: 0x03, value: 0x4138, index: 0 }, // 9600 baud divisor
    { request: 0x04, value: 0x0008, index: 1 }, // 8N1
    { request: 0x02, value: 0x0000, index: 1 }, // no flow control
    { request: 0x09, value: 4, index: 1 }, // latency timer 4 ms
  ]);
  assert.ok(port.readable, "readable stream must be set up");
  assert.ok(port.writable, "writable stream must be set up");
});

test("FtdiSerialPort.open() ignores interrupt endpoints when selecting bulk data", async () => {
  const { device } = makeFakeDevice({
    endpoints: [
      { type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 },
      { type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 },
      // Keep this last: the old direction-only loop overwrote bulk IN with it.
      { type: "interrupt", direction: "in", endpointNumber: 3, packetSize: 8 },
    ],
  });
  const port = new FtdiSerialPort(device);

  await port.open({ baudRate: 9600 });

  assert.equal(port._inEndpoint, 1);
  assert.equal(port._outEndpoint, 2);
  assert.equal(port.packetSize, 64);
});

for (const [missingDirection, endpoints] of [
  ["IN", [{ type: "bulk", direction: "out", endpointNumber: 2, packetSize: 64 }]],
  ["OUT", [{ type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 }]],
]) {
  test(`FtdiSerialPort.open() rejects a missing bulk ${missingDirection} endpoint`, async () => {
    const { device, controlCalls } = makeFakeDevice({ endpoints, interfaceNumber: 7 });
    const port = new FtdiSerialPort(device);

    await assert.rejects(
      port.open({ baudRate: 9600 }),
      /FTDI: bulk IN\/OUT endpoints not found on interface 7/,
    );
    assert.deepEqual(controlCalls, [], "endpoint validation must happen before FTDI initialization");
  });
}

test("FtdiSerialPort read path survives status-only packets (the Android wedge)", async () => {
  // Regression for a read-path deadlock observed on Android (exactly two
  // bulk IN transfers completed, then silence forever): a stream pull that
  // resolved without enqueuing after a status-only packet was never
  // re-invoked, wedging all reads. An idle chip sends one such packet every
  // latency tick, so the pull must keep polling through them and resolve only
  // once real payload arrives — which is what awaiting this read() proves.
  const { device, deliverPacket } = makeFakeDevice();
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const read = reader.read();
  await tick();

  deliverPacket();
  await tick();
  deliverPacket();
  await tick();
  deliverPacket();
  await tick();
  deliverPacket([0x50, 0xbb]);

  const { value } = await read;
  assert.deepEqual(Array.from(value), [0x50, 0xbb]);
});

test("FtdiSerialPort read path recovers when clearHalt cancels the queue", async () => {
  // The halt is cleared with a queue of transfers still outstanding, and
  // clearHalt() cancels every one of them. Chromium reports a cancellation as a
  // rejected promise (AbortError), not as a result carrying a status, so a read
  // path that keeps the pre-stall queue awaits a cancelled transfer on its next
  // turn and errors the stream for good.
  //
  // Status-only packets must not resolve the pull either (that wedges reads).
  const fake = makeFakeDevice({ cancelOnClearHalt: true });
  await expectStallRecovery({
    Port: FtdiSerialPort,
    fake,
    endpointNumber: 1,
    payload: [0xab],
    sendPayload: fake.deliverPacket,
    sendEmpty: () => fake.deliverPacket(),
  });
});

test("FtdiSerialPort keeps a full pipeline of bulk IN transfers queued", async () => {
  // One transfer in flight leaves the endpoint unqueued for the whole round
  // trip between a transfer completing and the next being issued, and the
  // chip's RX FIFO overruns in that gap — silently, status "ok" and no error
  // anywhere. The CH340 and PL2303 drivers carry the same pipeline for the
  // same reason.
  //
  // Both halves of that fix are load-bearing and both are pinned here by the
  // call count. No reader is attached, so the only thing driving further pulls
  // is the stream's own high-water mark: 16 transfers are queued up front, and
  // each of the 15 pulls after the first replenishes exactly one. A shallower
  // depth, or the default queue of one, yields a smaller number.
  const fake = makeFakeDevice();
  await expectFullPipeline({ Port: FtdiSerialPort, fake, sendPayload: fake.deliverPacket });
});

test("FtdiSerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // This chip repeats its two status bytes at the head of every packet, so a
  // request spanning packets comes back with headers buried mid-buffer and
  // stripFtdiStatusBytes would pass all but the first pair off as payload.
  // Throughput has to come from queue depth, not from asking for more bytes.
  await expectOnePacketPerTransfer({
    Port: FtdiSerialPort,
    fake: makeFakeDevice(),
    endpointNumber: 1,
    packetSize: 64,
  });
});

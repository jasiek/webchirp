import assert from "node:assert/strict";
import test from "node:test";
import { FtdiSerialPort } from "../web/js/ftdi-webusb.js";

// A fake FTDI USBDevice whose bulk IN transfers stay pending until the test
// answers them, the way real hardware leaves a transfer outstanding until bytes
// arrive. A driver that keeps a queue is only observable against a fake that
// models the queue, so this cannot be a list of pre-baked results.
function makeFakeDevice({ cancelOnClearHalt = false } = {}) {
  const controlCalls = [];
  const clearHaltCalls = [];
  const transferInCalls = [];
  const transferOutCalls = [];
  const outstanding = [];

  const device = {
    vendorId: 0x0403,
    productId: 0x6001,
    configuration: {
      interfaces: [
        {
          interfaceNumber: 0,
          alternate: {
            endpoints: [
              { direction: "in", endpointNumber: 1, packetSize: 64 },
              { direction: "out", endpointNumber: 2, packetSize: 64 },
            ],
          },
        },
      ],
    },
    open: async () => {},
    claimInterface: async () => {},
    releaseInterface: async () => {},
    close: async () => {},
    controlTransferOut: async ({ request, value, index }) => {
      controlCalls.push({ request, value, index });
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
      return new Promise((resolve, reject) => {
        outstanding.push({ resolve, reject });
      });
    },
    transferOut: async (endpointNumber, data) => {
      transferOutCalls.push({ endpointNumber, data });
      return { status: "ok" };
    },
  };

  // Answer the oldest unanswered transfer — bulk transfers on one endpoint
  // complete in the order they were issued.
  const deliver = (result) => {
    outstanding.shift()?.resolve(result);
  };
  // A bulk IN packet as this chip actually sends it: two modem/line status
  // bytes, then whatever payload the wire delivered.
  const deliverPacket = (payload = []) => {
    deliver({
      status: "ok",
      data: new DataView(new Uint8Array([0x01, 0x60, ...payload]).buffer),
    });
  };

  return { device, controlCalls, clearHaltCalls, transferInCalls, transferOutCalls, deliver, deliverPacket };
}

// Let the stream's pull run between deliveries.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  const { device, clearHaltCalls, deliver, deliverPacket } = makeFakeDevice({ cancelOnClearHalt: true });
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const read = reader.read();
  await tick();

  deliver({ status: "stall" });
  await tick();

  // Status-only packets must not resolve the pull either (that wedges reads).
  deliverPacket();
  await tick();
  deliverPacket([0xab]);

  const { value } = await read;
  assert.deepEqual(clearHaltCalls, [{ direction: "in", endpoint: 1 }]);
  assert.deepEqual(Array.from(value), [0xab]);
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
  const { device, deliverPacket, transferInCalls } = makeFakeDevice();
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 115200 });
  // The stream pulls as soon as it is constructed, which primes the queue.
  await tick();

  assert.equal(transferInCalls.length, 16, "the queue must be primed to full depth");

  for (let i = 0; i < 16; i += 1) {
    deliverPacket([i]);
    await tick();
  }

  assert.equal(
    transferInCalls.length,
    31,
    "16 queued up front plus one replenished per pull, with no reader attached",
  );
});

test("FtdiSerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // This chip repeats its two status bytes at the head of every packet, so a
  // request spanning packets comes back with headers buried mid-buffer and
  // stripFtdiStatusBytes would pass all but the first pair off as payload.
  // Throughput has to come from queue depth, not from asking for more bytes.
  const { device, transferInCalls } = makeFakeDevice();
  const port = new FtdiSerialPort(device);
  await port.open({ baudRate: 115200 });
  await tick();

  assert.ok(transferInCalls.length > 0, "expected the read path to queue a transfer");
  for (const call of transferInCalls) {
    assert.equal(call.endpointNumber, 1);
    assert.equal(call.length, 64, "bulk IN transfers must request exactly one packet");
  }
});

// The bulk IN read-path checks every WebUSB chip driver has to pass. The four
// drivers share one read-path design (a deep transfer queue, one packet per
// transfer, retire the queue before clearing a halt), so the bodies are
// identical; each chip's test file keeps its own test name and the prose
// explaining why that chip needs the behaviour, and calls in here for the
// mechanics.
//
// Every helper takes the driver class and a fake built by the chip file's own
// makeFakeDevice (so the chip's control-transfer answers stay with the chip)
// and, where the chip frames its packets, the functions that put a payload or
// an empty packet on the fake's bulk IN endpoint. The defaults suit chips
// whose packets are raw payload.
import assert from "node:assert/strict";
import { okTransfer } from "./fake-usb.mjs";
import { tick } from "./globals.mjs";

// The default way to answer a bulk IN transfer with the given payload bytes.
function rawPayloadSender(fake) {
  return (bytes) => fake.deliver(okTransfer(bytes));
}

// Open the port and prime its read queue: the stream pulls as soon as it is
// constructed, and the pull runs off a macrotask.
async function openPrimed(Port, fake, baudRate) {
  const port = new Port(fake.device);
  await port.open({ baudRate });
  await tick();
  return port;
}

// With no reader attached, the only thing driving pulls is the stream's own
// high-water mark: 16 transfers are queued up front, and each of the 15 pulls
// after the first replenishes exactly one. A shallower depth, or the default
// queue of one, yields a smaller number — so the call count pins both halves.
export async function expectFullPipeline({
  Port,
  fake,
  sendPayload = rawPayloadSender(fake),
}) {
  const { transferInCalls } = fake;
  await openPrimed(Port, fake, 115200);

  assert.equal(transferInCalls.length, 16, "the queue must be primed to full depth");

  for (let i = 0; i < 16; i += 1) {
    sendPayload([i]);
    await tick();
  }

  assert.equal(
    transferInCalls.length,
    31,
    "16 queued up front plus one replenished per pull, with no reader attached",
  );
}

// Every queued transfer must go to the bulk IN endpoint and ask for exactly
// one packet: throughput comes from queue depth, not from asking for more
// bytes per transfer.
export async function expectOnePacketPerTransfer({ Port, fake, endpointNumber, packetSize }) {
  const { transferInCalls } = fake;
  await openPrimed(Port, fake, 115200);

  assert.ok(transferInCalls.length > 0, "expected the read path to queue a transfer");
  for (const call of transferInCalls) {
    assert.equal(call.endpointNumber, endpointNumber);
    assert.equal(call.length, packetSize, "bulk IN transfers must request exactly one packet");
  }
}

// A stall is cleared with a queue of transfers still outstanding, and the
// fake's clearHalt cancels every one of them (build it with
// cancelOnClearHalt: true). Chromium reports a cancellation as a rejected
// promise (AbortError), not as a result carrying a status, so a read path that
// keeps the pre-stall queue awaits a cancelled transfer on its next turn and
// errors the stream for good. After the halt, a packet with no payload must
// not resolve the pull either (that wedges reads); only `payload` may.
export async function expectStallRecovery({
  Port,
  fake,
  endpointNumber,
  payload,
  sendPayload = rawPayloadSender(fake),
  sendEmpty = () => sendPayload([]),
}) {
  const { clearHaltCalls, deliver } = fake;
  const port = new Port(fake.device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const read = reader.read();
  await tick();

  deliver({ status: "stall" });
  await tick();

  sendEmpty();
  await tick();
  sendPayload(payload);

  const { value } = await read;
  assert.deepEqual(clearHaltCalls, [{ direction: "in", endpoint: endpointNumber }]);
  assert.deepEqual(Array.from(value), payload);
}

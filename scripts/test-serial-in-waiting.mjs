import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserSerialBridge } from "../web/js/serial.js";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

// in_waiting is the one pyserial call a driver can be *silently* wrong about:
// the shim used to answer a hardcoded 0, and a driver that only reads when
// in_waiting is non-zero then reads nothing at all for its whole deadline.
// anytone778uv.send_serial_command() is exactly that shape and runs seven
// times on the clone path, so eight catalog entries could not clone. These
// tests pin both halves: the bridge reports the real buffered count, and the
// Python shim exposes it under both the modern and the legacy spelling.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The JS half: BrowserSerialBridge.inWaiting()
// ---------------------------------------------------------------------------

// A Web Serial-shaped port whose reader delivers exactly the chunks the test
// pushes, so a test can place bytes on the line at a chosen moment rather than
// racing a real device.
function makeFeedablePort() {
  const pending = [];
  let deliver = null;
  let closed = false;

  function push(bytes) {
    const value = Uint8Array.from(bytes);
    if (deliver) {
      const resolve = deliver;
      deliver = null;
      resolve({ value, done: false });
      return;
    }
    pending.push(value);
  }

  const port = {
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6015 }),
    async open() {},
    async close() {
      closed = true;
    },
    readable: {
      getReader: () => ({
        read() {
          if (pending.length) {
            return Promise.resolve({ value: pending.shift(), done: false });
          }
          if (closed) {
            return Promise.resolve({ done: true });
          }
          return new Promise((resolve) => {
            deliver = resolve;
          });
        },
        async cancel() {
          closed = true;
          deliver?.({ done: true });
          deliver = null;
        },
        releaseLock() {},
      }),
    },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  return { port, push };
}

// The bridge reaches its transport through navigator, so these tests have to
// stand one in. Pyodide boots off the real navigator later in this file, so
// every substitution is undone as its test ends.
const REAL_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, "navigator");

async function openFedBridge(t) {
  const { port, push } = makeFeedablePort();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serial: { requestPort: async () => port, addEventListener() {}, removeEventListener() {} } },
  });
  t.after(() => {
    if (REAL_NAVIGATOR) {
      Object.defineProperty(globalThis, "navigator", REAL_NAVIGATOR);
    } else {
      delete globalThis.navigator;
    }
  });
  const bridge = new BrowserSerialBridge();
  await bridge.open(9600);
  return { bridge, push };
}

test("inWaiting reports the bridge's real buffered byte count", async (t) => {
  const { bridge, push } = await openFedBridge(t);

  assert.deepEqual(await bridge.inWaiting(0), { available: 0 });

  push([0x51, 0x58, 0x06]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await bridge.inWaiting(0), { available: 3 });

  // Reading consumes from the same buffer inWaiting counts, so a driver that
  // reads what inWaiting reported ends up with an empty line, not a stale one.
  const read = await bridge.readHex(2, 50);
  assert.equal(read.hex, "51 58");
  assert.deepEqual(await bridge.inWaiting(0), { available: 1 });

  await bridge.close();
});

test("inWaiting with a wait returns as soon as bytes land, not at the deadline", async (t) => {
  const { bridge, push } = await openFedBridge(t);

  const started = performance.now();
  const pending = bridge.inWaiting(2000);
  setTimeout(() => push([0x06]), 20);
  const result = await pending;
  const elapsed = performance.now() - started;

  assert.deepEqual(result, { available: 1 });
  // The point of parking is that a busy line costs nothing: the call has to
  // settle on the read event, not sit out the full wait.
  assert.ok(elapsed < 1000, `inWaiting waited ${Math.round(elapsed)}ms for data that arrived at 20ms`);

  await bridge.close();
});

test("inWaiting on an idle line gives up at the wait and reports nothing", async (t) => {
  const { bridge } = await openFedBridge(t);

  const started = performance.now();
  assert.deepEqual(await bridge.inWaiting(40), { available: 0 });
  assert.ok(performance.now() - started >= 35, "an idle poll must actually wait, or the driver busy-spins");

  await bridge.close();
});

test("inWaiting on a closed port fails like every other transfer", async () => {
  const bridge = new BrowserSerialBridge();
  await assert.rejects(() => bridge.inWaiting(0), /not connected/i);
});

// ---------------------------------------------------------------------------
// The Python half: a real AnyTone 778UV clone against a simulated radio
// ---------------------------------------------------------------------------

const IMAGE_PATH = path.join(repoRoot, "chirp/tests/images/AnyTone_778UV.img");
// CloneModeRadio.MAGIC (chirp_common.py) separates the memory map from the
// JSON metadata trailer; the radio only ever sends the part before it.
const IMAGE_MAGIC = Buffer.from("00ff6368697270ee696d670001", "hex");

// What the radio would actually hold: the .img file minus its metadata
// trailer. CHIRP's own AnyTone images have no channels programmed, so the test
// writes two through the driver first - an all-empty codeplug would come back
// identical whether the clone read the radio or read nothing at all.
function radioMemoryFrom(imageBytes) {
  const image = Buffer.from(imageBytes);
  const magicAt = image.indexOf(IMAGE_MAGIC);
  assert.ok(magicAt > 0, "no CHIRP metadata magic in image");
  return Uint8Array.from(image.subarray(0, magicAt));
}

const PROGRAMMED_CHANNELS = [
  {
    Location: "1",
    Name: "GB3MH",
    Frequency: "145.725000",
    Duplex: "-",
    Offset: "0.600000",
    Mode: "FM",
  },
  {
    Location: "2",
    Name: "SIMPL",
    Frequency: "433.500000",
    Duplex: "",
    Offset: "0.000000",
    Mode: "FM",
  },
];

// A simulated AnyTone 778UV on the far end of the bridge, speaking the wire
// protocol in anytone778uv.py: every command is echoed back first (tx and rx
// share a pin on this radio) and then answered.
//
// It answers read commands without requiring PROGRAM first, because entering
// programming mode is the driver's detect_from_serial() step, which webchirp
// does not yet call (issue #81). Gating on it here would make this test fail
// for that reason instead of the one it exists to catch.
class FakeAnyTone778UV {
  constructor(memory) {
    this.memory = memory;
    this.rx = [];
    this.connected = false;
    this.reads = 0;
    this.baudRate = 0;
  }

  async open() {
    this.connected = true;
    this.rx = [];
    return { connected: true, message: "fake AnyTone 778UV" };
  }

  async close() {
    this.connected = false;
    this.rx = [];
    return { connected: false, message: "fake AnyTone 778UV disconnected" };
  }

  async writeBytes(bytesLike) {
    const command = Array.from(bytesLike || []).map((value) => Number(value) & 0xff);
    this.rx.push(...command, ...this._answer(command));
    return { written: command.length };
  }

  async writeHex(hex) {
    const text = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
    const bytes = [];
    for (let i = 0; i + 1 < text.length; i += 2) {
      bytes.push(Number.parseInt(text.slice(i, i + 2), 16));
    }
    await this.writeBytes(bytes);
    return { written: bytes.length, hex };
  }

  async readBytes(count) {
    return this.rx.splice(0, Math.min(Math.max(0, Number(count || 0)), this.rx.length));
  }

  async readHex(count) {
    const bytes = await this.readBytes(count);
    return {
      read: bytes.length,
      hex: bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
      timedOut: bytes.length < Number(count || 0),
    };
  }

  async inWaiting() {
    return { available: this.rx.length };
  }

  async resetBuffers() {
    this.rx = [];
    return { reset: true };
  }

  async prepareClone(wantsDtr, wantsRts, settleMs, baudRate) {
    this.rx = [];
    this.baudRate = Number(baudRate || 0);
    return { prepared: true, settleMs: 0, baudRate: this.baudRate };
  }

  // The pipe pushes control lines and port reconfigurations at the transport
  // now; this radio needs neither mid-clone, but the ops have to exist or the
  // bridge call fails before the read path is reached.
  async setSignals() {
    return { applied: true };
  }

  async reconfigure(options = {}) {
    return { reconfigured: true, options, changed: Object.keys(options) };
  }

  _answer(command) {
    const text = Buffer.from(command).toString("latin1");
    if (text === "PROGRAM") {
      return [0x51, 0x58, 0x06]; // "QX" + ACK
    }
    if (command.length === 1 && command[0] === 0x02) {
      // VER_FORMAT: hdr, model[7], bandlimit, version[6], ack
      return [
        0x49,
        ...Buffer.from("AT778UV", "latin1"),
        0x01,
        ...Buffer.from("V100\x00\x00", "latin1"),
        0x06,
      ];
    }
    if (command.length === 4 && command[0] === 0x52) {
      this.reads += 1;
      const address = (command[1] << 8) | command[2];
      const length = command[3];
      const body = [command[1], command[2], length];
      for (let i = 0; i < length; i += 1) {
        body.push(this.memory[address + i] ?? 0);
      }
      const checksum = body.reduce((sum, byte) => (sum + byte) % 256, 0);
      return [0x52, ...body, checksum, 0x06];
    }
    return []; // END, and anything else the driver tries, gets silence.
  }
}

test("an AnyTone 778UV clone reads the radio's memory through inWaiting()", async (t) => {
  const radio = new FakeAnyTone778UV(new Uint8Array(0));
  const harness = await createTestRadioHarness({ repoRoot, serialBridge: radio });

  // Program two channels into CHIRP's blank AnyTone image and load the radio
  // up with the result, so the clone has something to get wrong.
  await harness.runPythonJson('ensure_radio_module("anytone778uv") or json.dumps({})');
  await harness.loadCodeplugBinary(fs.readFileSync(IMAGE_PATH));
  const programmed = await harness.exportCodeplugBinary(
    "anytone778uv",
    "AnyTone778UV",
    PROGRAMMED_CHANNELS,
  );
  const expected = await harness.loadCodeplugBinary(programmed.image);
  assert.equal(expected.rows.length, PROGRAMMED_CHANNELS.length, "test setup wrote no channels");
  const memory = radioMemoryFrom(programmed.image);
  radio.memory = memory;

  // The exact call that used to raise AttributeError, on its own: the driver's
  // programming-mode handshake, which polls inWaiting() before every read.
  const handshake = await harness.runPythonJson(`
ensure_radio_module("anytone778uv")
import chirp.drivers.anytone778uv as _at
_pipe = WebSerialPipe(timeout=0.2)
json.dumps({
  "version": _at.enter_program_mode(_pipe).decode("latin1"),
  "inWaiting": _pipe.inWaiting(),
})
  `);
  assert.match(handshake.version, /^\x49AT778UV/);
  assert.equal(handshake.inWaiting, 0, "the handshake must consume everything the radio sent");

  await harness.connect({ moduleName: "anytone778uv", className: "AnyTone778UV" });
  const downloaded = await harness.readCodeplug("anytone778uv", "AnyTone778UV");
  assert.equal(radio.reads, memory.length / 0x10, "clone did not read every memory block");
  assert.equal(radio.baudRate, 9600, "clone did not prepare the session at the driver rate");

  // The channels the radio holds have to come back off the wire. With the old
  // shim this list was empty, because send_serial_command() polled an
  // in_waiting that never reported anything and returned nothing for it.
  assert.deepEqual(downloaded.rows, expected.rows);

  // The bytes the driver assembled have to be the bytes the radio sent. This
  // is what a 0-returning in_waiting silently destroys: the loop times out and
  // hands back a short or empty response with no error.
  const cached = await harness.readCodeplugBinary("anytone778uv", "AnyTone778UV");
  assert.deepEqual(
    Buffer.from(cached.image.subarray(0, memory.length)),
    Buffer.from(memory),
    "cloned image does not match the radio's memory",
  );

  t.diagnostic(`cloned ${radio.reads} blocks / ${memory.length} bytes`);
});

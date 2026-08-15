// Transport-agnostic serial loopback test suite.
//
// Runs against anything shaped like a Web Serial `SerialPort` — a native
// `navigator.serial` port, one of the WebUSB chip drivers (FTDI, PL2303,
// CH340), the CDC polyfill, or a fake port in tests. The physical setup it
// assumes is a TX-to-RX jumper on the adapter, so every byte written comes
// straight back.
//
// WHAT LOOPBACK CANNOT TEST: baud rate accuracy. Both directions clock off the
// same divisor, so a wrong divisor still echoes perfectly. Divisor math is
// covered by the per-chip unit tests; this suite covers framing, buffering and
// transport behaviour — packet boundaries, byte transparency, idle handling,
// timeouts and reopen.
//
// The session below deliberately reimplements read buffering rather than
// reusing BrowserSerialBridge: the bridge buffers for CHIRP's byte-at-a-time
// protocol needs, while a test needs exact-length reads, explicit timeouts and
// a drain primitive, and must talk to a port it was handed rather than one it
// requested.

export const DEFAULT_BAUD_RATES = [9600, 38400, 57600, 115200];

// Timeout budget for an echo of `byteCount` bytes: the wire time for a round
// trip at this baud (10 bits per byte, out and back) plus a fixed allowance for
// USB latency and host scheduling. Without the baud term, large payloads at
// 9600 fail on the clock rather than on a defect.
function echoTimeoutFor(byteCount, baudRate, baseMs) {
  const wireMs = Math.ceil((byteCount * 10 * 2 * 1000) / Math.max(1, Number(baudRate) || 9600));
  return baseMs + wireMs;
}

export class LoopbackTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoopbackTimeoutError";
  }
}

// Deterministic payload generator (xorshift32). Reproducible across runs so a
// failure report names bytes the next run will produce again.
export function deterministicBytes(length, seed = 0x1234abcd) {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hexPreview(bytes, limit = 16) {
  const shown = Array.from(bytes.slice(0, limit))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return bytes.length > limit ? `${shown} …` : shown;
}

// Describe how `got` differs from `want` in terms a hardware report can act on:
// short/long, and the first byte that disagrees.
function describeMismatch(want, got) {
  if (got.length !== want.length) {
    return `expected ${want.length} bytes, got ${got.length}`;
  }
  for (let i = 0; i < want.length; i += 1) {
    if (want[i] !== got[i]) {
      return `byte ${i} differs: expected 0x${want[i].toString(16).padStart(2, "0")}, `
        + `got 0x${got[i].toString(16).padStart(2, "0")} `
        + `(context wanted: ${hexPreview(want.slice(i))} / got: ${hexPreview(got.slice(i))})`;
    }
  }
  return "";
}

// A read/write session over an already-open port. Owns the reader lock and a
// receive buffer so callers can ask for exact byte counts with a timeout.
export function createPortSession(port) {
  let reader = null;
  let writer = null;
  let buffer = new Uint8Array(0);
  let streamError = null;
  let stopped = false;
  const waiters = [];

  function takeFromBuffer(count) {
    const taken = buffer.slice(0, count);
    buffer = buffer.slice(count);
    return taken;
  }

  function settleWaiters() {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (streamError) {
        waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(streamError);
        continue;
      }
      if (buffer.length < waiter.count) {
        return;
      }
      waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(takeFromBuffer(waiter.count));
    }
  }

  async function pump() {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          buffer = concatBytes(buffer, new Uint8Array(value));
          settleWaiters();
        }
      }
    } catch (error) {
      if (!stopped) {
        streamError = error instanceof Error ? error : new Error(String(error));
        settleWaiters();
      }
    }
  }

  return {
    start() {
      if (!port.readable || !port.writable) {
        throw new Error("Port exposes no readable/writable streams — is it open?");
      }
      reader = port.readable.getReader();
      writer = port.writable.getWriter();
      // Not awaited: the pump runs for the life of the session.
      pump();
    },

    available() {
      return buffer.length;
    },

    async write(bytes) {
      await writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },

    read(count, timeoutMs) {
      if (streamError) {
        return Promise.reject(streamError);
      }
      if (buffer.length >= count) {
        return Promise.resolve(takeFromBuffer(count));
      }
      return new Promise((resolve, reject) => {
        const waiter = { count, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new LoopbackTimeoutError(
            `timed out after ${timeoutMs} ms waiting for ${count} bytes `
            + `(${buffer.length} buffered: ${hexPreview(buffer)})`,
          ));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },

    // Discard whatever is in flight until the line has been quiet for
    // `quietMs`. Used between cases so one failure cannot cascade.
    async drain(quietMs) {
      for (;;) {
        try {
          await this.read(1, quietMs);
        } catch (error) {
          if (error instanceof LoopbackTimeoutError) {
            buffer = new Uint8Array(0);
            return;
          }
          throw error;
        }
      }
    },

    async close() {
      stopped = true;
      try {
        await reader?.cancel();
      } catch {
        // Cancelling a stream that already errored is not interesting.
      }
      try {
        reader?.releaseLock();
      } catch {
        // Already released.
      }
      try {
        await writer?.close();
      } catch {
        try {
          writer?.releaseLock();
        } catch {
          // Already released.
        }
      }
    },
  };
}

// Write a payload and require exactly that payload back — no more. The trailing
// quiet check catches doubled echoes and stray status bytes leaking into the
// data path, which a plain compare would silently accept.
async function expectEcho(session, payload, { timeoutMs, quietMs }) {
  await session.write(payload);
  const echoed = await session.read(payload.length, timeoutMs);
  const mismatch = describeMismatch(payload, echoed);
  if (mismatch) {
    throw new Error(mismatch);
  }
  try {
    const extra = await session.read(1, quietMs);
    throw new Error(
      `${payload.length} bytes echoed correctly, then ${1 + session.available()} `
      + `unexpected extra byte(s) arrived, starting 0x${extra[0].toString(16).padStart(2, "0")}`,
    );
  } catch (error) {
    if (!(error instanceof LoopbackTimeoutError)) {
      throw error;
    }
  }
}

// Cases that run once per baud rate. `ctx` carries the resolved options plus
// the baud rate in force.
const PER_BAUD_CASES = [
  {
    id: "byte-transparency",
    title: "All 256 byte values survive the round trip",
    async run(session, ctx) {
      const payload = new Uint8Array(256);
      for (let i = 0; i < 256; i += 1) {
        payload[i] = i;
      }
      await expectEcho(session, payload, {
        timeoutMs: echoTimeoutFor(payload.length, ctx.baudRate, ctx.readTimeoutMs),
        quietMs: ctx.quietMs,
      });
    },
  },
  {
    id: "flow-control-bytes",
    title: "XON/XOFF and NUL/FF pass through as data",
    async run(session, ctx) {
      // If software flow control is on anywhere in the stack, 0x11/0x13 are
      // swallowed instead of echoed. Repeated so a single dropped byte shifts
      // the whole comparison rather than hiding in noise.
      const pattern = [0x00, 0x11, 0x13, 0xff, 0x11, 0x00, 0xff, 0x13];
      const payload = new Uint8Array(pattern.length * 8);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = pattern[i % pattern.length];
      }
      await expectEcho(session, payload, {
        timeoutMs: echoTimeoutFor(payload.length, ctx.baudRate, ctx.readTimeoutMs),
        quietMs: ctx.quietMs,
      });
    },
  },
  {
    id: "packet-boundaries",
    title: "Writes spanning USB packet boundaries stay intact",
    async run(session, ctx) {
      // The sizes either side of the endpoint packet size are where header
      // stripping and chunking bugs show up.
      const sizes = [
        ctx.packetSize - 1,
        ctx.packetSize,
        ctx.packetSize + 1,
        ctx.packetSize * 2,
        ctx.packetSize * 8,
      ];
      for (const size of sizes) {
        const payload = deterministicBytes(size, size + 1);
        try {
          await expectEcho(session, payload, {
            timeoutMs: echoTimeoutFor(size, ctx.baudRate, ctx.readTimeoutMs),
            quietMs: ctx.quietMs,
          });
        } catch (error) {
          throw new Error(`${size}-byte write: ${error.message}`);
        }
      }
    },
  },
  {
    id: "idle-then-data",
    title: "Data still arrives after an idle period",
    async run(session, ctx) {
      // An idle FTDI link delivers status-only packets. A read path that
      // mishandles them goes permanently silent after the first idle gap, which
      // no back-to-back test can reproduce.
      await new Promise((resolve) => setTimeout(resolve, ctx.idleMs));
      if (session.available() > 0) {
        throw new Error(`${session.available()} byte(s) appeared on an idle line`);
      }
      const payload = deterministicBytes(8, 0x51de);
      await expectEcho(session, payload, {
        timeoutMs: echoTimeoutFor(payload.length, ctx.baudRate, ctx.readTimeoutMs),
        quietMs: ctx.quietMs,
      });
    },
  },
];

// Cases that run once, at the highest baud rate, because they are slow or
// baud-independent.
const ONCE_CASES = [
  {
    id: "sustained-throughput",
    title: "A large single write survives without truncation",
    async run(session, ctx) {
      const payload = deterministicBytes(ctx.throughputBytes, 0xbeef);
      await expectEcho(session, payload, {
        timeoutMs: echoTimeoutFor(payload.length, ctx.baudRate, ctx.readTimeoutMs * 4),
        quietMs: ctx.quietMs,
      });
    },
  },
  {
    id: "read-timeout",
    title: "A read with no data times out cleanly",
    async run(session, ctx) {
      // A read path that hangs forever instead of timing out is the failure
      // mode that makes a stuck clone look like a slow one.
      try {
        const got = await session.read(1, ctx.readTimeoutMs);
        throw new Error(`expected a timeout, but ${got.length} byte(s) arrived: ${hexPreview(got)}`);
      } catch (error) {
        if (!(error instanceof LoopbackTimeoutError)) {
          throw error;
        }
      }
    },
  },
  {
    id: "control-lines",
    title: "CTS follows RTS and DSR follows DTR",
    // Needs RTS→CTS and DTR→DSR jumpered in addition to TX→RX, and a port that
    // reports input signals at all.
    requires(port, ctx) {
      if (!ctx.controlLines) {
        return "control-line jumpers not declared";
      }
      if (typeof port.getSignals !== "function") {
        return "port does not implement getSignals()";
      }
      return "";
    },
    async run(session, ctx, port) {
      for (const asserted of [true, false]) {
        await port.setSignals({ requestToSend: asserted, dataTerminalReady: asserted });
        await new Promise((resolve) => setTimeout(resolve, ctx.signalSettleMs));
        const signals = await port.getSignals();
        if (Boolean(signals.clearToSend) !== asserted) {
          throw new Error(`RTS ${asserted ? "asserted" : "deasserted"} but CTS read back ${signals.clearToSend}`);
        }
        if (Boolean(signals.dataSetReady) !== asserted) {
          throw new Error(`DTR ${asserted ? "asserted" : "deasserted"} but DSR read back ${signals.dataSetReady}`);
        }
      }
    },
  },
];

const REOPEN_CASE = {
  id: "reopen",
  title: "The port still works after close and reopen",
  async run(session, ctx) {
    const payload = deterministicBytes(16, 0x0be9);
    await expectEcho(session, payload, {
      timeoutMs: echoTimeoutFor(payload.length, ctx.baudRate, ctx.readTimeoutMs),
      quietMs: ctx.quietMs,
    });
  },
};

const DEFAULTS = {
  baudRates: DEFAULT_BAUD_RATES,
  packetSize: 64,
  controlLines: false,
  idleMs: 2000,
  readTimeoutMs: 1000,
  quietMs: 150,
  signalSettleMs: 50,
  throughputBytes: 16384,
  onCase: null,
  now: () => Date.now(),
};

function makeResult(entry, status, detail, startedAt, ctx) {
  return {
    id: entry.id,
    title: entry.title,
    baudRate: entry.baudRate,
    status,
    detail,
    durationMs: Math.max(0, ctx.now() - startedAt),
  };
}

// Run one case against an open session, converting a throw into a "fail"
// result. One case failing never aborts the run: on real hardware the later
// cases are what tell you whether the fault is total or partial.
async function runCase(entry, session, port, ctx, results) {
  const startedAt = ctx.now();
  ctx.onCase?.({ phase: "start", id: entry.id, title: entry.title, baudRate: entry.baudRate });
  let result;
  const skipReason = entry.requires ? entry.requires(port, ctx) : "";
  if (skipReason) {
    result = makeResult(entry, "skip", skipReason, startedAt, ctx);
  } else {
    try {
      await session.drain(ctx.quietMs);
      await entry.run(session, ctx, port);
      result = makeResult(entry, "pass", "", startedAt, ctx);
    } catch (error) {
      result = makeResult(entry, "fail", error?.message || String(error), startedAt, ctx);
    }
  }
  results.push(result);
  ctx.onCase?.({ phase: "finish", ...result });
  return result;
}

// Open the port, run `entries` against it, then close. A failure to open is
// itself recorded as a failure of every entry, so a chip that rejects one baud
// rate shows up as that baud failing rather than as a thrown run.
async function runWithOpenPort(port, baudRate, entries, ctx, results) {
  // Cases read the baud in force off the context to size their timeouts.
  const caseCtx = { ...ctx, baudRate };
  let session = null;
  try {
    await port.open({ baudRate });
    session = createPortSession(port);
    session.start();
  } catch (error) {
    const detail = `could not open port at ${baudRate} baud: ${error?.message || error}`;
    for (const entry of entries) {
      results.push(makeResult({ ...entry, baudRate }, "fail", detail, ctx.now(), ctx));
    }
    return;
  }
  try {
    for (const entry of entries) {
      await runCase({ ...entry, baudRate }, session, port, caseCtx, results);
    }
  } finally {
    await session.close();
    try {
      await port.close();
    } catch {
      // A close failure after the cases have run tells us nothing new.
    }
  }
}

/**
 * Run the loopback suite against a Web Serial-shaped port with TX jumpered to
 * RX. The port must be closed on entry; it is left closed on return.
 *
 * @returns {Promise<{results: Array, passed: number, failed: number, skipped: number}>}
 */
export async function runLoopbackSuite(port, options = {}) {
  const ctx = { ...DEFAULTS, ...options };
  const baudRates = ctx.baudRates.slice();
  if (baudRates.length === 0) {
    throw new Error("runLoopbackSuite needs at least one baud rate");
  }
  const results = [];

  for (const baudRate of baudRates) {
    await runWithOpenPort(port, baudRate, PER_BAUD_CASES, ctx, results);
  }

  await runWithOpenPort(port, baudRates[baudRates.length - 1], ONCE_CASES, ctx, results);

  // Reopening is its own case: the port has been opened and closed several
  // times by now, so this is the state a second session in one page load sees.
  await runWithOpenPort(port, baudRates[0], [REOPEN_CASE], ctx, results);

  return {
    results,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
  };
}

// Plain-text report, suitable for pasting into an issue.
export function formatLoopbackReport(summary) {
  const lines = [];
  for (const result of summary.results) {
    const mark = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";
    const baud = result.baudRate ? ` @ ${result.baudRate}` : "";
    lines.push(`${mark}  ${result.title}${baud}${result.detail ? ` — ${result.detail}` : ""}`);
  }
  lines.push(`${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  return lines.join("\n");
}

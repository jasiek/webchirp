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
// reusing the serial bridge (web/js/serial-bridge.ts): the bridge buffers for CHIRP's byte-at-a-time
// protocol needs, while a test needs exact-length reads, explicit timeouts and
// a drain primitive, and must talk to a port it was handed rather than one it
// requested.

import { errorFields } from "./error-details.ts";

export const DEFAULT_BAUD_RATES = [9600, 38400, 57600, 115200];

/**
 * What the suite needs of a port: Web Serial's open/close and streams, plus
 * the control lines when the control-line case runs.
 */
export interface LoopbackPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  setSignals?(signals: SerialOutputSignals): Promise<void>;
  getSignals?(): Promise<SerialInputSignals>;
}

/** Progress as the suite runs: a case starting, then its result. */
export type LoopbackCaseEvent =
  | { phase: "start"; id: string; title: string; baudRate?: number }
  | ({ phase: "finish" } & LoopbackResult);

/** The suite's settings; runLoopbackSuite() fills in what a caller leaves out. */
export interface LoopbackOptions {
  baudRates: number[];
  /** The adapter's bulk packet size, for the boundary case. */
  packetSize: number;
  /** RTS-CTS and DTR-DSR are jumpered too. */
  controlLines: boolean;
  idleMs: number;
  readTimeoutMs: number;
  quietMs: number;
  signalSettleMs: number;
  throughputBytes: number;
  onCase: ((event: LoopbackCaseEvent) => void) | null;
  now: () => number;
}

/** The options a case runs with: the suite's, plus the baud rate in force. */
type CaseContext = LoopbackOptions & { baudRate: number };

/** One case: what it checks, when it cannot run, and the check itself. */
interface LoopbackCase {
  id: string;
  title: string;
  /** Why the case cannot run on this port and setup, or "" when it can. */
  requires?(port: LoopbackPort, ctx: CaseContext): string;
  run(session: PortSession, ctx: CaseContext, port: LoopbackPort): Promise<void>;
}

type PortSession = ReturnType<typeof createPortSession>;

// Timeout budget for an echo of `byteCount` bytes: the wire time for a round
// trip at this baud (10 bits per byte, out and back) plus a fixed allowance for
// USB latency and host scheduling. Without the baud term, large payloads at
// 9600 fail on the clock rather than on a defect.
function echoTimeoutFor(byteCount: number, baudRate: number, baseMs: number): number {
  const wireMs = Math.ceil((byteCount * 10 * 2 * 1000) / Math.max(1, Number(baudRate) || 9600));
  return baseMs + wireMs;
}

export class LoopbackTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopbackTimeoutError";
  }
}

// Deterministic payload generator (xorshift32). Reproducible across runs so a
// failure report names bytes the next run will produce again.
export function deterministicBytes(length: number, seed = 0x1234abcd): Uint8Array {
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hexPreview(bytes: Uint8Array, limit = 16): string {
  const shown = Array.from(bytes.slice(0, limit))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return bytes.length > limit ? `${shown} …` : shown;
}

// Describe how `got` differs from `want` in terms a hardware report can act on:
// short/long, and the first byte that disagrees.
function describeMismatch(want: Uint8Array, got: Uint8Array): string {
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
export function createPortSession(port: LoopbackPort) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let buffer: Uint8Array = new Uint8Array(0);
  let streamError: Error | null = null;
  let stopped = false;
  const waiters: Array<{
    count: number;
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: number;
  }> = [];

  function takeFromBuffer(count: number): Uint8Array {
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

  async function pump(activeReader: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      for (;;) {
        const { value, done } = await activeReader.read();
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
      const activeReader = port.readable.getReader();
      reader = activeReader;
      writer = port.writable.getWriter();
      // Not awaited: the pump runs for the life of the session.
      pump(activeReader);
    },

    available() {
      return buffer.length;
    },

    async write(bytes: Uint8Array | ArrayLike<number>): Promise<void> {
      if (!writer) {
        throw new Error("The port session has not been started");
      }
      await writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },

    read(count: number, timeoutMs: number): Promise<Uint8Array> {
      if (streamError) {
        return Promise.reject(streamError);
      }
      if (buffer.length >= count) {
        return Promise.resolve(takeFromBuffer(count));
      }
      return new Promise<Uint8Array>((resolve, reject) => {
        const waiter = { count, resolve, reject, timer: 0 };
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
    async drain(quietMs: number): Promise<void> {
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
      // Release the lock rather than closing the writer, mirroring
      // the serial bridge's _teardown(). Two reasons, both load-bearing:
      // close() does NOT release the lock (only releaseLock() does), and a
      // still-locked writable makes SerialPort.close() reject with
      // InvalidStateError — which silently leaves the port open. close() also
      // waits for pending writes to flush, so on the wedged adapter this page
      // exists to diagnose it can hang forever.
      try {
        writer?.releaseLock();
      } catch {
        // Already released.
      }
    },
  };
}

// Write a payload and require exactly that payload back — no more. The trailing
// quiet check catches doubled echoes and stray status bytes leaking into the
// data path, which a plain compare would silently accept.
async function expectEcho(
  session: PortSession,
  payload: Uint8Array,
  { timeoutMs, quietMs }: { timeoutMs: number; quietMs: number },
): Promise<void> {
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
const PER_BAUD_CASES: LoopbackCase[] = [
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
          throw new Error(`${size}-byte write: ${errorFields(error).message}`);
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
const ONCE_CASES: LoopbackCase[] = [
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
      // requires() has skipped a port without getSignals(); every port that
      // has it has setSignals() too.
      if (!port.setSignals || !port.getSignals) {
        throw new Error("port does not implement setSignals() and getSignals()");
      }
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

const REOPEN_CASE: LoopbackCase = {
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

const DEFAULTS: LoopbackOptions = {
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

/** One case's outcome, as the report and the page's table show it. */
export interface LoopbackResult {
  id: string;
  title: string;
  baudRate?: number;
  status: "pass" | "fail" | "skip";
  detail: string;
  durationMs: number;
}

function makeResult(
  entry: { id: string; title: string; baudRate?: number },
  status: LoopbackResult["status"],
  detail: string,
  startedAt: number,
  ctx: { now(): number },
): LoopbackResult {
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
// Every result reaches the caller the same way, whether it came from a case
// that ran or from one that never got the chance. A result that skips onCase is
// invisible to any UI built from those events.
function recordResult(
  entry: { id: string; title: string; baudRate?: number },
  status: LoopbackResult["status"],
  detail: string,
  startedAt: number,
  ctx: LoopbackOptions,
  results: LoopbackResult[],
): LoopbackResult {
  const result = makeResult(entry, status, detail, startedAt, ctx);
  results.push(result);
  ctx.onCase?.({ phase: "finish", ...result });
  return result;
}

async function runCase(
  entry: LoopbackCase & { baudRate: number },
  session: PortSession,
  port: LoopbackPort,
  ctx: CaseContext,
  results: LoopbackResult[],
): Promise<LoopbackResult> {
  const startedAt = ctx.now();
  ctx.onCase?.({ phase: "start", id: entry.id, title: entry.title, baudRate: entry.baudRate });
  const skipReason = entry.requires ? entry.requires(port, ctx) : "";
  if (skipReason) {
    return recordResult(entry, "skip", skipReason, startedAt, ctx, results);
  }
  try {
    await session.drain(ctx.quietMs);
    await entry.run(session, ctx, port);
    return recordResult(entry, "pass", "", startedAt, ctx, results);
  } catch (error) {
    return recordResult(entry, "fail", String(errorFields(error).message || error), startedAt, ctx, results);
  }
}

// Record every entry as failed because the pass never started. Cases that would
// have skipped still skip: reporting control-lines as FAIL when the user never
// claimed to have jumpered them sends them checking hardware they were told was
// optional, and inflates the failure count.
function failEntries(
  entries: Array<LoopbackCase & { baudRate: number }>,
  port: LoopbackPort,
  detail: string,
  ctx: CaseContext,
  results: LoopbackResult[],
): void {
  for (const entry of entries) {
    const skipReason = entry.requires ? entry.requires(port, ctx) : "";
    recordResult(entry, skipReason ? "skip" : "fail", skipReason || detail, ctx.now(), ctx, results);
  }
}

// Open the port, run `entries` against it, then close. A failure to open is
// itself recorded as a failure of every entry, so a chip that rejects one baud
// rate shows up as that baud failing rather than as a thrown run.
async function runWithOpenPort(
  port: LoopbackPort,
  baudRate: number,
  entries: LoopbackCase[],
  ctx: LoopbackOptions,
  results: LoopbackResult[],
): Promise<void> {
  // Cases read the baud in force off the context to size their timeouts.
  const caseCtx: CaseContext = { ...ctx, baudRate };
  const withBaud = entries.map((entry) => ({ ...entry, baudRate }));
  let session: ReturnType<typeof createPortSession>;
  let opened = false;
  try {
    await port.open({ baudRate });
    opened = true;
    session = createPortSession(port);
    session.start();
  } catch (error) {
    // Opening and starting to read fail for different reasons and want
    // different wording — "could not open port … is it open?" reads as a
    // contradiction and points at the wrong thing.
    const what = opened ? "could not start reading from the port at" : "could not open port at";
    failEntries(withBaud, port, `${what} ${baudRate} baud: ${errorFields(error).message || error}`, caseCtx, results);
    // The port is open but unusable; leaving it claimed breaks every later pass
    // and any second run in the same page load.
    if (opened) {
      try {
        await port.close();
      } catch {
        // Nothing better to do — the failure above is already reported.
      }
    }
    return;
  }
  try {
    for (const entry of withBaud) {
      await runCase(entry, session, port, caseCtx, results);
    }
  } finally {
    await session.close();
    const closedAt = ctx.now();
    try {
      await port.close();
    } catch (error) {
      // Never swallow this. A close that fails leaves the port claimed, so the
      // next pass fails to open and the report blames the wrong thing — which
      // is exactly how a leaked writer lock stayed invisible.
      recordResult(
        { id: "teardown", title: "Port closed cleanly after the pass", baudRate },
        "fail",
        `closing the port failed: ${errorFields(error).message || error}`,
        closedAt,
        caseCtx,
        results,
      );
    }
  }
}

/**
 * Run the loopback suite against a Web Serial-shaped port with TX jumpered to
 * RX. The port must be closed on entry; it is left closed on return.
 */
export async function runLoopbackSuite(
  port: LoopbackPort,
  options: Partial<LoopbackOptions> = {},
): Promise<{ results: LoopbackResult[]; passed: number; failed: number; skipped: number }> {
  const ctx: LoopbackOptions = { ...DEFAULTS, ...options };
  // Sorted, not just copied: the once-per-run cases below pick "the highest
  // rate" off the end, and an unsorted array would run the 16 KB throughput
  // case at the slowest rate against a timeout budgeted for the fastest.
  const baudRates = ctx.baudRates.slice().sort((a, b) => a - b);
  if (baudRates.length === 0) {
    throw new Error("runLoopbackSuite needs at least one baud rate");
  }
  const results: LoopbackResult[] = [];

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
export function formatLoopbackReport(
  summary: { results: LoopbackResult[]; passed: number; failed: number; skipped: number },
): string {
  const lines: string[] = [];
  for (const result of summary.results) {
    const mark = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";
    const baud = result.baudRate ? ` @ ${result.baudRate}` : "";
    lines.push(`${mark}  ${result.title}${baud}${result.detail ? ` — ${result.detail}` : ""}`);
  }
  lines.push(`${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  return lines.join("\n");
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicBytes,
  formatLoopbackReport,
  runLoopbackSuite,
} from "../web/js/loopback-suite.js";
import {
  CHIP_NAMES,
  FAST_SUITE_OPTIONS,
  createChipLoopbackPort,
  createEchoPort,
} from "./test-loopback-harness.mjs";

// One baud rate is enough for the fault tests: they are about whether a defect
// is detected at all, not about rate coverage.
const SINGLE_BAUD = { ...FAST_SUITE_OPTIONS, baudRates: [115200] };

function resultsFor(summary, id) {
  return summary.results.filter((r) => r.id === id);
}

function statusOf(summary, id) {
  const matching = resultsFor(summary, id);
  assert.ok(matching.length > 0, `no results recorded for case "${id}"`);
  return matching.map((r) => r.status);
}

function reportOn(summary) {
  return `\n${formatLoopbackReport(summary)}`;
}

test("deterministicBytes is reproducible and length-exact", () => {
  // Failure reports quote payload bytes; they are only actionable if the next
  // run generates the same ones.
  assert.deepEqual(deterministicBytes(32, 7), deterministicBytes(32, 7));
  assert.notDeepEqual(deterministicBytes(32, 7), deterministicBytes(32, 8));
  assert.equal(deterministicBytes(0).length, 0);
  assert.equal(deterministicBytes(1500).length, 1500);
});

test("a healthy echo port passes every case", async () => {
  const port = createEchoPort();
  const summary = await runLoopbackSuite(port, FAST_SUITE_OPTIONS);

  assert.equal(summary.failed, 0, reportOn(summary));
  assert.ok(summary.passed > 0, reportOn(summary));
  // Control lines are the only case that opts out by default.
  assert.deepEqual(statusOf(summary, "control-lines"), ["skip"]);
  for (const id of ["byte-transparency", "flow-control-bytes", "packet-boundaries", "idle-then-data"]) {
    assert.deepEqual(
      statusOf(summary, id),
      FAST_SUITE_OPTIONS.baudRates.map(() => "pass"),
      `${id}${reportOn(summary)}`,
    );
  }
});

test("every case is reported against every requested baud rate", async () => {
  const port = createEchoPort();
  const baudRates = [9600, 38400, 115200];
  const summary = await runLoopbackSuite(port, { ...FAST_SUITE_OPTIONS, baudRates });

  assert.deepEqual(
    resultsFor(summary, "byte-transparency").map((r) => r.baudRate),
    baudRates,
  );
  // The slow and rate-independent cases run once, at the top rate.
  assert.deepEqual(resultsFor(summary, "sustained-throughput").map((r) => r.baudRate), [115200]);
  assert.deepEqual(resultsFor(summary, "read-timeout").map((r) => r.baudRate), [115200]);
  assert.equal(summary.failed, 0, reportOn(summary));
});

test("truncated writes fail the packet-boundary case", async () => {
  const port = createEchoPort({ faults: { truncateWritesTo: 32 } });
  const summary = await runLoopbackSuite(port, SINGLE_BAUD);

  assert.deepEqual(statusOf(summary, "packet-boundaries"), ["fail"]);
  const [detail] = resultsFor(summary, "packet-boundaries").map((r) => r.detail);
  assert.match(detail, /63-byte write/);
});

test("a doubled echo fails byte transparency rather than passing on a prefix", async () => {
  // A compare that only checked the bytes it asked for would accept this.
  const port = createEchoPort({ faults: { duplicate: true } });
  const summary = await runLoopbackSuite(port, SINGLE_BAUD);

  assert.deepEqual(statusOf(summary, "byte-transparency"), ["fail"]);
  assert.match(resultsFor(summary, "byte-transparency")[0].detail, /byte 1 differs/);
});

test("a line that eats XON/XOFF fails the flow-control case", async () => {
  const port = createEchoPort({ faults: { swallow: [0x11, 0x13] } });
  const summary = await runLoopbackSuite(port, SINGLE_BAUD);

  assert.deepEqual(statusOf(summary, "flow-control-bytes"), ["fail"]);
});

test("a link that goes silent after an idle gap fails the idle case", async () => {
  // The FTDI status-only-packet deadlock, reproduced: back-to-back traffic is
  // fine, and the link dies the first time the line goes quiet. No test that
  // writes continuously can see it.
  const port = createEchoPort({ faults: { wedgeAfterIdle: true }, idleWedgeMs: 150 });
  const summary = await runLoopbackSuite(port, { ...SINGLE_BAUD, idleMs: 400 });

  assert.deepEqual(statusOf(summary, "byte-transparency"), ["pass"], reportOn(summary));
  assert.deepEqual(statusOf(summary, "idle-then-data"), ["fail"]);
  assert.match(resultsFor(summary, "idle-then-data")[0].detail, /timed out/);
});

test("a port that refuses to reopen fails every case needing a second open", async () => {
  // The suite opens once per baud rate, so a port that only opens once passes
  // its first pass and then fails everything after it.
  const port = createEchoPort({ faults: { failReopen: true } });
  const summary = await runLoopbackSuite(port, SINGLE_BAUD);

  assert.deepEqual(statusOf(summary, "byte-transparency"), ["pass"], reportOn(summary));
  assert.deepEqual(statusOf(summary, "reopen"), ["fail"]);
  assert.match(resultsFor(summary, "reopen")[0].detail, /could not open port/);
});

test("control-line loopback passes when jumpered and fails when not wired through", async () => {
  const wired = createEchoPort();
  const wiredSummary = await runLoopbackSuite(wired, { ...SINGLE_BAUD, controlLines: true });
  assert.deepEqual(statusOf(wiredSummary, "control-lines"), ["pass"], reportOn(wiredSummary));

  const unwired = createEchoPort({ faults: { noSignalLoopback: true } });
  const unwiredSummary = await runLoopbackSuite(unwired, { ...SINGLE_BAUD, controlLines: true });
  assert.deepEqual(statusOf(unwiredSummary, "control-lines"), ["fail"]);
  assert.match(resultsFor(unwiredSummary, "control-lines")[0].detail, /CTS read back/);
});

test("the control-line case skips itself on ports with no getSignals", async () => {
  // The WebUSB chip drivers implement setSignals but not getSignals, so on
  // those the case must skip rather than fail a jumpered adapter.
  const { port } = createChipLoopbackPort("ch340");
  const summary = await runLoopbackSuite(port, { ...SINGLE_BAUD, controlLines: true });

  assert.deepEqual(statusOf(summary, "control-lines"), ["skip"]);
  assert.match(resultsFor(summary, "control-lines")[0].detail, /getSignals/);
});

for (const chip of CHIP_NAMES) {
  test(`the ${chip} driver passes the loopback suite against a fake looped-back device`, async () => {
    const { port, packetSize } = createChipLoopbackPort(chip);
    const summary = await runLoopbackSuite(port, { ...FAST_SUITE_OPTIONS, packetSize });

    assert.equal(summary.failed, 0, reportOn(summary));
  });

  test(`the ${chip} driver recovers from a stalled bulk IN endpoint`, async () => {
    // clearHalt() recovery: without it the read path goes silent for good.
    const { port, packetSize } = createChipLoopbackPort(chip, { faults: { stallOnce: true } });
    const summary = await runLoopbackSuite(port, { ...SINGLE_BAUD, packetSize });

    assert.equal(summary.failed, 0, reportOn(summary));
  });
}

for (const chip of CHIP_NAMES) {
  test(`the ${chip} driver can be reopened after close`, async () => {
    // Regression: close() latches the flag the read loop watches. Until open()
    // cleared it, a reopened port object handed back streams that exited on the
    // first pull and delivered nothing, with no error anywhere.
    const { port } = createChipLoopbackPort(chip);
    for (const pass of [1, 2]) {
      await port.open({ baudRate: 9600 });
      const writer = port.writable.getWriter();
      const reader = port.readable.getReader();
      await writer.write(new Uint8Array([0xa5, 0x5a]));
      const { value } = await reader.read();
      assert.deepEqual(Array.from(value), [0xa5, 0x5a], `pass ${pass}`);
      await reader.cancel();
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    }
  });
}

test("an FTDI device that omits its status header fails the suite", async () => {
  // The driver strips two bytes from every packet. If a change ever made that
  // stripping unconditional against silicon that does not send the header, the
  // damage is silent data corruption — this is the case that catches it.
  const { port, packetSize } = createChipLoopbackPort("ftdi", { faults: { noStatusHeader: true } });
  const summary = await runLoopbackSuite(port, { ...SINGLE_BAUD, packetSize });

  assert.ok(summary.failed > 0, reportOn(summary));
  assert.deepEqual(statusOf(summary, "byte-transparency"), ["fail"]);
});

test("the session leaves both streams unlocked so the port can close", async () => {
  // Regression: close() on a writer does NOT release its lock, so a session
  // that closed instead of releasing left the writable locked, SerialPort
  // .close() rejected with InvalidStateError, and every later pass failed to
  // open. The echo port models that check; the chip fakes do not, because real
  // chip drivers do not either.
  const port = createEchoPort();
  const summary = await runLoopbackSuite(port, SINGLE_BAUD);

  assert.equal(summary.failed, 0, reportOn(summary));
  assert.deepEqual(resultsFor(summary, "teardown"), [], "port failed to close after a pass");
});

test("a port that cannot be closed reports it instead of failing the next pass", async () => {
  // The failure mode this exists to prevent: a swallowed close error surfaces
  // one pass later as "could not open port", pointing at the wrong thing.
  const port = createEchoPort();
  const realClose = port.close.bind(port);
  let closes = 0;
  port.close = async () => {
    closes += 1;
    await realClose();
    if (closes === 1) {
      throw new Error("device went away");
    }
  };
  const summary = await runLoopbackSuite(port, { ...SINGLE_BAUD, baudRates: [9600, 115200] });

  assert.deepEqual(statusOf(summary, "teardown"), ["fail"]);
  assert.match(resultsFor(summary, "teardown")[0].detail, /closing the port failed: device went away/);
});

test("an unsorted baudRates list still runs the slow cases at the highest rate", async () => {
  // Taking the last element as "the highest" would run the throughput case at
  // 9600 against a budget computed for 115200 — a guaranteed false failure.
  const port = createEchoPort();
  const summary = await runLoopbackSuite(port, { ...FAST_SUITE_OPTIONS, baudRates: [115200, 57600] });

  assert.deepEqual(resultsFor(summary, "sustained-throughput").map((r) => r.baudRate), [115200]);
  assert.deepEqual(
    resultsFor(summary, "byte-transparency").map((r) => r.baudRate),
    [57600, 115200],
    "per-baud cases should run in ascending order",
  );
  assert.equal(summary.failed, 0, reportOn(summary));
});

test("results from a pass that never opened still reach onCase", async () => {
  // The diagnostics page builds its table only from onCase events, so a result
  // that skips them is invisible there even though it counts in the summary.
  const port = createEchoPort({ faults: { failReopen: true } });
  const seen = [];
  const summary = await runLoopbackSuite(port, {
    ...SINGLE_BAUD,
    onCase: (event) => {
      if (event.phase === "finish") {
        seen.push(event.id);
      }
    },
  });

  assert.ok(summary.failed > 0, reportOn(summary));
  assert.deepEqual(
    seen.slice().sort(),
    summary.results.map((r) => r.id).sort(),
    "every recorded result should have been announced through onCase",
  );
});

test("a pass that never opened still skips the cases it would have skipped", async () => {
  // control-lines is inapplicable unless the user says they jumpered them.
  // Reporting it as FAIL sends them checking hardware they were told was
  // optional, and inflates the failure count.
  const port = createEchoPort({ faults: { failReopen: true } });
  const summary = await runLoopbackSuite(port, SINGLE_BAUD);

  assert.deepEqual(statusOf(summary, "control-lines"), ["skip"]);
  assert.match(resultsFor(summary, "control-lines")[0].detail, /control-line jumpers/);
});

test("a port that opens but yields no streams is closed again and named accurately", async () => {
  // Leaving a half-open port claimed breaks every later pass and any second
  // run in the same page load.
  const port = createEchoPort();
  const realOpen = port.open.bind(port);
  let closed = 0;
  port.open = async (options) => {
    await realOpen(options);
    port.readable = null; // opened, but unusable
  };
  const realClose = port.close.bind(port);
  port.close = async () => {
    closed += 1;
    await realClose();
  };
  const summary = await runLoopbackSuite(port, { ...SINGLE_BAUD, baudRates: [9600] });

  assert.ok(closed > 0, "a port that opened must be closed even when the session cannot start");
  const detail = resultsFor(summary, "byte-transparency")[0].detail;
  assert.match(detail, /could not start reading from the port at 9600 baud/);
  assert.doesNotMatch(detail, /could not open port/, "the wording must not blame open()");
});

test("the report names each case, its baud rate and why it failed", async () => {
  const healthy = formatLoopbackReport(await runLoopbackSuite(createEchoPort(), SINGLE_BAUD));
  assert.match(healthy, /PASS {2}All 256 byte values survive the round trip @ 115200/);
  assert.match(healthy, /SKIP {2}CTS follows RTS and DSR follows DTR @ 115200 — control-line jumpers/);
  assert.match(healthy, /\d+ passed, 0 failed, 1 skipped$/);

  const faulty = createEchoPort({ faults: { truncateWritesTo: 32 } });
  const report = formatLoopbackReport(await runLoopbackSuite(faulty, SINGLE_BAUD));
  assert.match(report, /FAIL {2}Writes spanning USB packet boundaries stay intact @ 115200 — 63-byte write: /);
});

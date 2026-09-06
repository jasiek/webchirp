import assert from "node:assert/strict";
import test from "node:test";

import {
  createBootstrapCrashReporter,
  createRuntimeBootstrap,
  isBootstrapFailure,
  markBootstrapFailure,
} from "../web/js/runtime-bootstrap.mjs";

// Regression tests for issue #99: the RPC layer classified a runtime crash by
// checking whether the pyodide handle was still unset, which misread an ordinary
// pre-boot network failure as a crash and missed a real failure to seed the
// runtime bridge. It also cached the rejected bootstrap promise for the life of
// the page, so nothing could retry.

test("an error raised outside the bootstrap is not a bootstrap failure", () => {
  // The driver-index fetch is plain HTTP and runs before Pyodide loads; a
  // blocked CDN must read as a network error, not as RUNTIME CRASH.
  assert.equal(isBootstrapFailure(new Error("Failed to fetch")), false);
  assert.equal(isBootstrapFailure("not an object"), false);
  assert.equal(isBootstrapFailure(null), false);
  assert.equal(isBootstrapFailure(undefined), false);
});

test("a failure loading the runtime is reported as a bootstrap failure", async () => {
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      throw new Error("loadPyodide failed");
    },
  });

  const error = await bootstrap.ensure().then(
    () => null,
    (rejected) => rejected,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message, "loadPyodide failed");
  assert.equal(isBootstrapFailure(error), true);
  assert.equal(bootstrap.getRuntime(), null);
});

test("a failure seeding the bridge is a bootstrap failure and hides the runtime", async () => {
  // The case the old !pyodide check could never see: the interpreter loaded, so
  // the handle was already assigned, but the runtime bridge never seeded.
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      const loaded = { id: "pyodide" };
      await Promise.resolve();
      throw Object.assign(new Error("seedPyodideRuntime failed"), { loaded });
    },
  });

  const error = await bootstrap.ensure().then(
    () => null,
    (rejected) => rejected,
  );
  assert.equal(isBootstrapFailure(error), true);
  // A half-built interpreter must never be observable.
  assert.equal(bootstrap.getRuntime(), null);
});

test("a non-Error throw is normalized so it can still be classified", async () => {
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      throw "pyodide exploded";
    },
  });

  const error = await bootstrap.ensure().then(
    () => null,
    (rejected) => rejected,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message, "pyodide exploded");
  assert.equal(isBootstrapFailure(error), true);
});

test("a failed bootstrap is retried rather than cached for the session", async () => {
  let calls = 0;
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient CDN failure");
      }
      return { id: "pyodide" };
    },
  });

  await assert.rejects(bootstrap.ensure(), /transient CDN failure/);
  const runtime = await bootstrap.ensure();

  assert.equal(calls, 2);
  assert.deepEqual(runtime, { id: "pyodide" });
  assert.deepEqual(bootstrap.getRuntime(), { id: "pyodide" });
});

test("a successful bootstrap runs once and is reused", async () => {
  let calls = 0;
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      calls += 1;
      return { id: "pyodide" };
    },
  });

  const first = await bootstrap.ensure();
  const second = await bootstrap.ensure();

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("concurrent callers share a single bootstrap attempt", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      calls += 1;
      await gate;
      return { id: "pyodide" };
    },
  });

  const pending = Promise.all([bootstrap.ensure(), bootstrap.ensure(), bootstrap.ensure()]);
  release();
  const results = await pending;

  assert.equal(calls, 1);
  assert.equal(results[0], results[2]);
});

test("concurrent callers all see the same bootstrap failure", async () => {
  let calls = 0;
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      calls += 1;
      await Promise.resolve();
      throw new Error("boot failed");
    },
  });

  const results = await Promise.allSettled([bootstrap.ensure(), bootstrap.ensure()]);

  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(isBootstrapFailure(result.reason), true);
  }
});

test("a loadRuntime function is required", () => {
  assert.throws(() => createRuntimeBootstrap({}), /requires a loadRuntime/);
  assert.throws(() => createRuntimeBootstrap(), /requires a loadRuntime/);
});

// The dedup guard: one report per failed attempt, but never at the cost of
// swallowing the next attempt's distinct failure.

test("a second, distinct bootstrap failure is reported rather than swallowed", async () => {
  // The sequence from review of PR #139: loadPyodide fails, the user retries,
  // and this time the runtime loads but seeding the bridge fails. Two different
  // faults, so two reports. A boolean latch cleared on success reported only the
  // first, because a success that could clear it can never be followed by a
  // failure.
  const reported = [];
  const reportCrash = createBootstrapCrashReporter((detail) => reported.push(detail));

  let calls = 0;
  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      calls += 1;
      throw new Error(calls === 1 ? "loadPyodide failed" : "seedPyodideRuntime failed");
    },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const error = await bootstrap.ensure().then(
      () => null,
      (rejected) => rejected,
    );
    assert.equal(reportCrash(error, error.message), true);
  }

  assert.deepEqual(reported, ["loadPyodide failed", "seedPyodideRuntime failed"]);
});

test("every call queued behind one failed attempt reports that failure once", async () => {
  const reported = [];
  const reportCrash = createBootstrapCrashReporter((detail) => reported.push(detail));

  const bootstrap = createRuntimeBootstrap({
    loadRuntime: async () => {
      await Promise.resolve();
      throw new Error("boot failed");
    },
  });

  const settled = await Promise.allSettled([
    bootstrap.ensure(),
    bootstrap.ensure(),
    bootstrap.ensure(),
  ]);

  // Each queued caller asks; only the first ask reports, and every ask returns
  // true so none of them lets the action funnel capture the failure again.
  for (const result of settled) {
    assert.equal(reportCrash(result.reason, result.reason.message), true);
  }
  assert.deepEqual(reported, ["boot failed"]);
});

test("the reporter ignores errors that did not come from the bootstrap", () => {
  const reported = [];
  const reportCrash = createBootstrapCrashReporter((detail) => reported.push(detail));

  // A blocked driver-index fetch must reach the ordinary action funnel, so the
  // reporter both declines to report it and declines to claim it as reported.
  assert.equal(reportCrash(new Error("Failed to fetch"), "Failed to fetch"), false);
  assert.deepEqual(reported, []);
});

test("a reportCrash function is required", () => {
  assert.throws(() => createBootstrapCrashReporter(), /requires a reportCrash/);
  assert.throws(() => createBootstrapCrashReporter(null), /requires a reportCrash/);
});

test("marking carries the classification onto a rethrown error", () => {
  // runtime-rpc.js rethrows a fresh Error out of the runtime; without the mark
  // the action funnel sees an ordinary failure and captures it a second time.
  const outgoing = markBootstrapFailure(new Error("RuntimeError: boot failed"));
  assert.equal(isBootstrapFailure(outgoing), true);
  assert.equal(isBootstrapFailure(new Error("RuntimeError: boot failed")), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeBootstrap, isBootstrapFailure } from "../web/js/runtime-bootstrap.mjs";

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

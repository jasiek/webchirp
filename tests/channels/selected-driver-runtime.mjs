import assert from "node:assert/strict";
import test from "node:test";
import { createSelectedDriverRuntime } from "../../web/js/selected-driver-runtime.mjs";

test("isolated release changes discard old registry and clone cache", async () => {
  let boots = 0;
  const runtime = createSelectedDriverRuntime({
    isolated: true,
    loadRuntime: async () => ({ id: ++boots, cache: new Map() }),
  });
  const initial = await runtime.ensure();
  const first = await runtime.select("v5");
  assert.equal(first, initial);
  first.cache.set("image", "v5 clone");
  assert.equal(await runtime.select("v5"), first);
  const second = await runtime.select("v6");
  assert.notEqual(second, first);
  assert.equal(second.cache.size, 0);
  assert.equal(await runtime.ensure(), second);
  const returned = await runtime.select("v5");
  assert.notEqual(returned, first);
  assert.equal(returned.cache.size, 0);
  assert.equal(boots, 3);
});

test("ordinary CHIRP selections share their registry and clone cache", async () => {
  let boots = 0;
  const runtime = createSelectedDriverRuntime({ loadRuntime: async () => ({ id: ++boots }) });
  assert.equal(await runtime.select("uv5r"), await runtime.select("uvk5"));
  assert.equal(boots, 1);
});

test("a failed release switch can retry without publishing a broken runtime", async () => {
  let fail = false;
  const runtime = createSelectedDriverRuntime({
    isolated: true,
    loadRuntime: async () => {
      if (fail) throw new Error("Bootstrap failed");
      return {};
    },
  });
  const first = await runtime.select("v5");
  fail = true;
  await assert.rejects(runtime.select("v6"), /Bootstrap failed/);
  assert.equal(await runtime.ensure(), first);
  fail = false;
  assert.notEqual(await runtime.select("v6"), first);
});

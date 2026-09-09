import assert from "node:assert/strict";
import test from "node:test";

import { createCallQueue } from "../../web/js/call-queue.mjs";

test("createCallQueue runs tasks strictly one at a time in FIFO order", async () => {
  const enqueue = createCallQueue();
  let active = 0;
  let maxActive = 0;
  const events = [];

  const task = (name, delayMs) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    events.push(`end:${name}`);
    return name;
  };

  const results = await Promise.all([
    enqueue(task("a", 20)),
    enqueue(task("b", 5)),
    enqueue(task("c", 0)),
  ]);

  assert.deepEqual(results, ["a", "b", "c"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    "start:a", "end:a",
    "start:b", "end:b",
    "start:c", "end:c",
  ]);
});

test("a rejected task surfaces to its caller and does not block later tasks", async () => {
  const enqueue = createCallQueue();

  await assert.rejects(
    enqueue(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(await enqueue(async () => "ok"), "ok");
});

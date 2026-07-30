import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProgress } from "../web/js/ui/progress.js";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The strip only ever reads/writes textContent, hidden and the <progress> value,
// so a plain object per element is enough to assert on.
function fakeDom() {
  const bar = {
    value: undefined,
    max: 100,
    removeAttribute(name) {
      if (name === "value") {
        this.value = undefined;
      }
    },
  };
  return {
    appProgressEl: { hidden: true },
    appProgressBarEl: bar,
    appProgressLabelEl: { textContent: "" },
    appProgressCountEl: { textContent: "" },
  };
}

test("progress strip stays hidden until an operation begins", () => {
  const dom = fakeDom();
  const progress = createProgress({ dom });
  assert.equal(dom.appProgressEl.hidden, true);
  assert.equal(progress.isVisible(), false);

  const handle = progress.begin("Loading drivers", 4);
  assert.equal(dom.appProgressEl.hidden, false);
  assert.equal(progress.isVisible(), true);
  assert.equal(dom.appProgressLabelEl.textContent, "Loading drivers");

  handle.end();
  assert.equal(dom.appProgressEl.hidden, true);
  assert.equal(progress.isVisible(), false);
});

test("progress reports a count and a percentage against a known total", () => {
  const dom = fakeDom();
  const handle = createProgress({ dom }).begin("Loading drivers", 200);

  handle.update(50);
  assert.equal(dom.appProgressBarEl.value, 25);
  assert.equal(dom.appProgressCountEl.textContent, "50 / 200");

  handle.update(200);
  assert.equal(dom.appProgressBarEl.value, 100);
  assert.equal(dom.appProgressCountEl.textContent, "200 / 200");
});

// An operation reporting past its own total would otherwise drive the bar over
// 100% and print a count like "201 / 200".
test("progress clamps a count that overshoots the total", () => {
  const dom = fakeDom();
  const handle = createProgress({ dom }).begin("Loading drivers", 10);
  handle.update(99);
  assert.equal(dom.appProgressBarEl.value, 100);
  assert.equal(dom.appProgressCountEl.textContent, "10 / 10");
});

// Without a total the bar must stay indeterminate rather than show a stale or
// invented percentage.
test("progress with no usable total leaves the bar indeterminate", () => {
  const dom = fakeDom();
  const handle = createProgress({ dom }).begin("Working", 0);
  assert.equal(dom.appProgressBarEl.value, undefined);
  assert.equal(dom.appProgressCountEl.textContent, "");
  handle.update(5);
  assert.equal(dom.appProgressBarEl.value, undefined);
});

// A slow operation finishing after a newer one started must not tear down or
// repaint the strip the newer one owns.
test("a stale handle cannot update or hide a newer operation's strip", () => {
  const dom = fakeDom();
  const progress = createProgress({ dom });
  const first = progress.begin("First", 10);
  const second = progress.begin("Second", 10);

  first.update(5, "First again");
  assert.equal(dom.appProgressLabelEl.textContent, "Second");
  assert.equal(dom.appProgressCountEl.textContent, "0 / 10");

  first.end();
  assert.equal(dom.appProgressEl.hidden, false, "stale end must not hide the strip");

  second.update(5);
  assert.equal(dom.appProgressCountEl.textContent, "5 / 10");
  second.end();
  assert.equal(dom.appProgressEl.hidden, true);
});

test("import_all_driver_modules reports progress once per module, failures included", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const calls = [];
  harness.pyodide.globals.set("_cb", (done, total, name) => calls.push([done, total, name]));
  harness.pyodide.globals.set("_mods", ["uv5r", "definitely_not_a_driver", "ft60"]);
  const result = JSON.parse(
    await harness.pyodide.runPythonAsync("json.dumps(import_all_driver_modules(_mods, _cb))"),
  );

  assert.equal(result.imported, 2);
  assert.deepEqual(Object.keys(result.failed), ["definitely_not_a_driver"]);
  // 1-indexed, so the last call is always done === total and the bar reaches 100%.
  assert.deepEqual(calls, [
    [1, 3, "uv5r"],
    [2, 3, "definitely_not_a_driver"],
    [3, 3, "ft60"],
  ]);
});

// Progress is a diagnostic: it must never be able to abort the sweep it reports
// on, and the argument must stay optional for callers that want no reporting.
test("import_all_driver_modules survives a throwing progress callback", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  harness.pyodide.globals.set("_bad", () => {
    throw new Error("progress sink exploded");
  });
  const thrown = JSON.parse(
    await harness.pyodide.runPythonAsync(
      "json.dumps(import_all_driver_modules(['uv5r', 'ft60'], _bad))",
    ),
  );
  assert.equal(thrown.imported, 2);

  const omitted = JSON.parse(
    await harness.pyodide.runPythonAsync("json.dumps(import_all_driver_modules(['uv5r']))"),
  );
  assert.equal(omitted.imported, 1);
});

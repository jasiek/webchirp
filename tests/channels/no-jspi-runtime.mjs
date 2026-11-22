import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../support/repo-paths.mjs";

// A browser without WebAssembly stack switching (JSPI) still boots the
// runtime and loads files; only the clone path, which blocks on the serial
// bridge through Pyodide's run_sync, is lost. The UI's refusal at Connect is
// covered by clone-button-gating.mjs; this is the runtime side of it, run in
// a Node with JSPI switched off. V8 flags given to node --test never reach
// the per-file child processes, so the flag goes to a child of our own,
// which boots the harness once and reports what worked.
const PROBE = path.join(repoRoot, "tests", "support", "no-jspi-probe.mjs");
const STACK_SWITCHING_ERROR = "WebAssembly stack switching not supported in this JavaScript runtime";

function runProbeWithoutJspi() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--no-experimental-wasm-jspi", PROBE],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`no-JSPI probe failed: ${error.message}\n${stderr}`));
          return;
        }
        // The runtime logs serial diagnostics to stdout too; the report is
        // the last line.
        const lines = stdout.trim().split("\n");
        resolve(JSON.parse(lines.at(-1) || "null"));
      },
    );
  });
}

test("without JSPI only the clone path fails, and Python can tell beforehand", async () => {
  const report = await runProbeWithoutJspi();

  assert.deepEqual(report.canRunSync, { ok: true, value: false });
  assert.deepEqual(report.runSync, {
    ok: true,
    value: { raised: "RuntimeError", message: STACK_SWITCHING_ERROR },
  });

  // A download reaches the browser as that RuntimeError, not as a radio
  // failure: the runtime never got as far as talking to the radio.
  assert.deepEqual(report.download, { ok: false, name: "RuntimeError", message: STACK_SWITCHING_ERROR });

  // Loading an image file needs no serial port, so it works as usual.
  assert.equal(report.imageLoad.ok, true, `image load failed: ${report.imageLoad.message}`);
  assert.equal(report.imageLoad.value.module, "uv5r");
  assert.ok(report.imageLoad.value.rows > 0, "the loaded image should have channel rows");
});

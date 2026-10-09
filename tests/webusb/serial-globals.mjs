import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SERIAL_GLOBAL_NAMES,
  installSerialBridgeGlobals,
} from "../../web/js/serial-globals.ts";
import { repoRoot } from "../support/repo-paths.mjs";

// The serial_* functions Python imports from js are defined once, by
// web/js/serial-globals.ts, for both the browser and the Node harness. These
// tests pin that list against the Python-side declaration and pin the
// argument normalisation both environments now share.

const TYPINGS_PATH = path.join(repoRoot, "web/python/typings/js.pyi");

// The serial_* names js.pyi declares, as Python sees them.
function declaredSerialGlobals() {
  const text = fs.readFileSync(TYPINGS_PATH, "utf8");
  return [...text.matchAll(/^def (serial_\w+)\(/gm)].map((match) => match[1]).sort();
}

// The serial_* names the Python bridge actually imports from js.
function importedSerialGlobals() {
  const dir = path.join(repoRoot, "web/python/webchirp_bridge");
  const names = new Set();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".py"))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const block of text.matchAll(/^from js import (\([^)]*\)|[^\n]+)/gm)) {
      for (const name of block[1].matchAll(/serial_\w+/g)) {
        names.add(name[0]);
      }
    }
  }
  return [...names].sort();
}

test("the installer defines exactly the serial globals js.pyi declares", () => {
  assert.deepEqual([...SERIAL_GLOBAL_NAMES].sort(), declaredSerialGlobals());
});

test("every serial global the Python bridge imports is installed", () => {
  const installed = new Set(SERIAL_GLOBAL_NAMES);
  const missing = importedSerialGlobals().filter((name) => !installed.has(name));
  assert.deepEqual(missing, []);
});

test("each global sends one normalised message to the handler", async () => {
  const sent = [];
  const target = installSerialBridgeGlobals({}, async (msg) => {
    sent.push(msg);
    return { ok: true };
  });

  await target.serial_read_bytes(undefined, undefined);
  await target.serial_prepare_clone(1, 0, 0, undefined);
  await target.serial_set_signals(null, 1);
  await target.serial_reconfigure(57600, null, 2, undefined);
  await target.serial_reset_buffers();

  assert.deepEqual(sent, [
    { op: "readBytes", payload: { count: 1, timeoutMs: 1200 } },
    { op: "prepareClone", payload: { wantsDtr: true, wantsRts: false, settleMs: 350, baudRate: 0 } },
    { op: "setSignals", payload: { dataTerminalReady: null, requestToSend: true } },
    { op: "reconfigure", payload: { options: { baudRate: 57600, stopBits: 2 } } },
    { op: "resetBuffers", payload: {} },
  ]);
});

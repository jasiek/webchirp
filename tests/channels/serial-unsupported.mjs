import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSerialBridge } from "../../web/js/serial.ts";
import { isIgnoredError } from "../../web/js/sentry.ts";
import { isSerialUnsupported } from "../../web/js/serial-errors.ts";
import { withNavigator } from "../support/globals.mjs";
import { createTestRadioHarness } from "../support/radio-harness.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

test("unsupported serial transports remain filtered after crossing the Pyodide RPC boundary", async (t) => {
  const bridge = new BrowserSerialBridge();
  // Boot with the real navigator before removing its transport APIs: this
  // exercises the production Python-to-JS serial call without altering boot.
  const harness = await createTestRadioHarness({ repoRoot, serialBridge: bridge });
  withNavigator(t, {});

  for (const [transport, sentence] of [
    ["auto", "Neither Web Serial nor WebUSB is supported in this browser."],
    ["webserial", "Native Web Serial is not supported in this browser."],
    ["webusb", "WebUSB is not supported in this browser."],
    ["webbluetooth", "Web Bluetooth is not supported in this browser."],
  ]) {
    await t.test(transport, async () => {
      bridge.setPreferredTransport(transport);
      await assert.rejects(
        () => harness.rpc("webserial_connect", { baudrate: 9600 }),
        (error) => {
          // Inspect the real envelope and traceback so transport naming stays
          // recognizable after crossing the Python-to-JS runtime boundary.
          assert.equal(error.pythonType, "JsException");
          assert.equal(error.jsCause.name, "SerialUnsupportedError");
          assert.ok(isSerialUnsupported(error));
          assert.ok(isIgnoredError(error));
          const message = error.pythonTraceback;
          assert.match(message, /pyodide\.ffi\.JsException/);
          assert.match(message, /SerialUnsupportedError/);
          assert.ok(message.includes(sentence), message);
          return true;
        },
      );
    });
  }
});

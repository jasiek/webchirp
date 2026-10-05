import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSerialBridge } from "../../web/js/serial.js";
import { initOptions } from "../../web/js/sentry.js";
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
          // Inspect Pyodide's actual flattened traceback, so changes to JS
          // error naming cannot silently break the Sentry filtering contract.
          const message = String(error.message || error);
          assert.match(message, /pyodide\.ffi\.JsException/);
          assert.match(message, /SerialUnsupportedError/);
          assert.ok(message.includes(sentence), message);
          assert.ok(
            initOptions().ignoreErrors.some((pattern) => pattern.test(message)),
            "the unsupported-browser traceback should be filtered out of Sentry",
          );
          return true;
        },
      );
    });
  }
});

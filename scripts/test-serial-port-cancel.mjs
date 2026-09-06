import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSerialBridge } from "../web/js/serial.js";
import {
  PORT_SELECTION_CANCELLED,
  PORT_SELECTION_CANCELLED_MESSAGE,
  isPortSelectionCancelled,
} from "../web/js/serial-errors.js";
import { classifyErrorKind, errorTypeName } from "../web/js/ui/analytics.js";
import { createDebugLog } from "../web/js/ui/debug-log.js";

// Pressing Cancel in the browser's port chooser used to arrive at the UI as a
// Pyodide traceback, which the app dumped into the Debug Output panel -- so the
// only signal that the click had done anything at all was an unreadable stack.
// These cover the outcome end to end: the bridge names it, the runtime keeps it
// named, and the UI says it in a sentence without filing it as a bug.

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

// Chrome rejects a dismissed chooser with a DOMException; Node has no
// DOMException constructor guarantee across versions worth relying on here, so
// build something with the same observable shape.
function chooserDismissal(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  return error;
}

test("a dismissed native Web Serial chooser becomes a named cancellation", async () => {
  setNavigator({
    serial: {
      requestPort: async () => {
        throw chooserDismissal("No port selected by the user.");
      },
    },
  });
  const bridge = new BrowserSerialBridge();

  const error = await bridge.open(9600).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error, "open() must reject when the chooser is dismissed");
  assert.equal(error.name, PORT_SELECTION_CANCELLED);
  assert.equal(error.message, PORT_SELECTION_CANCELLED_MESSAGE);
  assert.equal(isPortSelectionCancelled(error), true);
  // Nothing half-open is left behind for the next connect.
  assert.equal(bridge.port, null);
  assert.equal(bridge.writer, null);
});

test("a dismissed WebUSB device chooser becomes the same cancellation", async () => {
  setNavigator({ usb: {} });
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({
      requestPort: async () => {
        throw chooserDismissal("No device selected.");
      },
    }),
  });
  bridge.setPreferredTransport("webusb");

  const error = await bridge.open(9600).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error?.name, PORT_SELECTION_CANCELLED);
});

test("a real chooser failure is left alone", async () => {
  // Only NotFoundError means "dismissed". A permissions-policy refusal is a
  // genuine failure and must keep its own name and message.
  const refusal = new Error("Permissions policy blocks serial");
  refusal.name = "SecurityError";
  setNavigator({
    serial: {
      requestPort: async () => {
        throw refusal;
      },
    },
  });
  const bridge = new BrowserSerialBridge();

  const error = await bridge.open(9600).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error?.name, "SecurityError");
  assert.equal(isPortSelectionCancelled(error), false);
});

test("the cancellation is still recognizable after the runtime flattens it", () => {
  // What reaches the UI once the error has crossed Pyodide: the name is gone
  // and the sentence is one line of a Python traceback.
  const flattened = new Error(
    [
      "Traceback (most recent call last):",
      '  File "<exec>", line 1, in <module>',
      '  File "/lib/python3.12/site-packages/runtime_bridge.py", line 1162, in webserial_connect',
      "    result = await serial_open(int(baudrate))",
      `pyodide.ffi.JsException: ${PORT_SELECTION_CANCELLED}: ${PORT_SELECTION_CANCELLED_MESSAGE}`,
    ].join("\n"),
  );

  assert.equal(isPortSelectionCancelled(flattened), true);
  // And the analytics classification the connect path already relied on keeps
  // working off the same sentence.
  assert.equal(classifyErrorKind(flattened), "port_not_selected");
});

test("a named cancellation still reports a usable error_type", () => {
  const error = new Error(PORT_SELECTION_CANCELLED_MESSAGE);
  error.name = PORT_SELECTION_CANCELLED;
  assert.equal(classifyErrorKind(error), "port_not_selected");
  assert.equal(errorTypeName(error), PORT_SELECTION_CANCELLED);
});

class FakeElement {
  constructor({ hidden = false } = {}) {
    this.attributes = new Map();
    this.hidden = hidden;
    this.disabled = false;
    this.title = "";
    this.textContent = "";
    this.value = "";
  }

  addEventListener(type, handler) {
    if (type === "click") {
      this.listener = handler;
    }
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
}

function fakeDebugDom() {
  const debugToggleEl = new FakeElement();
  debugToggleEl.setAttribute("aria-expanded", "false");
  return {
    debugToggleEl,
    debugActionsEl: new FakeElement({ hidden: true }),
    debugOutputContentEl: new FakeElement({ hidden: true }),
    debugOutputEl: new FakeElement(),
    debugClearEl: new FakeElement(),
    debugCopyEl: new FakeElement(),
  };
}

test("a cancellation opens the debug panel without becoming the next bug report", () => {
  const dom = fakeDebugDom();
  const log = createDebugLog({ dom });
  log.bindEvents();

  log.reportActionCancelled("Serial connect", PORT_SELECTION_CANCELLED_MESSAGE);

  // Seen: the panel is the app's only visible surface for a message.
  assert.equal(dom.debugToggleEl.getAttribute("aria-expanded"), "true");
  assert.equal(dom.debugOutputContentEl.hidden, false);
  assert.match(dom.debugOutputEl.value, /SERIAL CONNECT CANCELLED/);
  assert.match(dom.debugOutputEl.value, /No port selected/);
  // But not filed: Report Bug must not be titled after something the user
  // chose to do.
  assert.equal(log.getLastErrorSummary(), "");
});

function makeSerialActionsContext(connectError) {
  const dom = {
    serialConnectToggleEl: new FakeElement(),
    webusbConnectToggleEl: new FakeElement(),
    radioDownloadEl: new FakeElement(),
    radioUploadEl: new FakeElement(),
    liveRadioSupportWarningEl: new FakeElement(),
    unsupportedBrowserContinueEl: new FakeElement(),
    sidebarControlEls: [],
  };
  dom.sidebarControlEls = [
    dom.serialConnectToggleEl,
    dom.webusbConnectToggleEl,
    dom.radioDownloadEl,
    dom.radioUploadEl,
  ];
  const calls = { cancelled: [], errors: [], serial: [] };
  return {
    calls,
    ctx: {
      dom,
      state: {
        selectedRadio: { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5R" },
        runtimeApi: {
          serialConnect: async () => {
            throw connectError;
          },
          serialDisconnect: async () => ({ connected: false, message: "bye" }),
        },
      },
      log: {
        setStatus() {},
        logDebug() {},
        logSerial(line) {
          calls.serial.push(line);
        },
        reportActionError(action, error) {
          calls.errors.push([action, error]);
        },
        reportActionCancelled(action, message) {
          calls.cancelled.push([action, message]);
        },
      },
      actions: {},
      settings: { hasInvalidSettings: () => false },
    },
  };
}

test("connect reports a dismissed chooser as a cancellation, not a crash", async () => {
  setNavigator({ userAgent: "FakeBrowser/1.0", maxTouchPoints: 0 });
  const { createSerialActions } = await import("../web/js/ui/serial-actions.js");

  const cancelled = new Error(PORT_SELECTION_CANCELLED_MESSAGE);
  cancelled.name = PORT_SELECTION_CANCELLED;
  const { ctx, calls } = makeSerialActionsContext(cancelled);
  const serial = createSerialActions(ctx);
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();

  await ctx.dom.serialConnectToggleEl.listener();

  assert.deepEqual(calls.cancelled, [["Serial connect", PORT_SELECTION_CANCELLED_MESSAGE]]);
  assert.deepEqual(calls.errors, []);
  // The cancellation says itself once; the traceback line the failure path
  // writes to the serial log would only repeat it.
  assert.deepEqual(calls.serial, []);
  // The button is usable again and still says Connect: no port was opened.
  assert.equal(ctx.dom.serialConnectToggleEl.disabled, false);
  assert.equal(ctx.dom.serialConnectToggleEl.textContent, "Connect via WebSerial");
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
});

test("connect still reports a genuine open failure as an error", async () => {
  setNavigator({ userAgent: "FakeBrowser/1.0", maxTouchPoints: 0 });
  const { createSerialActions } = await import("../web/js/ui/serial-actions.js");

  const { ctx, calls } = makeSerialActionsContext(new Error("Failed to open serial port."));
  const serial = createSerialActions(ctx);
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();

  await ctx.dom.serialConnectToggleEl.listener();

  assert.deepEqual(calls.cancelled, []);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], "Serial connect");
});

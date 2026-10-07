import assert from "node:assert/strict";
import test from "node:test";

import { FakeElement } from "../support/fake-dom.mjs";
import { makeWindow } from "../support/fake-window.mjs";
import { fakeSentryTracing } from "../support/fake-sentry-tracing.mjs";
import { initSentry, resetSentryForTests } from "../../web/js/sentry.js";
import { createSerialUnsupportedError } from "../../web/js/serial-errors.js";

// The clone buttons must stay dead until a serial port has actually been
// opened: pressing Download with no port only ever produced a runtime error.

// Presses the connect toggle and waits for its click handler to finish.
function pressConnectToggle(ctx) {
  return ctx.dom.serialConnectToggleEl.dispatch("click");
}

// Build a serial action context with independently selectable connection results.
function makeContext({ hasInvalidSettings = false, transport = "webserial" } = {}) {
  const dom = {
    serialConnectToggleEl: new FakeElement(),
    webusbConnectToggleEl: new FakeElement(),
    webbluetoothConnectToggleEl: new FakeElement(),
    radioDownloadEl: new FakeElement(),
    radioUploadEl: new FakeElement(),
    liveRadioSupportWarningEl: new FakeElement(),
    unsupportedBrowserContinueEl: new FakeElement(),
    sidebarControlEls: [],
  };
  dom.sidebarControlEls = [
    dom.serialConnectToggleEl,
    dom.webusbConnectToggleEl,
    dom.webbluetoothConnectToggleEl,
    dom.radioDownloadEl,
    dom.radioUploadEl,
  ];
  const state = {
    selectedRadio: { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5R" },
    runtimeApi: {
      serialConnect: async () => ({ connected: true, transport, message: "ok" }),
      serialDisconnect: async () => ({ connected: false, message: "bye" }),
    },
  };
  return {
    dom,
    state,
    log: {
      setStatus() {},
      logSerial() {},
      logDebug() {},
      reportActionError() {},
    },
    actions: {},
    settings: { hasInvalidSettings: () => hasInvalidSettings },
  };
}

// Set the platform before importing UI helpers so each case controls visibility.
async function loadSerialActions(userAgent = "FakeBrowser/1.0") {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent, maxTouchPoints: 0 },
  });
  const { createSerialActions } = await import("../../web/js/ui/serial-actions.js");
  return createSerialActions;
}

test("clone buttons stay disabled until a serial port is connected", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, setPreferredTransport() {} });

  // Sidebar enabled after init, but no port picked yet.
  serial.setSidebarControlsEnabled(true);
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.radioDownloadEl.title, "Connect to a serial port first");
  assert.equal(ctx.dom.radioUploadEl.title, "Connect to a serial port first");
  // The connect controls themselves stay usable — that is how a port is picked.
  assert.equal(ctx.dom.serialConnectToggleEl.disabled, false);

  serial.bindEvents();
  await pressConnectToggle(ctx);
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
  assert.equal(ctx.dom.radioUploadEl.disabled, false);
  assert.equal(ctx.dom.radioDownloadEl.title, "");
  assert.equal(ctx.dom.radioUploadEl.title, "");

  // Disconnecting takes them away again.
  await pressConnectToggle(ctx);
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
});

test("a browser with no transport keeps Connect disabled with an explanation", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: false, native: false, webusb: false, webbluetooth: false } });
  serial.setSidebarControlsEnabled(true);
  assert.equal(ctx.dom.serialConnectToggleEl.hidden, false);
  for (const button of [ctx.dom.serialConnectToggleEl, ctx.dom.webusbConnectToggleEl, ctx.dom.webbluetoothConnectToggleEl]) {
    assert.equal(button.disabled, true);
  }
  assert.match(ctx.dom.serialConnectToggleEl.title, /no supported serial transport API/);
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
});

test("unsupported transports never count as failed connects while adapter failures do", async (t) => {
  const createSerialActions = await loadSerialActions();
  resetSentryForTests();
  t.after(resetSentryForTests);
  const metrics = [];
  await initSentry(makeWindow(), { loadSdk: async () => ({
    ...fakeSentryTracing,
    init() {},
    metrics: { count: (name, value, options) => metrics.push({ name, value, ...options }) },
  }) });
  const named = createSerialUnsupportedError("Transport unavailable.");
  for (const error of [named, new Error(`pyodide.ffi.JsException: ${named}`), new Error("Adapter open failed")]) {
    const ctx = makeContext();
    const errors = [];
    ctx.log.reportActionError = (action, thrown) => errors.push(thrown);
    ctx.state.runtimeApi.serialConnect = async () => { throw error; };
    const serial = createSerialActions(ctx);
    serial.setSerialController({ capability: { supported: true, native: true }, setPreferredTransport() {} });
    serial.setSidebarControlsEnabled(true);
    serial.bindEvents();
    await pressConnectToggle(ctx);
    assert.equal(errors.length, error.message === "Adapter open failed" ? 1 : 0);
  }
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].attributes.flow, "serial_connect");
  assert.equal(metrics[0].attributes.outcome, "failed");
});

test("a connected port does not override the other clone-button blocks", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext({ hasInvalidSettings: true });
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, setPreferredTransport() {} });
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  await pressConnectToggle(ctx);

  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.title, "Fix invalid radio settings before upload");

  // A live-mode radio blocks both regardless of the connection.
  ctx.state.selectedRadio = { ...ctx.state.selectedRadio, isLiveRadio: true };
  serial.updateSerialActionState();
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(
    ctx.dom.radioDownloadEl.title,
    "Live-mode radios are not supported in this UI yet",
  );
});

test("losing the port mid-session takes the clone buttons away again", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, setPreferredTransport() {} });
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  await pressConnectToggle(ctx);
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);

  // The bridge reports the adapter as gone; it has already closed the port.
  serial.handlePortLost("USB VID:PID 0x0403:0x6015");
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.radioDownloadEl.title, "Connect to a serial port first");
  // The toggle has to offer a way back in, not read "Disconnect".
  assert.equal(ctx.dom.serialConnectToggleEl.textContent, "Connect via WebSerial");

  // Reconnecting brings them back.
  await pressConnectToggle(ctx);
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
});

// A browser without WebAssembly stack switching can boot the runtime and edit
// files -- drivers import from the mounted CHIRP archive -- but CHIRP's clone
// loops block on the serial bridge through Pyodide's run_sync, which needs
// JSPI. The refusal belongs where the user starts a clone, not on an overlay
// at init, and it must name the cause rather than fail inside Python.
test("a browser without JSPI is refused at connect time with the reason", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const statuses = [];
  const serialLog = [];
  ctx.log.setStatus = (message) => statuses.push(message);
  ctx.log.logSerial = (message) => serialLog.push(message);
  let connectCalls = 0;
  ctx.state.runtimeApi.serialConnect = async () => {
    connectCalls += 1;
    return { connected: true, transport: "webserial", message: "ok" };
  };
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, setPreferredTransport() {} });
  serial.setCloneSupported(false);
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();

  await pressConnectToggle(ctx);
  assert.equal(connectCalls, 0, "no port must be opened without JSPI");
  assert.match(statuses.at(-1), /WebAssembly stack switching \(JSPI\)/);
  assert.match(statuses.at(-1), /Editing CSV and image files still works/);
  assert.deepEqual(serialLog, [statuses.at(-1)]);
  assert.equal(ctx.dom.radioDownloadEl.disabled, true, "still no port, so still no clone");

  // The same browser with JSPI connects as before.
  serial.setCloneSupported(true);
  await pressConnectToggle(ctx);
  assert.equal(connectCalls, 1);
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
});

test("WebBluetooth visibility preserves wired transport choices on each platform", async () => {
  for (const { userAgent, capability, visible } of [
    { userAgent: "Desktop", capability: { supported: true, native: true, webusb: true, webbluetooth: true }, visible: [true, false, true] },
    { userAgent: "Android", capability: { supported: true, native: true, webusb: true, webbluetooth: true }, visible: [true, true, true] },
    { userAgent: "Android", capability: { native: false, webusb: true, webbluetooth: true }, visible: [false, true, true] },
    { userAgent: "Desktop", capability: { native: false, webusb: false, webbluetooth: true }, visible: [false, false, true] },
    { userAgent: "Desktop", capability: { supported: true, native: true, webusb: false, webbluetooth: false }, visible: [true, false, false] },
    { userAgent: "Desktop", capability: { native: false, webusb: false, webbluetooth: false }, visible: [true, false, false] },
  ]) {
    const createSerialActions = await loadSerialActions(userAgent);
    const ctx = makeContext();
    const serial = createSerialActions(ctx);
    serial.setSerialController({ capability });
    assert.deepEqual([
      !ctx.dom.serialConnectToggleEl.hidden,
      !ctx.dom.webusbConnectToggleEl.hidden,
      !ctx.dom.webbluetoothConnectToggleEl.hidden,
    ], visible, JSON.stringify({ userAgent, capability }));
  }
});

test("each connected transport leaves exactly its own Disconnect button", async () => {
  for (const transport of ["webserial", "webusb", "webbluetooth"]) {
    const createSerialActions = await loadSerialActions("Android");
    const ctx = makeContext({ transport });
    const serial = createSerialActions(ctx);
    const preferred = [];
    serial.setSerialController({
      capability: { supported: true, native: true, webusb: true, webbluetooth: true },
      setPreferredTransport(value) { preferred.push(value); },
    });
    serial.setSidebarControlsEnabled(true);
    serial.bindEvents();
    const buttons = {
      webserial: ctx.dom.serialConnectToggleEl,
      webusb: ctx.dom.webusbConnectToggleEl,
      webbluetooth: ctx.dom.webbluetoothConnectToggleEl,
    };
    const activeButton = buttons[transport];
    await activeButton.dispatch("click");
    assert.deepEqual(preferred, [transport === "webserial" ? "auto" : transport]);
    assert.deepEqual(Object.values(buttons).filter((button) => !button.hidden), [activeButton]);
    assert.equal(activeButton.textContent, "Disconnect");
    assert.equal(ctx.dom.radioDownloadEl.disabled, false);

    await activeButton.dispatch("click");
    assert.ok(Object.values(buttons).every((button) => !button.hidden));
    assert.equal(ctx.dom.webbluetoothConnectToggleEl.textContent, "Connect via WebBluetooth");
    assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  }
});

test("WebBluetooth follows selection, startup, busy and JSPI restrictions", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext({ transport: "webbluetooth" });
  const serial = createSerialActions(ctx);
  serial.setSerialController({
    capability: { supported: true, native: true, webbluetooth: true },
    setPreferredTransport() {},
  });
  const button = ctx.dom.webbluetoothConnectToggleEl;
  assert.equal(button.disabled, true, "startup blocks BLE too");
  serial.setSidebarControlsEnabled(true);
  assert.equal(button.disabled, false);
  const radio = ctx.state.selectedRadio;
  ctx.state.selectedRadio = null;
  serial.updateSerialActionState();
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Search for and select a radio first");
  ctx.state.selectedRadio = { ...radio, isLiveRadio: true };
  serial.updateSerialActionState();
  assert.equal(button.disabled, true);
  assert.match(button.title, /Live-mode/);
  ctx.state.selectedRadio = radio;
  serial.updateSerialActionState();

  const statuses = [];
  ctx.log.setStatus = (message) => statuses.push(message);
  let finishConnect;
  let connectCalls = 0;
  ctx.state.runtimeApi.serialConnect = () => {
    connectCalls += 1;
    return new Promise((resolve) => { finishConnect = resolve; });
  };
  serial.bindEvents();
  serial.setCloneSupported(false);
  await button.dispatch("click");
  assert.equal(connectCalls, 0);
  assert.match(statuses.at(-1), /JSPI/);

  serial.setCloneSupported(true);
  await button.dispatch("click");
  assert.equal(connectCalls, 1);
  assert.equal(button.disabled, true);
  assert.equal(ctx.dom.serialConnectToggleEl.disabled, true);
  assert.equal(ctx.dom.webusbConnectToggleEl.disabled, true);
  finishConnect({ connected: true, transport: "webbluetooth" });
  await Promise.resolve();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Disconnect");
  serial.handlePortLost("BLE dongle");
  assert.equal(button.textContent, "Connect via WebBluetooth");
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.serialConnectToggleEl.hidden, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage, pageElement } from "../support/index-page.mjs";
import {
  createDeferred,
  dispatch,
  flushMicrotasks,
  selectRadioBySearch,
} from "../support/ui-interactions.mjs";
import { makeWindow } from "../support/fake-window.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";
import { initSentry, resetSentryForTests } from "../../web/js/sentry.ts";
import { createSerialUnsupportedError } from "../../web/js/serial-errors.ts";

// The clone buttons must stay dead until a serial port has actually been
// opened: pressing Download with no port only ever produced a runtime error.
// They must also stay dead while a transfer runs: every runtime call waits
// its turn in one queue, so a second press only lined up another transfer
// behind the first.

// Presses the connect toggle and waits for its click handler to finish.
function pressConnectToggle(ctx) {
  return dispatch(ctx.dom.serialConnectToggleEl, "click");
}

// Build a serial action context with independently selectable connection results.
function makeContext({ hasInvalidSettings = false, transport = "webserial" } = {}) {
  const dom = {
    serialConnectToggleEl: pageElement("serialConnectToggleEl"),
    webusbConnectToggleEl: pageElement("webusbConnectToggleEl"),
    webbluetoothConnectToggleEl: pageElement("webbluetoothConnectToggleEl"),
    radioDownloadEl: pageElement("radioDownloadEl"),
    radioUploadEl: pageElement("radioUploadEl"),
    liveRadioSupportWarningEl: pageElement("liveRadioSupportWarningEl"),
    unsupportedBrowserContinueEl: pageElement("unsupportedBrowserContinueEl"),
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
  installIndexPage({ navigator: { userAgent, maxTouchPoints: 0 } });
  const { createSerialActions } = await import("../../web/js/ui/serial-actions.ts");
  return createSerialActions;
}

test("clone buttons stay disabled until a serial port is connected", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });

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
    serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
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
  serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
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
  serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
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

// The bridge reports a loss the moment it happens, while the connect's result
// is still crossing the runtime. Ignored as "not connected yet", that report
// was then overtaken by the result, and the clone buttons came on against a
// port the bridge had already dropped.
test("a port lost before the connect's result arrives leaves the clone buttons off", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const statuses = [];
  ctx.log.setStatus = (message) => statuses.push(message);
  let serial = null;
  ctx.state.runtimeApi.serialConnect = async () => {
    serial.handlePortLost("USB VID:PID 0x0403:0x6015");
    return { connected: true, transport: "webserial", message: "Connected at 9600 baud" };
  };
  serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();

  await pressConnectToggle(ctx);

  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.serialConnectToggleEl.textContent, "Connect via WebSerial");
  assert.equal(statuses.at(-1), "Serial port disconnected; reconnect to continue.");

  // A loss heard while no connect was running is still nobody's: the next
  // connect starts clean.
  serial.handlePortLost("USB VID:PID 0x0403:0x6015");
  ctx.state.runtimeApi.serialConnect = async () => ({ connected: true, transport: "webserial", message: "ok" });
  await pressConnectToggle(ctx);
  assert.equal(ctx.dom.radioUploadEl.disabled, false);
});

test("a port lost to a failed mid-clone settings change says so", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const statuses = [];
  ctx.log.setStatus = (message) => statuses.push(message);
  const serial = createSerialActions(ctx);
  serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  await pressConnectToggle(ctx);

  serial.handlePortLost("USB VID:PID 0x0403:0x6015", "reconfigure");

  assert.equal(
    statuses.at(-1),
    "Serial port closed after the radio's driver changed its settings; reconnect to continue.",
  );
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
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
  serial.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
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
      async choosePort(value) { preferred.push(value); },
    });
    serial.setSidebarControlsEnabled(true);
    serial.bindEvents();
    const buttons = {
      webserial: ctx.dom.serialConnectToggleEl,
      webusb: ctx.dom.webusbConnectToggleEl,
      webbluetooth: ctx.dom.webbluetoothConnectToggleEl,
    };
    const activeButton = buttons[transport];
    await dispatch(activeButton, "click");
    assert.deepEqual(preferred, [transport === "webserial" ? "auto" : transport]);
    assert.deepEqual(Object.values(buttons).filter((button) => !button.hidden), [activeButton]);
    assert.equal(activeButton.textContent, "Disconnect");
    assert.equal(ctx.dom.radioDownloadEl.disabled, false);

    await dispatch(activeButton, "click");
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
    async choosePort() {},
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
  await dispatch(button, "click");
  assert.equal(connectCalls, 0);
  assert.match(statuses.at(-1), /JSPI/);

  serial.setCloneSupported(true);
  // Left pending: the click's connect is held in the runtime until finishConnect.
  const clicked = dispatch(button, "click");
  await flushMicrotasks();
  assert.equal(connectCalls, 1);
  assert.equal(button.disabled, true);
  assert.equal(ctx.dom.serialConnectToggleEl.disabled, true);
  assert.equal(ctx.dom.webusbConnectToggleEl.disabled, true);
  finishConnect({ connected: true, transport: "webbluetooth" });
  await clicked;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Disconnect");
  serial.handlePortLost("BLE dongle");
  assert.equal(button.textContent, "Connect via WebBluetooth");
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.serialConnectToggleEl.hidden, false);
});

const CLONE_RUNNING_TITLE = "A radio transfer is already running";
const CLONE_CATALOG = [{
  vendor: "Acme", model: "Clone", variant: "",
  module: "acme", className: "Radio", key: "acme:Radio", isLiveRadio: false,
}];
const CLONE_HEADERS = ["Location", "Name"];
// One radio-wide setting, so the radio has a settings summary: the upload
// preflight repaints it, and repainting it re-runs updateSerialActionState()
// in the middle of the transfer.
const CLONE_SETTINGS = [{
  kind: "group", id: "basic", label: "Basic", path: ["basic"],
  children: [{
    kind: "setting", id: "beep", label: "Beep", path: ["basic", "beep"],
    doc: null, volatile: false, warning: null,
    values: [{ type: "string", current: "On", mutable: true, index: 0 }],
  }],
}];

// Boots the whole UI on index.html with a radio selected and a port connected
// through the WebSerial toggle, so a transfer runs through the same modules
// (settings summary, radio session, debug log) it does in the app. runtime
// overrides the stubbed runtime methods; returns the controller and the three
// serial controls a user presses.
async function bootConnectedUi(runtime = {}) {
  const { document } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: CLONE_CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: CLONE_HEADERS, columns: {} }),
    getRadioMetadata: async () => ({ headers: CLONE_HEADERS, columns: {} }),
    getRadioSettings: async () => ({
      supported: true, available: true, requiresImage: false, message: "", groups: CLONE_SETTINGS,
    }),
    serialConnect: async () => ({ connected: true, transport: "webserial", message: "ok" }),
    serialDisconnect: async () => ({ connected: false, message: "bye" }),
    validateRowsForUpload: async () => ({ valid: true, issues: [], warnings: [] }),
    validateRadioSettings: async () => ({ valid: true, issues: [], settings: CLONE_SETTINGS }),
    ...runtime,
  }));
  ui.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
  await ui.init(true);
  selectRadioBySearch(document, "Acme Clone");
  await flushMicrotasks();
  const controls = {
    connect: pageElement("serialConnectToggleEl"),
    download: pageElement("radioDownloadEl"),
    upload: pageElement("radioUploadEl"),
  };
  await dispatch(controls.connect, "click");
  return { ui, controls };
}

test("a running download holds every serial control until it ends", async () => {
  const transfer = createDeferred();
  const calls = [];
  const { controls } = await bootConnectedUi({
    downloadSelectedRadio: () => {
      calls.push("download");
      return transfer.promise;
    },
    uploadSelectedRadio: async () => {
      calls.push("upload");
      return { settings: CLONE_SETTINGS };
    },
    serialDisconnect: async () => {
      calls.push("disconnect");
      return { connected: false, message: "bye" };
    },
  });
  assert.equal(controls.download.disabled, false);

  await dispatch(controls.download, "click");
  await flushMicrotasks();
  assert.deepEqual(calls, ["download"]);
  for (const control of Object.values(controls)) {
    assert.equal(control.disabled, true, `#${control.id} must wait for the transfer`);
    assert.equal(control.title, CLONE_RUNNING_TITLE, `#${control.id} must say why`);
  }

  // Pressing anything again while the first transfer runs -- Download, Upload
  // or the toggle, which reads Disconnect -- must not queue a call behind it.
  await dispatch(controls.download, "click");
  await dispatch(controls.upload, "click");
  await dispatch(controls.connect, "click");
  await flushMicrotasks();
  assert.deepEqual(calls, ["download"]);

  transfer.resolve({ headers: CLONE_HEADERS, rows: [{ Location: "1", Name: "ONE" }], settings: CLONE_SETTINGS });
  await flushMicrotasks();
  for (const control of Object.values(controls)) {
    assert.equal(control.disabled, false, `#${control.id} must come back`);
    assert.equal(control.title, "", `#${control.id} must drop the busy title`);
  }
  assert.equal(controls.connect.textContent, "Disconnect");
});

// WEBCHIRP-FRONTEND-1W: an Android user pressed Upload three times while the
// earlier writes were still timing out, and each press queued another one.
test("repeated Upload presses start and report one write, and its failure frees the controls", async (t) => {
  resetSentryForTests();
  t.after(resetSentryForTests);
  const metrics = [];
  await initSentry(makeWindow(), { loadSdk: async () => ({
    init() {},
    withScope() {},
    captureException() {},
    metrics: {
      count: (name, value, options) => metrics.push({ name, ...options }),
      distribution() {},
    },
  }) });
  const transfer = createDeferred();
  let uploads = 0;
  const { controls } = await bootConnectedUi({
    uploadSelectedRadio: () => {
      uploads += 1;
      return transfer.promise;
    },
  });

  for (let press = 0; press < 3; press += 1) {
    await dispatch(controls.upload, "click");
    await flushMicrotasks();
  }
  assert.equal(uploads, 1);
  // The preflight repainted the settings summary, which re-ran
  // updateSerialActionState() mid-transfer; the hold has to survive that.
  assert.equal(controls.upload.disabled, true);
  assert.equal(controls.upload.title, CLONE_RUNNING_TITLE);
  assert.equal(controls.download.disabled, true);

  transfer.reject(new Error("Radio did not respond"));
  await flushMicrotasks();
  for (const control of Object.values(controls)) {
    assert.equal(control.disabled, false, `#${control.id} must come back after a failure`);
  }
  // One transfer, one outcome: the presses that were refused report nothing.
  const outcomes = metrics
    .filter((metric) => metric.name === "flow.completed" && metric.attributes.flow === "radio_upload")
    .map((metric) => metric.attributes.outcome);
  assert.deepEqual(outcomes, ["failed"]);
});

test("a port lost mid-transfer shows at once, and Connect returns when the transfer fails", async () => {
  const transfer = createDeferred();
  let connects = 0;
  const { ui, controls } = await bootConnectedUi({
    serialConnect: async () => {
      connects += 1;
      return { connected: true, transport: "webserial", message: "ok" };
    },
    downloadSelectedRadio: () => transfer.promise,
  });
  assert.equal(connects, 1);
  await dispatch(controls.download, "click");
  await flushMicrotasks();

  // The connection is gone the moment the bridge says so...
  ui.onSerialPortLost("USB VID:PID 0x0403:0x6015");
  assert.equal(controls.connect.textContent, "Connect via WebSerial");
  assert.equal(controls.download.disabled, true);
  assert.equal(controls.upload.disabled, true);
  // ...but a Connect pressed now would wait behind the dying transfer and
  // open the port chooser after the click that asked for it had expired.
  assert.equal(controls.connect.disabled, true);
  assert.equal(controls.connect.title, CLONE_RUNNING_TITLE);
  await dispatch(controls.connect, "click");
  assert.equal(connects, 1);

  // The bridge fails the transfer's next read on the closed port.
  transfer.reject(new Error("Port is not connected."));
  await flushMicrotasks();
  assert.equal(controls.connect.disabled, false);
  assert.equal(controls.download.disabled, true);
  assert.equal(controls.download.title, "Connect to a serial port first");

  await dispatch(controls.connect, "click");
  assert.equal(connects, 2);
  assert.equal(controls.download.disabled, false);
});

// Sentry drops a driver's own clone failures (isDriverCloneFailure,
// web/js/sentry.ts), so a transport that loses bytes shows only as a clone
// failure rate that moves with the transport. Every outcome has to carry it,
// successes too, and a failure that follows a lost port keeps the transport
// the clone started over: the loss clears the connection's before the
// failure arrives.
test("every clone outcome carries the transport the clone started over", async (t) => {
  resetSentryForTests();
  t.after(resetSentryForTests);
  const metrics = [];
  await initSentry(makeWindow(), { loadSdk: async () => ({
    init() {},
    withScope() {},
    captureException() {},
    metrics: {
      count: (name, value, options) => metrics.push({ name, ...options }),
      distribution() {},
    },
  }) });
  const write = createDeferred();
  const { ui, controls } = await bootConnectedUi({
    serialConnect: async () => ({ connected: true, transport: "webusb", message: "ok" }),
    downloadSelectedRadio: async () => ({
      headers: CLONE_HEADERS, rows: [{ Location: "1", Name: "ONE" }], settings: CLONE_SETTINGS,
    }),
    uploadSelectedRadio: () => write.promise,
  });

  await dispatch(controls.download, "click");
  await flushMicrotasks();
  await dispatch(controls.upload, "click");
  await flushMicrotasks();
  ui.onSerialPortLost("USB VID:PID 0x0403:0x6015");
  write.reject(new Error("Port is not connected."));
  await flushMicrotasks();

  const outcomes = metrics
    .filter((metric) => metric.name === "flow.completed" && metric.attributes.flow.startsWith("radio_"))
    .map(({ attributes }) => [attributes.flow, attributes.outcome, attributes.transport]);
  assert.deepEqual(outcomes, [
    ["radio_download", "ok", "webusb"],
    ["radio_upload", "failed", "webusb"],
  ]);
});

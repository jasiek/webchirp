import assert from "node:assert/strict";
import test from "node:test";

// The clone buttons must stay dead until a serial port has actually been
// opened: pressing Download with no port only ever produced a runtime error.

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.textContent = "";
  }

  addEventListener(type, handler) {
    if (type === "click") {
      this.listener = handler;
    }
  }
}

function makeContext({ hasInvalidSettings = false } = {}) {
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
  const state = {
    selectedRadio: { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5R" },
    runtimeApi: {
      serialConnect: async () => ({ connected: true, transport: "webserial", message: "ok" }),
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

async function loadSerialActions() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "FakeBrowser/1.0", maxTouchPoints: 0 },
  });
  const { createSerialActions } = await import("../web/js/ui/serial-actions.js");
  return createSerialActions;
}

test("clone buttons stay disabled until a serial port is connected", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  const serial = createSerialActions(ctx);

  // Sidebar enabled after init, but no port picked yet.
  serial.setSidebarControlsEnabled(true);
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.radioDownloadEl.title, "Connect to a serial port first");
  assert.equal(ctx.dom.radioUploadEl.title, "Connect to a serial port first");
  // The connect controls themselves stay usable — that is how a port is picked.
  assert.equal(ctx.dom.serialConnectToggleEl.disabled, false);

  serial.bindEvents();
  await ctx.dom.serialConnectToggleEl.listener();
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
  assert.equal(ctx.dom.radioUploadEl.disabled, false);
  assert.equal(ctx.dom.radioDownloadEl.title, "");
  assert.equal(ctx.dom.radioUploadEl.title, "");

  // Disconnecting takes them away again.
  await ctx.dom.serialConnectToggleEl.listener();
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
});

test("a connected port does not override the other clone-button blocks", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext({ hasInvalidSettings: true });
  const serial = createSerialActions(ctx);
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  await ctx.dom.serialConnectToggleEl.listener();

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
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  await ctx.dom.serialConnectToggleEl.listener();
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);

  // The bridge reports the adapter as gone; it has already closed the port.
  serial.handlePortLost("USB VID:PID 0x0403:0x6015");
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.radioDownloadEl.title, "Connect to a serial port first");
  // The toggle has to offer a way back in, not read "Disconnect".
  assert.equal(ctx.dom.serialConnectToggleEl.textContent, "Connect via WebSerial");

  // Reconnecting brings them back.
  await ctx.dom.serialConnectToggleEl.listener();
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
});

test("clone buttons stay disabled until a radio is selected", async () => {
  const createSerialActions = await loadSerialActions();
  const ctx = makeContext();
  // The app boots with nothing chosen rather than defaulting to whichever
  // radio sorts first in the catalog, so this is a state users start in.
  ctx.state.selectedRadio = null;
  const serial = createSerialActions(ctx);
  serial.setSidebarControlsEnabled(true);
  serial.bindEvents();
  await ctx.dom.serialConnectToggleEl.listener();

  // An open port is not enough: both clone paths need a driver to run.
  assert.equal(ctx.dom.radioDownloadEl.disabled, true);
  assert.equal(ctx.dom.radioUploadEl.disabled, true);
  assert.equal(ctx.dom.radioDownloadEl.title, "Select your radio make and model first");
  assert.equal(ctx.dom.radioUploadEl.title, "Select your radio make and model first");

  // Picking a radio with the port already open lights them up.
  ctx.state.selectedRadio = {
    vendor: "Baofeng",
    model: "UV-5R",
    module: "uv5r",
    className: "BaofengUV5R",
  };
  serial.updateSerialActionState();
  assert.equal(ctx.dom.radioDownloadEl.disabled, false);
  assert.equal(ctx.dom.radioUploadEl.disabled, false);
  assert.equal(ctx.dom.radioDownloadEl.title, "");
  assert.equal(ctx.dom.radioUploadEl.title, "");
});

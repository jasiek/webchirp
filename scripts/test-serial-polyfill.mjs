import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSerialBridge } from "../web/js/serial.js";
import { withNavigator } from "./test-support/globals.mjs";

test("prefers native Web Serial when available", async (t) => {
  const nativeSerial = { requestPort: async () => ({}) };
  withNavigator(t, { serial: nativeSerial, usb: {} });

  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => {
      throw new Error("WebUSB provider should not be used when native serial exists");
    },
  });

  assert.deepEqual(bridge.getCapability(), { supported: true, native: true, webusb: true });
  const serial = await bridge._ensureSerial();
  assert.equal(serial, nativeSerial);
  assert.equal(bridge.transport, "webserial");
});

test("falls back to the WebUSB provider when only WebUSB exists", async (t) => {
  withNavigator(t, { usb: {} });

  let created = false;
  const webUsbSerial = { requestPort: async () => ({}) };
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => {
      created = true;
      return webUsbSerial;
    },
  });

  assert.deepEqual(bridge.getCapability(), { supported: true, native: false, webusb: true });
  const serial = await bridge._ensureSerial();
  assert.ok(created, "WebUSB provider factory should be invoked");
  assert.equal(serial, webUsbSerial);
  assert.equal(bridge.transport, "webusb");
});

test("forcing webusb uses the WebUSB provider even when native serial exists", async (t) => {
  // Mirrors Chrome on Android: native Web Serial is present but cannot drive the
  // adapter, so the user explicitly forces the WebUSB transport.
  withNavigator(t, { serial: { requestPort: async () => ({}) }, usb: {} });

  const webUsbSerial = { requestPort: async () => ({}) };
  const bridge = new BrowserSerialBridge({ createWebUsbSerial: () => webUsbSerial });

  bridge.setPreferredTransport("webusb");
  const serial = await bridge._ensureSerial();
  assert.equal(serial, webUsbSerial);
  assert.equal(bridge.transport, "webusb");
});

test("forcing webserial fails when native serial is unavailable", async (t) => {
  withNavigator(t, { usb: {} });
  const bridge = new BrowserSerialBridge({ createWebUsbSerial: () => ({ requestPort: async () => ({}) }) });
  bridge.setPreferredTransport("webserial");
  await assert.rejects(() => bridge._ensureSerial(), /Native Web Serial is not supported/);
});

test("a failed open tears down state instead of leaving a half-open port", async (t) => {
  withNavigator(t, { usb: {} });
  const failingPort = {
    open: async () => {
      throw new Error("boom");
    },
    getInfo: () => ({}),
  };
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({ requestPort: async () => failingPort }),
  });
  bridge.setPreferredTransport("webusb");

  await assert.rejects(() => bridge.open(9600), /boom/);
  // No half-open port left behind to poison the next connect.
  assert.equal(bridge.port, null);
  assert.equal(bridge.writer, null);
});

test("reports unsupported and refuses to open with no serial transport", async (t) => {
  withNavigator(t, {});

  const bridge = new BrowserSerialBridge();
  assert.equal(bridge.isSupported(), false);
  assert.deepEqual(bridge.getCapability(), { supported: false, native: false, webusb: false });
  await assert.rejects(() => bridge.open(9600), /Neither Web Serial nor WebUSB/);
});

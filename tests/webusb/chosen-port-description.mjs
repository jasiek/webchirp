import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSerialBridge } from "../../web/js/serial.ts";
import { makeEmitter, makeRecordingPort } from "../support/fake-serial.mjs";
import { withNavigator } from "../support/globals.mjs";

// What the UI learns about the port the chooser picked, for the connect's
// metric: the transport it goes over and the cable behind it, read between
// choosePort() and the open so that a failed open can still say which cable
// it failed on. Everything here names a model of adapter; nothing names one
// adapter in particular.

// A bridge whose WebUSB chooser answers with the given recording port.
function bridgeChoosing(t, port) {
  withNavigator(t, { usb: makeEmitter() });
  return new BrowserSerialBridge({
    createWebUsbSerial: () => ({ requestPort: async () => port }),
  });
}

test("nothing is described before the chooser has answered", async (t) => {
  const bridge = bridgeChoosing(t, makeRecordingPort());
  assert.equal(bridge.describeChosenPort(), null);
});

test("a chosen WebUSB chip port is described by its transport, chip family and USB ids", async (t) => {
  const bridge = bridgeChoosing(t, makeRecordingPort({ usbVendorId: 0x067b, usbProductId: 0x2303 }));
  await bridge.choosePort("webusb");
  assert.deepEqual(bridge.describeChosenPort(), {
    transport: "webusb",
    chip: "pl2303",
    usbVendorId: "0x067B",
    usbProductId: "0x2303",
  });
});

test("a WebUSB device none of the chip drivers claim is the CDC polyfill's", async (t) => {
  const bridge = bridgeChoosing(t, makeRecordingPort({ usbVendorId: 0x2e8a, usbProductId: 0x000c }));
  await bridge.choosePort("webusb");
  assert.equal(bridge.describeChosenPort().chip, "cdc");
});

test("the description survives the open taking the chosen port", async (t) => {
  const bridge = bridgeChoosing(t, makeRecordingPort({ usbVendorId: 0x0403, usbProductId: 0x6015 }));
  await bridge.choosePort("webusb");
  const chosen = bridge.describeChosenPort();
  assert.equal(chosen.chip, "ftdi");
  await bridge.open(9600);
  // The open consumed the held port; the live one answers the same.
  assert.deepEqual(bridge.describeChosenPort(), chosen);
  await bridge.close();
  assert.equal(bridge.describeChosenPort(), null);
});

test("a dismissed chooser leaves nothing to describe", async (t) => {
  withNavigator(t, { usb: makeEmitter() });
  const dismissal = new Error("No device selected.");
  dismissal.name = "NotFoundError";
  const bridge = new BrowserSerialBridge({
    createWebUsbSerial: () => ({ requestPort: async () => { throw dismissal; } }),
  });
  await assert.rejects(bridge.choosePort("webusb"));
  assert.equal(bridge.describeChosenPort(), null);
});

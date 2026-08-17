import assert from "node:assert/strict";
import test from "node:test";
import {
  FTDI_VENDOR_ID,
  FtdiSerialPort,
  ftdiConvertBaudrate,
  isFtdiDevice,
  stripFtdiStatusBytes,
} from "../web/js/ftdi-webusb.js";
import { createWebUsbSerial } from "../web/js/webusb-serial.js";

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

test("ftdiConvertBaudrate matches known libftdi divisor encodings", () => {
  // Well-known FTDI (FT232R/FT-X, 3 MHz clock) divisor values.
  assert.deepEqual(ftdiConvertBaudrate(9600), { value: 0x4138, index: 0 });
  assert.deepEqual(ftdiConvertBaudrate(115200), { value: 0x001a, index: 0 });
  assert.deepEqual(ftdiConvertBaudrate(3000000), { value: 0, index: 0 });
  assert.throws(() => ftdiConvertBaudrate(0), /Invalid FTDI baud rate/);
});

test("stripFtdiStatusBytes drops the two-byte modem status header", () => {
  assert.deepEqual(
    Array.from(stripFtdiStatusBytes(new Uint8Array([0x01, 0x60, 0xaa, 0xbb]))),
    [0xaa, 0xbb],
  );
  // A packet carrying only the status header yields no payload.
  assert.equal(stripFtdiStatusBytes(new Uint8Array([0x01, 0x60])).length, 0);
  assert.equal(stripFtdiStatusBytes(new Uint8Array([])).length, 0);
});

test("isFtdiDevice recognizes the FTDI vendor id", () => {
  assert.equal(FTDI_VENDOR_ID, 0x0403);
  assert.ok(isFtdiDevice({ vendorId: 0x0403, productId: 0x6015 }));
  assert.ok(!isFtdiDevice({ vendorId: 0x067b, productId: 0x2303 })); // PL2303
  assert.ok(!isFtdiDevice(null));
});

test("WebUSB provider dispatches FTDI devices to the FTDI driver", async () => {
  let requestedOptions = null;
  setNavigator({
    usb: {
      requestDevice: async (options) => {
        requestedOptions = options;
        return { vendorId: 0x0403, productId: 0x6015 };
      },
    },
  });
  const serial = createWebUsbSerial({
    loadCdcSerialPort: async () => {
      throw new Error("CDC polyfill should not load for FTDI devices");
    },
  });
  const port = await serial.requestPort();
  assert.ok(port instanceof FtdiSerialPort);
  assert.deepEqual(port.getInfo(), { usbVendorId: 0x0403, usbProductId: 0x6015 });
  // The chooser must filter on the FTDI vendor id, or the device is never shown.
  assert.ok(
    requestedOptions?.filters?.some((f) => f.vendorId === FTDI_VENDOR_ID),
    "requestDevice must be called with an FTDI vendor filter",
  );
});

test("WebUSB provider dispatches devices without a native driver to the CDC polyfill", async () => {
  // An Arduino-style CDC-ACM device: neither FTDI nor Prolific.
  setNavigator({
    usb: { requestDevice: async () => ({ vendorId: 0x2341, productId: 0x0043 }) },
  });
  let loaded = false;
  class FakeCdcPort {
    constructor(device) {
      this.device = device;
    }
  }
  const serial = createWebUsbSerial({
    loadCdcSerialPort: async () => {
      loaded = true;
      return FakeCdcPort;
    },
  });
  const port = await serial.requestPort();
  assert.ok(loaded, "CDC polyfill loader should be invoked for non-FTDI devices");
  assert.ok(port instanceof FakeCdcPort);
});

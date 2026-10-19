import assert from "node:assert/strict";
import test from "node:test";
import {
  FTDI_VENDOR_ID,
  FtdiSerialPort,
  ftdiConvertBaudrate,
  isFtdiDevice,
  stripFtdiStatusBytes,
} from "../../web/js/ftdi-webusb.ts";
import { CDC_CLAIM_RETRY_DELAYS_MS, CdcSerialPort, chipFamilyOf, createWebUsbSerial } from "../../web/js/webusb-serial.ts";
import { isUsbInterfaceBusy } from "../../web/js/serial-errors.ts";
import { makeEmitter } from "../support/fake-serial.mjs";
import { withNavigator } from "../support/globals.mjs";

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

test("WebUSB provider dispatches FTDI devices to the FTDI driver", async (t) => {
  let requestedOptions = null;
  withNavigator(t, {
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

test("WebUSB provider dispatches devices without a native driver to the CDC polyfill", async (t) => {
  // An Arduino-style CDC-ACM device: neither FTDI nor Prolific.
  const device = { vendorId: 0x2341, productId: 0x0043 };
  withNavigator(t, {
    usb: { requestDevice: async () => device },
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
  // Wrapped, not handed over raw: the polyfill keeps its device private, and
  // the wrapper is what names it.
  assert.ok(port instanceof CdcSerialPort);
  assert.ok(port.polyfillPort instanceof FakeCdcPort);
  assert.equal(port.polyfillPort.device, device);
  assert.equal(port.usbDevice, device);
  assert.equal(port.capabilities.framing, true);
});

// What web-serial-polyfill 1.0.15's open() throws when WebUSB refuses
// claimInterface: its catch closes the device and keeps only the string.
const POLYFILL_CLAIM_REFUSAL = "Error setting up device: NetworkError: Failed to execute "
  + "'claimInterface' on 'USBDevice': Unable to claim interface.";

// A polyfill port whose open() throws each queued failure in turn, then
// succeeds; it counts the opens. The wrapper's sleeps are recorded, not slept.
function claimRaceFixture(failures) {
  const queue = [...failures];
  const polyfillPort = {
    opens: 0,
    async open() {
      polyfillPort.opens += 1;
      const failure = queue.shift();
      if (failure) {
        throw failure;
      }
    },
    async close() {},
  };
  const usb = makeEmitter();
  const sleeps = [];
  const device = { vendorId: 0x2e8a, productId: 0x000c };
  const port = new CdcSerialPort(polyfillPort, device, {
    usb,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { port, polyfillPort, usb, sleeps };
}

test("CDC open retries a claim refused right after a reopen, then succeeds", async () => {
  // Android Chrome releases the previous claim asynchronously, so the reopen
  // after close() can be refused once and then go through.
  const { port, polyfillPort, usb, sleeps } = claimRaceFixture([new Error(POLYFILL_CLAIM_REFUSAL)]);
  await port.open({ baudRate: 38400 });
  assert.equal(polyfillPort.opens, 2);
  assert.deepEqual(sleeps, [CDC_CLAIM_RETRY_DELAYS_MS[0]]);
  assert.equal(usb.listenerCount("disconnect"), 1, "a successful open watches for loss");
});

test("CDC open gives up after the bounded retries with the busy-interface error", async () => {
  const attempts = CDC_CLAIM_RETRY_DELAYS_MS.length + 1;
  const refusals = Array.from({ length: attempts + 2 }, () => new Error(POLYFILL_CLAIM_REFUSAL));
  const { port, polyfillPort, usb, sleeps } = claimRaceFixture(refusals);
  await assert.rejects(port.open({ baudRate: 9600 }), (error) => {
    assert.ok(isUsbInterfaceBusy(error), `expected the busy error, got ${error.name}`);
    assert.ok(error.message.includes(POLYFILL_CLAIM_REFUSAL), "the polyfill's message is kept");
    return true;
  });
  assert.equal(polyfillPort.opens, attempts);
  assert.deepEqual(sleeps, [...CDC_CLAIM_RETRY_DELAYS_MS]);
  // The retries stay well under a second of waiting.
  assert.ok(sleeps.reduce((a, b) => a + b, 0) < 1000);
  assert.equal(usb.listenerCount("disconnect"), 0, "a failed open leaves no loss watch");
});

test("CDC open throws any other open failure at once, without retrying", async () => {
  const failure = new Error(
    "Error setting up device: NetworkError: Failed to execute 'controlTransferOut' on "
    + "'USBDevice': A transfer error has occurred.",
  );
  const { port, polyfillPort, usb, sleeps } = claimRaceFixture([failure]);
  await assert.rejects(port.open({ baudRate: 9600 }), (error) => error === failure);
  assert.equal(polyfillPort.opens, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(usb.listenerCount("disconnect"), 0);
});

test("chipFamilyOf names the driver family requestPort() would pick, and nothing for the rest", () => {
  // The same four tests as the provider's ladder, so the family a metric
  // carries is the driver that opened the port.
  assert.equal(chipFamilyOf({ vendorId: 0x0403, productId: 0x6001 }), "ftdi");
  assert.equal(chipFamilyOf({ vendorId: 0x067b, productId: 0x2303 }), "pl2303");
  assert.equal(chipFamilyOf({ vendorId: 0x1a86, productId: 0x7523 }), "ch340");
  assert.equal(chipFamilyOf({ vendorId: 0x10c4, productId: 0xea60 }), "cp2102");
  // A CDC device, a port with no USB identity, and nothing at all.
  assert.equal(chipFamilyOf({ vendorId: 0x2e8a, productId: 0x000c }), "");
  assert.equal(chipFamilyOf({}), "");
  assert.equal(chipFamilyOf(null), "");
});

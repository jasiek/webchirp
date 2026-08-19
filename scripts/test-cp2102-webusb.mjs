import assert from "node:assert/strict";
import test from "node:test";
import {
  CP210X_PARTNUM,
  CP210X_UNSUPPORTED_PRODUCT_IDS,
  CP210X_VENDOR_ID,
  Cp2102SerialPort,
  cp2102QuantizeBaudRate,
  cp2102RejectionReason,
  cp2102SpeedLimits,
  hasCdcInterface,
  isCp2102Device,
} from "../web/js/cp2102-webusb.js";
import { createWebUsbSerial } from "../web/js/webusb-serial.js";

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

function bytesOf(data) {
  if (!data) {
    return null;
  }
  return Array.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength));
}

// Fake USBDevice for a CP2102: a bulk pair on interface 0, recording every
// control transfer and answering the part-number and flow-control reads.
function makeFakeDevice({
  partNumber = CP210X_PARTNUM.CP2102,
  partNumberStatus = "ok",
  interfaceNumber = 0,
  flowBlock = null,
  modemStatus = 0x00,
  endpoints = null,
  cancelOnClearHalt = false,
} = {}) {
  const controlIn = [];
  const controlOut = [];
  const clearHaltCalls = [];
  const transferInCalls = [];
  const transferOutCalls = [];
  // Results the fake hands back for the next bulk OUT transfers, oldest first;
  // anything past the end of the list is a full, successful write.
  const outResults = [];
  // Transfers the driver has queued that the fake has not answered yet.
  const outstanding = [];
  const device = {
    vendorId: 0x10c4,
    productId: 0xea60,
    configuration: {
      interfaces: [
        {
          interfaceNumber,
          alternate: {
            endpoints: endpoints || [
              { type: "bulk", direction: "out", endpointNumber: 1, packetSize: 64 },
              { type: "bulk", direction: "in", endpointNumber: 1, packetSize: 64 },
            ],
          },
        },
      ],
    },
    open: async () => {},
    selectConfiguration: async () => {},
    claimInterface: async () => {},
    releaseInterface: async () => {},
    close: async () => {},
    controlTransferIn: async (setup, length) => {
      controlIn.push({ ...setup, length });
      if (setup.request === 0xff) { // VENDOR_SPECIFIC / GET_PARTNUM
        if (partNumberStatus !== "ok") {
          return { status: partNumberStatus };
        }
        return { status: "ok", data: new DataView(new Uint8Array([partNumber]).buffer) };
      }
      if (setup.request === 0x14) { // GET_FLOW
        const block = flowBlock || new Uint8Array(16);
        return { status: "ok", data: new DataView(block.buffer.slice(0)) };
      }
      if (setup.request === 0x08) { // GET_MDMSTS
        return { status: "ok", data: new DataView(new Uint8Array([modemStatus]).buffer) };
      }
      return { status: "ok", data: new DataView(new ArrayBuffer(length)) };
    },
    controlTransferOut: async (setup, data) => {
      controlOut.push({
        recipient: setup.recipient,
        request: setup.request,
        value: setup.value,
        index: setup.index,
        data: bytesOf(data),
      });
      return { status: "ok" };
    },
    clearHalt: async (direction, endpoint) => {
      clearHaltCalls.push({ direction, endpoint });
      if (cancelOnClearHalt) {
        // Chromium cancels every transfer outstanding on the interface before
        // it clears the endpoint, and Blink rejects a cancelled transfer with
        // AbortError rather than completing it with a status.
        for (const transfer of outstanding.splice(0)) {
          transfer.reject(Object.assign(
            new Error("The transfer was cancelled."),
            { name: "AbortError" },
          ));
        }
      }
    },
    transferIn: async (endpointNumber, length) => {
      transferInCalls.push({ endpointNumber, length });
      // Left unanswered until the test delivers a result, the way real hardware
      // leaves a transfer pending until bytes arrive.
      return new Promise((resolve, reject) => {
        outstanding.push({ resolve, reject });
      });
    },
    transferOut: async (endpointNumber, data) => {
      transferOutCalls.push({ endpointNumber, bytes: Array.from(new Uint8Array(
        data.buffer || data,
        data.byteOffset || 0,
        data.byteLength ?? data.length,
      )) });
      const next = outResults.shift();
      if (next) {
        return next;
      }
      return { status: "ok", bytesWritten: data.byteLength ?? data.length };
    },
  };
  // Answer the oldest unanswered transfer — bulk transfers on one endpoint
  // complete in the order they were issued.
  const deliver = (result) => {
    outstanding.shift()?.resolve(result);
  };
  return {
    device, controlIn, controlOut, clearHaltCalls, transferInCalls,
    transferOutCalls, outResults, deliver,
  };
}

// Let the stream's pull run: it is invoked off a microtask and awaits transfers.
function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// The 16-byte GET_FLOW/SET_FLOW block, as four little-endian u32s.
function flowWords(bytes) {
  const view = new DataView(new Uint8Array(bytes).buffer);
  return [0, 4, 8, 12].map((offset) => view.getUint32(offset, true));
}

test("cp2102QuantizeBaudRate maps every rate CHIRP uses to itself", () => {
  // AN205 Table 1 quantisation. All the standard radio rates are exact entries,
  // so the chip runs them verbatim — worth pinning, because a quantiser that
  // silently shifted 115200 would break every clone with no visible error.
  for (const baud of [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]) {
    assert.equal(cp2102QuantizeBaudRate(baud), baud, `${baud} baud must not move`);
  }
});

test("cp2102QuantizeBaudRate rounds a rate the generator cannot make up to the next one", () => {
  // The table is a step function: everything up to 9612 is 9600, and the next
  // request lands on 14400.
  assert.equal(cp2102QuantizeBaudRate(9612), 9600);
  assert.equal(cp2102QuantizeBaudRate(9613), 14400);
  assert.equal(cp2102QuantizeBaudRate(117028), 115200);
});

test("cp2102QuantizeBaudRate clamps to the part's range instead of failing", () => {
  // AN205 says a request above ~1.05 Mbaud gives an undefined result, so the
  // rate is clamped to what the part can do rather than passed through.
  assert.equal(cp2102QuantizeBaudRate(1, { partNumber: CP210X_PARTNUM.CP2102 }), 300);
  assert.equal(cp2102QuantizeBaudRate(9e6, { partNumber: CP210X_PARTNUM.CP2102 }), 1000000);
  assert.equal(cp2102QuantizeBaudRate(9e6, { partNumber: CP210X_PARTNUM.CP2101 }), 921600);
  // The CP2105's two interfaces differ: the SCI port starts at 2400.
  assert.equal(
    cp2102QuantizeBaudRate(300, { partNumber: CP210X_PARTNUM.CP2105, interfaceNumber: 1 }),
    2400,
  );
  assert.throws(() => cp2102QuantizeBaudRate(0), /Invalid CP2102 baud rate/);
  assert.throws(() => cp2102QuantizeBaudRate("nope"), /Invalid CP2102 baud rate/);
});

test("cp2102QuantizeBaudRate uses the divisor maths on parts that need it", () => {
  // CP2104/CP2105-ECI/CP2102N derive the rate from the 48 MHz clock rather than
  // the AN205 table: div = round(48e6 / (2 x prescale x request)).
  const cp2104 = { partNumber: CP210X_PARTNUM.CP2104 };
  assert.equal(cp2102SpeedLimits(CP210X_PARTNUM.CP2104).useActualRate, true);
  assert.equal(cp2102QuantizeBaudRate(115200, cp2104), 115384); // div 208
  assert.equal(cp2102QuantizeBaudRate(9600, cp2104), 9600); // div 2500, exact
  // Below 365 baud the prescaler kicks in, which is the only branch in the
  // divisor path — without it 300 baud lands on a divisor above 16 bits.
  assert.equal(cp2102QuantizeBaudRate(300, cp2104), 300);
  assert.equal(
    cp2102QuantizeBaudRate(115200, { partNumber: CP210X_PARTNUM.CP2102N_QFN28 }),
    115384,
  );
});

test("isCp2102Device accepts single-UART Silicon Labs bridges", () => {
  assert.equal(CP210X_VENDOR_ID, 0x10c4);
  assert.ok(isCp2102Device({ vendorId: 0x10c4, productId: 0xea60 }));
  // OEM cables ship a CP210x under a custom product id, and there are ~150 of
  // them in the kernel's table — an exact-pair allowlist would make those
  // invisible in the chooser, so the vendor-wide match is deliberate.
  assert.ok(isCp2102Device({ vendorId: 0x10c4, productId: 0x814b }));
  assert.ok(!isCp2102Device({ vendorId: 0x1a86, productId: 0x7523 })); // CH340
  assert.ok(!isCp2102Device({ vendorId: 0x0403, productId: 0x6015 })); // FTDI
  assert.ok(!isCp2102Device(null));
});

test("isCp2102Device turns away the parts this driver must not configure", () => {
  // Vendor-wide breadth in the chooser is only safe because the products that
  // are not single-UART vendor-protocol bridges are rejected here. Each of
  // these would otherwise be handed the CP210x register map on the strength of
  // its vendor id: the multi-UART parts address a second port this driver does
  // not know about, and the HID/SPI parts are not UARTs at all.
  for (const [productId, description] of CP210X_UNSUPPORTED_PRODUCT_IDS) {
    const device = { vendorId: 0x10c4, productId };
    assert.ok(!isCp2102Device(device), `${description} must be rejected`);
    assert.match(cp2102RejectionReason(device), /not a single-UART CP210x bridge/);
  }
  // The set covers both reasons a product is excluded.
  assert.ok(CP210X_UNSUPPORTED_PRODUCT_IDS.has(0xea70), "CP2105 (dual UART)");
  assert.ok(CP210X_UNSUPPORTED_PRODUCT_IDS.has(0x87a0), "CP2130 (USB-SPI)");
});

test("a Silicon Labs device that enumerates as CDC belongs to the polyfill", () => {
  // The CP2102C speaks standard CDC-ACM rather than the vendor register map,
  // and it carries a Silicon Labs vendor id like everything else here — so the
  // product id cannot separate it and the interface class has to. Sending it
  // CP210x configuration writes would be wrong even though the vendor matches.
  const cp2102c = {
    vendorId: 0x10c4,
    productId: 0xea60,
    configurations: [{
      interfaces: [
        { alternates: [{ interfaceClass: 0x02 }] },
        { alternates: [{ interfaceClass: 0x0a }] },
      ],
    }],
  };
  assert.ok(hasCdcInterface(cp2102c));
  assert.ok(!isCp2102Device(cp2102c));
  assert.match(cp2102RejectionReason(cp2102c), /CDC polyfill/);

  // A genuine CP2102 declares a vendor-specific interface class and is kept.
  const cp2102 = {
    vendorId: 0x10c4,
    productId: 0xea60,
    configurations: [{ interfaces: [{ alternates: [{ interfaceClass: 0xff }] }] }],
  };
  assert.ok(!hasCdcInterface(cp2102));
  assert.ok(isCp2102Device(cp2102));

  // A device that declares CDC at the device level counts too.
  assert.ok(hasCdcInterface({ vendorId: 0x10c4, deviceClass: 0x02 }));
});

test("WebUSB provider dispatches CP2102 devices to the CP2102 driver", async () => {
  let requestedOptions = null;
  setNavigator({
    usb: {
      requestDevice: async (options) => {
        requestedOptions = options;
        return { vendorId: 0x10c4, productId: 0xea60 };
      },
    },
  });
  const serial = createWebUsbSerial({
    loadCdcSerialPort: async () => {
      throw new Error("CDC polyfill should not load for CP2102 devices");
    },
  });
  const port = await serial.requestPort();
  assert.ok(port instanceof Cp2102SerialPort);
  assert.deepEqual(port.getInfo(), { usbVendorId: 0x10c4, usbProductId: 0xea60 });
  // The chooser must filter on the vendor id or the cable is never listed.
  assert.ok(
    requestedOptions?.filters?.some(
      (f) => f.vendorId === CP210X_VENDOR_ID && f.productId === undefined,
    ),
    "requestDevice must filter on the Silicon Labs vendor id",
  );
});

test("WebUSB provider sends a CDC Silicon Labs device to the polyfill", async () => {
  setNavigator({
    usb: {
      requestDevice: async () => ({
        vendorId: 0x10c4,
        productId: 0xea60,
        configurations: [{ interfaces: [{ alternates: [{ interfaceClass: 0x02 }] }] }],
      }),
    },
  });
  class FakeCdcSerialPort {}
  const serial = createWebUsbSerial({ loadCdcSerialPort: async () => FakeCdcSerialPort });
  const port = await serial.requestPort();

  assert.ok(port instanceof FakeCdcSerialPort, "CP2102C must reach the CDC polyfill");
  assert.ok(!(port instanceof Cp2102SerialPort));
});

test("Cp2102SerialPort.open() runs the init sequence", async () => {
  const { device, controlIn, controlOut } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.equal(port.partNumber, CP210X_PARTNUM.CP2102);
  assert.equal(port.baudRate, 9600);
  // Part number first (it selects the baud generator's behaviour), then the
  // flow block the driver edits and writes back.
  assert.deepEqual(controlIn, [
    {
      requestType: "vendor", recipient: "device", request: 0xff, value: 0x370b, index: 0, length: 1,
    },
    {
      requestType: "vendor", recipient: "interface", request: 0x14, value: 0, index: 0, length: 16,
    },
  ]);
  assert.deepEqual(controlOut, [
    // IFC_ENABLE(UART_DISABLE) before IFC_ENABLE(UART_ENABLE). Enabling the
    // interface does NOT clear event-insertion mode (AN571) — only a disable or
    // a USB reset does — so without the down-then-up an event mode inherited
    // from a previous session escapes 0xEC and splices status bytes into the
    // clone data. Dropping the disable is invisible until it corrupts an image.
    { recipient: "interface", request: 0x00, value: 0x0000, index: 0, data: null },
    { recipient: "interface", request: 0x00, value: 0x0001, index: 0, data: null },
    // SET_BAUDRATE carries the rate as a little-endian u32: 9600 = 0x2580.
    { recipient: "interface", request: 0x1e, value: 0, index: 0, data: [0x80, 0x25, 0x00, 0x00] },
    // SET_LINE_CTL: 8 data bits, no parity, 1 stop bit.
    { recipient: "interface", request: 0x03, value: 0x0800, index: 0, data: null },
    // SET_FLOW: the edited 16-byte block.
    {
      recipient: "interface",
      request: 0x13,
      value: 0,
      index: 0,
      data: controlOut[4].data,
    },
    // SET_MHS: both write-mask bits set, both lines low.
    { recipient: "interface", request: 0x07, value: 0x0300, index: 0, data: null },
  ]);
  assert.equal(controlOut[4].data.length, 16);
  assert.ok(port.readable, "readable stream must be set up");
  assert.ok(port.writable, "writable stream must be set up");
});

test("Cp2102SerialPort addresses its control requests to the claimed interface", async () => {
  // Unlike the CH340's device-recipient requests, this family takes vendor
  // requests on the interface with wIndex carrying the interface number. Get
  // that wrong on a part whose UART is not interface 0 and every request goes
  // to the wrong place — so the number has to come from the descriptor, not a
  // hardcoded zero.
  const { device, controlIn, controlOut } = makeFakeDevice({ interfaceNumber: 1 });
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 115200 });

  for (const setup of controlOut) {
    assert.equal(setup.recipient, "interface");
    assert.equal(setup.index, 1, `request 0x${setup.request.toString(16)} addressed the wrong interface`);
  }
  for (const setup of controlIn) {
    assert.equal(setup.index, 1);
  }
});

test("Cp2102SerialPort.open() survives a part that will not report its part number", async () => {
  // Counterfeit parts answer the vendor request oddly. The kernel downgrades to
  // an unknown part rather than failing the open, and so does this driver.
  const { device } = makeFakeDevice({ partNumberStatus: "stall" });
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.equal(port.partNumber, CP210X_PARTNUM.UNKNOWN);
  assert.equal(port.baudRate, 9600);
});

test("Cp2102SerialPort.open() turns off every handshake the chip can do itself", async () => {
  // This is the byte-transparency guarantee: XON/XOFF would eat 0x11 and 0x13
  // out of a clone image, and CTS/DSR/DCD handshaking would let the radio's
  // control lines gate our transmit. The fake reports a chip that has all of
  // them on, so the test fails if the driver ever stops clearing them.
  const current = new Uint8Array(16);
  const view = new DataView(current.buffer);
  view.setUint32(0, 0x7b, true); // DTR flow control + CTS/DSR/DCD handshake + sensitivity
  // RTS flow control + auto transmit + auto receive + error char + NUL
  // stripping + break char: the last three rewrite the received byte stream
  // rather than failing, and NUL stripping alone silently shortens an image.
  view.setUint32(4, 0x9f, true);
  view.setUint32(8, 0x80, true); // Xon limit
  view.setUint32(12, 0x80, true); // Xoff limit
  const { device, controlOut } = makeFakeDevice({ flowBlock: current });
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });

  const written = controlOut.find((c) => c.request === 0x13);
  const [controlHandshake, flowReplace, xonLimit, xoffLimit] = flowWords(written.data);
  assert.equal(controlHandshake, 0, "no DTR flow control, no CTS/DSR/DCD handshake");
  assert.equal(
    flowReplace,
    0,
    "no RTS flow control, no XON/XOFF, no error/NUL/break byte transformation",
  );
  // Both thresholds go out as zero even though the chip reported 0x80. CP2102N
  // A01 erratum E104 reads the first byte of ulXonLimit as ulFlowReplace, so
  // 0x80 there selects RTS flow control on an affected part — gating TX while
  // the real flow word looks innocent. They are unused with XON/XOFF off.
  assert.equal(xonLimit, 0);
  assert.equal(xoffLimit, 0);
});

test("Cp2102SerialPort.open() builds a flow block when the chip will not report one", async () => {
  const { device, controlOut } = makeFakeDevice();
  device.controlTransferIn = async (setup, length) => {
    if (setup.request === 0x14) {
      return { status: "stall" };
    }
    if (setup.request === 0xff) {
      return { status: "ok", data: new DataView(new Uint8Array([CP210X_PARTNUM.CP2102]).buffer) };
    }
    return { status: "ok", data: new DataView(new ArrayBuffer(length)) };
  };
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });

  const written = controlOut.find((c) => c.request === 0x13);
  const [controlHandshake, flowReplace, xonLimit, xoffLimit] = flowWords(written.data);
  assert.equal(controlHandshake, 0);
  assert.equal(flowReplace, 0);
  assert.equal(xonLimit, 0);
  assert.equal(xoffLimit, 0);
});

test("Cp2102SerialPort.open() reports a missing bulk pair by interface", async () => {
  // Parts in this family carry GPIO and second-UART endpoints on the same
  // interface, so picking by direction alone can select the wrong pipe.
  const { device } = makeFakeDevice({
    endpoints: [
      { type: "interrupt", direction: "in", endpointNumber: 3, packetSize: 8 },
      { type: "bulk", direction: "out", endpointNumber: 1, packetSize: 64 },
    ],
  });
  const port = new Cp2102SerialPort(device);
  await assert.rejects(
    port.open({ baudRate: 9600 }),
    /bulk IN\/OUT endpoints not found on interface 0/,
  );
});

test("Cp2102SerialPort.setSignals writes only the lines that change", async () => {
  const { device, controlOut } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  controlOut.length = 0;

  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  assert.deepEqual(controlOut, [
    // Both write bits, both lines high.
    { recipient: "interface", request: 0x07, value: 0x0303, index: 0, data: null },
  ]);

  // Only RTS drops: DTR is left out of the write mask entirely, so the chip
  // keeps driving it without the driver having to restate its value.
  await port.setSignals({ requestToSend: false });
  assert.deepEqual(controlOut.at(-1), {
    recipient: "interface", request: 0x07, value: 0x0200, index: 0, data: null,
  });

  // A no-op change must not spend a control transfer.
  const before = controlOut.length;
  await port.setSignals({ requestToSend: false });
  await port.setSignals({});
  assert.equal(controlOut.length, before);
});

test("Cp2102SerialPort.getSignals decodes the modem status byte", async () => {
  // The other three WebUSB drivers cannot read input control lines at all;
  // this family answers GET_MDMSTS with them, which is what lets the loopback
  // suite's control-line case run on the WebUSB transport.
  const { device } = makeFakeDevice({ modemStatus: 0x10 | 0x40 });
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });

  assert.deepEqual(await port.getSignals(), {
    clearToSend: true,
    dataSetReady: false,
    dataCarrierDetect: false,
    ringIndicator: true,
  });
});

test("Cp2102SerialPort read path clears a stalled IN endpoint and passes raw bytes", async () => {
  // With event-insertion mode off, bulk IN carries no header — every byte is
  // payload, and empty packets must not resolve the pull (that wedges reads).
  //
  // The halt is cleared with a queue of transfers still outstanding, and
  // clearHalt() cancels every one of them. Chromium reports a cancellation as a
  // rejected promise (AbortError), not as a result carrying a status, so a read
  // path that keeps the pre-stall queue awaits a cancelled transfer on its next
  // turn and errors the stream for good.
  const { device, clearHaltCalls, deliver } = makeFakeDevice({ cancelOnClearHalt: true });
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  const reader = port.readable.getReader();
  const read = reader.read();
  await tick();

  deliver({ status: "stall" });
  await tick();

  deliver({ status: "ok", data: new DataView(new Uint8Array([]).buffer) });
  await tick();
  deliver({ status: "ok", data: new DataView(new Uint8Array([0xec, 0x11, 0x13]).buffer) });

  const { value } = await read;
  assert.deepEqual(clearHaltCalls, [{ direction: "in", endpoint: 1 }]);
  // 0xEC is the escape byte event-insertion mode would have eaten, and
  // 0x11/0x13 are what software flow control would have eaten.
  assert.deepEqual(Array.from(value), [0xec, 0x11, 0x13]);
});

test("Cp2102SerialPort keeps a full pipeline of bulk IN transfers queued", async () => {
  // With a single transfer outstanding the host has no IN request queued
  // between one completing and the next being issued, and the chip's RX FIFO
  // overruns in that gap — silently, with `status: "ok"` and no error at any
  // layer. Measured on all three earlier drivers; this chip's 64-byte endpoint
  // widens the margin but does not remove it.
  //
  // Both halves of the fix are pinned by the call count. No reader is attached,
  // so the only thing driving further pulls is the stream's own high-water
  // mark: 16 transfers are queued up front, and each of the 15 pulls after the
  // first replenishes exactly one. A shallower depth, or the default queue of
  // one, yields a smaller number.
  const { device, deliver, transferInCalls } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 115200 });
  // The stream pulls as soon as it is constructed, which primes the queue.
  await tick();

  assert.equal(transferInCalls.length, 16, "the queue must be primed to full depth");

  for (let i = 0; i < 16; i += 1) {
    deliver({ status: "ok", data: new DataView(new Uint8Array([i]).buffer) });
    await tick();
  }

  assert.equal(
    transferInCalls.length,
    31,
    "16 queued up front plus one replenished per pull, with no reader attached",
  );
});

test("Cp2102SerialPort asks for exactly one packet per bulk IN transfer", async () => {
  // A bulk IN transfer ends on a short packet or on the full requested length.
  // Asking for more than a packet buys nothing once the queue is deep, and on
  // silicon that does not terminate a multi-packet transfer it strands every
  // reply whose length is an exact multiple of the packet size — the shape of
  // a fixed-size CHIRP clone block.
  const { device, transferInCalls } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 115200 });
  await tick();

  assert.ok(transferInCalls.length > 0, "expected the read path to queue a transfer");
  for (const call of transferInCalls) {
    assert.equal(call.endpointNumber, 1);
    assert.equal(call.length, 64, "bulk IN transfers must request exactly one packet");
  }
});

test("Cp2102SerialPort.close() purges the FIFOs and disables the UART", async () => {
  const { device, controlOut } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  controlOut.length = 0;

  await port.close();

  assert.deepEqual(controlOut, [
    // Both control lines low first, unconditionally: disabling the UART does
    // not reset these outputs (CP2102N A01 erratum E106), so skipping this can
    // leave DTR or RTS asserted into a radio until the cable is unplugged.
    { recipient: "interface", request: 0x07, value: 0x0300, index: 0, data: null },
    // PURGE both queues — the CP2108 occasionally hangs without it.
    { recipient: "interface", request: 0x12, value: 0x000f, index: 0, data: null },
    // Then disable the UART, which is also what clears event-insertion mode.
    { recipient: "interface", request: 0x00, value: 0x0000, index: 0, data: null },
  ]);
});

test("Cp2102SerialPort.close() still releases the device when the chip is gone", async () => {
  // Unplugging mid-session makes every control transfer throw. Teardown has to
  // reach releaseInterface/close anyway or the port object leaks the device.
  const { device } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  let released = false;
  let closed = false;
  device.controlTransferOut = async () => { throw new Error("device disconnected"); };
  device.releaseInterface = async () => { released = true; };
  device.close = async () => { closed = true; };

  await port.close();

  assert.ok(released, "interface must be released");
  assert.ok(closed, "device must be closed");
});

test("Cp2102SerialPort.setSignals keeps its shadow honest when a request fails", async () => {
  // The shadow is what setSignals consults to skip a no-op write. Committing it
  // before the request succeeds turns the caller's retry into a no-op against a
  // line that never moved — the radio stays unasserted and nothing reports it.
  const { device, controlOut } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  controlOut.length = 0;

  const working = device.controlTransferOut;
  device.controlTransferOut = async () => ({ status: "stall" });
  await assert.rejects(
    port.setSignals({ dataTerminalReady: true }),
    /control request 0x7 failed: stall/,
  );

  device.controlTransferOut = working;
  await port.setSignals({ dataTerminalReady: true });
  assert.deepEqual(controlOut.at(-1), {
    recipient: "interface", request: 0x07, value: 0x0101, index: 0, data: null,
  });
});

test("Cp2102SerialPort write path reports a stalled bulk OUT instead of losing bytes", async () => {
  // WebUSB resolves a failed bulk OUT with a status rather than rejecting, so a
  // write path that ignores the result reports success on a protocol block that
  // went nowhere. An upload has to fail visibly instead.
  const { device, outResults, clearHaltCalls } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  const writer = port.writable.getWriter();

  outResults.push({ status: "stall", bytesWritten: 0 });
  await assert.rejects(
    writer.write(new Uint8Array([1, 2, 3, 4])),
    /bulk OUT endpoint stalled after 0 of 4 bytes/,
  );
  // The endpoint is left usable for whatever the caller does next.
  assert.deepEqual(clearHaltCalls, [{ direction: "out", endpoint: 1 }]);
});

test("Cp2102SerialPort write path resumes a short bulk OUT transfer", async () => {
  // `bytesWritten` can be less than the chunk. Assuming a partial write was a
  // whole one drops the tail of a frame silently.
  const { device, outResults, transferOutCalls } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  const writer = port.writable.getWriter();

  outResults.push({ status: "ok", bytesWritten: 2 });
  await writer.write(new Uint8Array([1, 2, 3, 4, 5]));

  assert.deepEqual(transferOutCalls.map((c) => c.bytes), [
    [1, 2, 3, 4, 5],
    [3, 4, 5],
  ], "the remainder must be written from where the short transfer stopped");
});

test("Cp2102SerialPort write path gives up on a transfer that never progresses", async () => {
  const { device, outResults } = makeFakeDevice();
  const port = new Cp2102SerialPort(device);
  await port.open({ baudRate: 9600 });
  const writer = port.writable.getWriter();

  outResults.push({ status: "ok", bytesWritten: 0 });
  await assert.rejects(
    writer.write(new Uint8Array([1, 2, 3])),
    /wrote no bytes at offset 0 of 3/,
  );
});

test("Cp2102SerialPort.open() hands the device back when initialization fails", async () => {
  // A failure after claimInterface that leaves the interface claimed poisons
  // every retry: the next open fails at claimInterface with "another driver may
  // already control it", pointing at the wrong problem entirely.
  const { device } = makeFakeDevice();
  let released = 0;
  let closed = 0;
  const releaseInterface = device.releaseInterface;
  device.releaseInterface = async (...args) => { released += 1; return releaseInterface(...args); };
  device.close = async () => { closed += 1; };
  device.controlTransferOut = async () => ({ status: "stall" });

  const port = new Cp2102SerialPort(device);
  await assert.rejects(port.open({ baudRate: 9600 }), /control request 0x0 failed: stall/);
  assert.equal(released, 1, "the claimed interface must be released");
  assert.equal(closed, 1, "the device must be closed");

  // And a retry against a healthy chip now works.
  device.controlTransferOut = async () => ({ status: "ok" });
  await port.open({ baudRate: 9600 });
  assert.ok(port.readable);
});

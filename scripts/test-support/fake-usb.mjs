// Fake USBDevice scaffolding shared by the WebUSB chip driver tests
// (FTDI, PL2303, CH340, CP2102) and the loopback harness.
//
// Every chip fake needs the same skeleton: a configuration exposing one
// interface's endpoints, no-op open/claim/release/close, bulk IN transfers that
// stay pending until the test answers them, and a clearHalt that can cancel
// the outstanding queue the way Chromium does. What differs per chip — vendor
// ids, endpoint layout, control-transfer answer tables, bulk OUT behaviour —
// is passed in, so each test file keeps only the part that is about its chip.

// Blink surfaces a cancelled transfer as a rejected promise carrying
// AbortError, not as a result with a status — see CheckFatalTransferStatus in
// third_party/blink/renderer/modules/webusb/usb_device.cc.
export function cancelledTransfer() {
  return Object.assign(new Error("The transfer was cancelled."), { name: "AbortError" });
}

// A successful bulk IN result carrying the given payload bytes, in the shape
// WebUSB hands back (a DataView over the packet). Empty by default, which is
// what an idle CH340/PL2303/CP2102 endpoint completes with.
export function okTransfer(bytes = []) {
  return { status: "ok", data: new DataView(Uint8Array.from(bytes).buffer) };
}

// The bytes behind a control/bulk OUT payload as a plain array, whatever form
// the driver handed over (ArrayBuffer, typed array, DataView or nothing), so a
// test can deepEqual it against a literal.
export function bytesOf(data) {
  if (!data) {
    return null;
  }
  if (data instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return Array.from(data);
}

// An 18-byte USB device descriptor, the reply to GET_DESCRIPTOR(DEVICE). Only
// the words the PL2303 detection ladder reads are parameterised: bcdUSB at
// bytes 2-3, bDeviceClass at 4, bMaxPacketSize0 at 7, bcdDevice at 12-13.
export function deviceDescriptorBytes({ usbVersion, deviceClass, maxPacketSize0, deviceVersion }) {
  const bytes = new Uint8Array(18);
  bytes[0] = 18; // bLength
  bytes[1] = 0x01; // bDescriptorType: DEVICE
  bytes[2] = usbVersion & 0xff;
  bytes[3] = (usbVersion >> 8) & 0xff;
  bytes[4] = deviceClass;
  bytes[7] = maxPacketSize0;
  bytes[12] = deviceVersion & 0xff;
  bytes[13] = (deviceVersion >> 8) & 0xff;
  return bytes;
}

// Descriptor words that make detectPl2303Type() land on the classic HX
// (USB 1.1, bcdDevice 4.00) and on the HXN family (USB 2.0, bcdDevice 1.00).
export const PL2303_HX_DESCRIPTOR = {
  usbVersion: 0x110, deviceClass: 0, maxPacketSize0: 64, deviceVersion: 0x400,
};
export const PL2303_HXN_DESCRIPTOR = {
  usbVersion: 0x200, deviceClass: 0, maxPacketSize0: 64, deviceVersion: 0x100,
};

// A fake USBDevice whose bulk IN transfers stay pending until the test answers
// them, the way real hardware leaves a transfer outstanding until bytes
// arrive. A driver that keeps a queue is only observable against a fake that
// models the queue, so this cannot be a list of pre-baked results.
//
// The chip-specific request handlers (controlTransferIn, controlTransferOut,
// transferOut) are supplied by the caller and default to silent success.
// Returns the device plus the records the shared read-path tests look at:
//   clearHaltCalls  — every clearHalt(direction, endpoint)
//   transferInCalls — every transferIn(endpointNumber, length)
//   deliver(result) — answer the oldest unanswered bulk IN transfer
export function makeFakeUsbDevice({
  vendorId,
  productId,
  endpoints,
  interfaceNumber = 0,
  cancelOnClearHalt = false,
  controlTransferIn = async (setup, length) => (
    { status: "ok", data: new DataView(new ArrayBuffer(length)) }
  ),
  controlTransferOut = async () => ({ status: "ok" }),
  transferOut = async () => ({ status: "ok" }),
}) {
  const clearHaltCalls = [];
  const transferInCalls = [];
  // Transfers the driver has queued that the fake has not answered yet.
  const outstanding = [];
  const device = {
    vendorId,
    productId,
    configuration: {
      interfaces: [
        {
          interfaceNumber,
          alternate: { endpoints },
        },
      ],
    },
    open: async () => {},
    selectConfiguration: async () => {},
    claimInterface: async () => {},
    releaseInterface: async () => {},
    close: async () => {},
    controlTransferIn,
    controlTransferOut,
    clearHalt: async (direction, endpoint) => {
      clearHaltCalls.push({ direction, endpoint });
      if (cancelOnClearHalt) {
        // Chromium cancels every transfer outstanding on the interface before
        // it clears the endpoint, and Blink rejects a cancelled transfer with
        // AbortError rather than completing it with a status.
        for (const transfer of outstanding.splice(0)) {
          transfer.reject(cancelledTransfer());
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
    transferOut,
  };
  // Answer the oldest unanswered transfer — bulk transfers on one endpoint
  // complete in the order they were issued.
  const deliver = (result) => {
    outstanding.shift()?.resolve(result);
  };
  return { device, clearHaltCalls, transferInCalls, deliver };
}

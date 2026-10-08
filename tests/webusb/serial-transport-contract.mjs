import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PORT_OPTIONS,
  SERIAL_TRANSPORT_MEMBERS,
  assertSerialTransport,
  createDisconnectNotifier,
  watchUsbDisconnect,
} from "../../web/js/serial-transport.mjs";
import { makeEmitter } from "../support/fake-serial.mjs";

// The contract module on its own: what assertSerialTransport() accepts and how
// it reports a port that falls short, and the two loss helpers every transport
// builds its onDisconnect() from. Whether each real transport satisfies the
// contract is tests/webusb/serial-transport-conformance.mjs.

// The smallest object that satisfies every member, for the cases that take
// one away.
function minimalTransport(overrides = {}) {
  return {
    transport: "webserial",
    capabilities: { framing: true, signals: true, reconfigure: "reopen" },
    readable: null,
    writable: null,
    usbDevice: null,
    async open() {},
    async close() {},
    async setSignals() {},
    getInfo: () => ({}),
    onDisconnect: () => () => {},
    ...overrides,
  };
}

test("a port with every member passes and is handed back", () => {
  const port = minimalTransport();
  assert.equal(assertSerialTransport(port), port);
});

test("every missing member is named at once, not the first one found", () => {
  const port = minimalTransport();
  delete port.onDisconnect;
  delete port.usbDevice;
  delete port.getInfo;

  assert.throws(
    () => assertSerialTransport(port, "FakePort"),
    (error) => {
      assert.match(error.message, /^FakePort does not satisfy the serial transport contract/);
      assert.match(error.message, /3 member\(s\)/);
      for (const name of ["onDisconnect", "usbDevice", "getInfo"]) {
        assert.match(error.message, new RegExp(`\\n  ${name} \\(`));
      }
      return true;
    },
  );
});

test("a raw Web Serial-shaped port is refused for its undeclared capabilities", () => {
  // What every port used to be: open/close/streams/setSignals/getInfo by
  // convention, with framing support implied by a flag's absence.
  const raw = {
    readable: null,
    writable: null,
    async open() {},
    async close() {},
    async setSignals() {},
    getInfo: () => ({}),
  };
  assert.throws(() => assertSerialTransport(raw), /transport \(.*\n  capabilities \(.*\n  usbDevice \(.*\n  onDisconnect \(/s);
});

test("capabilities must name every field with a value the bridge can act on", () => {
  for (const capabilities of [
    { framing: true, signals: true },
    { framing: "yes", signals: true, reconfigure: "reopen" },
    { framing: true, signals: true, reconfigure: "restart" },
    null,
  ]) {
    assert.throws(
      () => assertSerialTransport(minimalTransport({ capabilities })),
      /capabilities \(/,
      JSON.stringify(capabilities),
    );
  }
});

test("an in-place reconfigure capability requires the method that does it", () => {
  const port = minimalTransport({
    capabilities: { framing: false, signals: false, reconfigure: "update" },
  });
  assert.throws(() => assertSerialTransport(port), /reconfigure \(a method/);
  port.reconfigure = async () => {};
  assert.equal(assertSerialTransport(port), port);
});

test("an unknown transport name and a non-object are refused", () => {
  assert.throws(() => assertSerialTransport(minimalTransport({ transport: "serial" })), /transport \(one of/);
  assert.throws(() => assertSerialTransport(null), /is not a serial transport: got null/);
});

test("the member list and the default options are frozen", () => {
  assert.ok(Object.isFrozen(SERIAL_TRANSPORT_MEMBERS));
  assert.ok(Object.isFrozen(DEFAULT_PORT_OPTIONS));
  assert.deepEqual(DEFAULT_PORT_OPTIONS, {
    dataBits: 8, stopBits: 1, parity: "none", flowControl: "none",
  });
});

test("the notifier reports a loss once, as {transport, port}, and only while armed", () => {
  const port = { transport: "webusb" };
  const notifier = createDisconnectNotifier(port);
  const seen = [];
  const unsubscribe = notifier.subscribe((payload) => seen.push(payload));

  assert.equal(notifier.fire(), false, "a loss before open is not reported");
  notifier.arm();
  assert.equal(notifier.fire(), true);
  assert.equal(notifier.fire(), false, "a second event for the same loss is not reported");
  assert.deepEqual(seen, [{ transport: "webusb", port }]);
  assert.equal(seen[0].port, port);

  notifier.arm();
  notifier.disarm();
  assert.equal(notifier.fire(), false, "a close disarms the report");

  unsubscribe();
  notifier.arm();
  notifier.fire();
  assert.equal(seen.length, 1, "an unsubscribed callback hears nothing");
});

test("a throwing subscriber does not keep the loss from the others", () => {
  const notifier = createDisconnectNotifier({ transport: "node" });
  const seen = [];
  notifier.subscribe(() => {
    throw new Error("broken sink");
  });
  notifier.subscribe((payload) => seen.push(payload.transport));
  notifier.arm();
  notifier.fire();
  assert.deepEqual(seen, ["node"]);
});

test("the USB watch matches the device by identity and stops cleanly", () => {
  const usb = makeEmitter();
  const device = { vendorId: 0x0403, productId: 0x6015 };
  let losses = 0;
  const stop = watchUsbDisconnect(usb, device, () => {
    losses += 1;
  });

  // Same ids, different adapter.
  usb.emit("disconnect", { device: { vendorId: 0x0403, productId: 0x6015 } });
  assert.equal(losses, 0);
  usb.emit("disconnect", { device });
  assert.equal(losses, 1);

  stop();
  assert.equal(usb.listenerCount("disconnect"), 0);
  // Without an event source (Node, no stand-in) there is nothing to watch.
  assert.doesNotThrow(() => watchUsbDisconnect(undefined, device, () => {})());
});

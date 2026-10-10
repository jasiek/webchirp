import assert from "node:assert/strict";
import test from "node:test";
import { NativeSerialPort } from "../../web/js/native-serial-port.ts";
import { SERIAL_PORT_OPEN_FAILED } from "../../web/js/serial-errors.ts";
import { makeEmitter } from "../support/fake-serial.mjs";
import { createEchoPort } from "../support/loopback-harness.mjs";

// A native port whose open() rejects the way Chromium does.
function refusingPort(name, message) {
  const nativePort = createEchoPort();
  nativePort.open = async () => {
    throw new DOMException(message, name);
  };
  return new NativeSerialPort(nativePort, { events: makeEmitter() });
}

test("a port the browser will not open is renamed SerialPortOpenFailedError", async () => {
  const message = "Failed to execute 'open' on 'SerialPort': Failed to open serial port.";
  await assert.rejects(refusingPort("NetworkError", message).open({ baudRate: 9600 }), (error) => {
    assert.equal(error.name, SERIAL_PORT_OPEN_FAILED);
    assert.equal(error.message, message);
    return true;
  });
});

test("other open failures pass through under the browser's name", async () => {
  await assert.rejects(
    refusingPort("InvalidStateError", "The port is already open.").open({ baudRate: 9600 }),
    { name: "InvalidStateError", message: "The port is already open." },
  );
});

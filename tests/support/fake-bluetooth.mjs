import { makeEmitter } from "./fake-serial.mjs";

// Model the verified dongle GATT surface, recording operation order and letting
// tests pause or reject an operation without substituting the serial provider.
export function makeBluetoothDongle({ onOperation = async () => {} } = {}) {
  const calls = [];
  const characteristics = new Map();

  // Copy payloads as the Bluetooth stack does, so later buffer mutation cannot
  // rewrite the history the test is checking.
  async function record(operation, bytes) {
    const call = { operation, ...(bytes ? { bytes: Array.from(bytes) } : {}) };
    calls.push(call);
    await onOperation(call);
  }

  // Use the same event-listener bookkeeping as the other serial test fakes.
  function characteristic(uuid, properties) {
    const value = makeEmitter({
      properties,
      async startNotifications() { await record(`${uuid}:subscribe`); return value; },
      async writeValueWithResponse(bytes) { await record(`${uuid}:response`, bytes); },
      async writeValueWithoutResponse(bytes) { await record(`${uuid}:command`, bytes); },
    });
    characteristics.set(uuid, value);
    return value;
  }

  const tx = characteristic("ff02", { writeWithoutResponse: true });
  const rx = characteristic("ff01", { indicate: true });
  const baud = characteristic("ae10", { write: true });
  const service = {
    async getCharacteristic(uuid) {
      const short = uuid.slice(4, 8);
      await record(`characteristic:${short}`);
      return characteristics.get(short);
    },
  };
  const device = makeEmitter({ name: "BF_Writer", gatt: {
    connected: false,
    async connect() { await record("connect"); this.connected = true; return this; },
    async getPrimaryService(uuid) { await record(`service:${uuid}`); return service; },
    disconnect() {
      calls.push({ operation: "disconnect" });
      if (this.connected) {
        this.connected = false;
        device.emit("gattserverdisconnected", { target: device });
      }
    },
  } });
  return {
    device, tx, rx, baud, calls,
    // Deliver the original DataView, including its byte window, as browsers do.
    notify(value) { rx.value = value; rx.emit("characteristicvaluechanged", { target: rx }); },
  };
}

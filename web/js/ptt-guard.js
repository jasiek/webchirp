// Some programming cables key the radio's PTT from the moment they get USB
// power (issue #60): the adapter chip's TX output rests low until a driver
// configures its UART, and on Kenwood-style two-pin cables (Baofeng UV-5R and
// friends) that same line doubles as the radio's PTT input — so the radio
// transmits an open carrier until *something* opens the port. The browser may
// not touch the adapter before the user grants access, but for cables that
// were granted before, this guard opens ("parks") the port the moment it
// appears, which configures the UART, lets TX idle at mark, and releases PTT.
//
// Parked ports stay open so TX stays driven. BrowserSerialBridge calls
// suspend() before it shows the port picker — the chosen port must not still
// be held — and resume() after a session is torn down.
//
// Native Web Serial only: WebUSB adapters need a chip-specific driver before
// their UART can be configured, and instantiating those outside a user-chosen
// connection is not worth the risk for the browsers that lack Web Serial.

const PARK_OPTIONS = Object.freeze({
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
});

export function createPttGuard({ serial, onLog } = {}) {
  const provider =
    serial ?? (typeof navigator !== "undefined" ? navigator.serial : undefined);
  const parked = new Set();
  let started = false;
  let suspended = false;
  // Every park/release runs through one chain, so a suspend() issued while
  // granted ports are still being opened cannot interleave with those opens.
  let chain = Promise.resolve();

  function log(message) {
    try {
      onLog?.(message);
    } catch {
      // A broken log sink must never take down the guard.
    }
  }

  function describePort(port) {
    const info = port?.getInfo?.() || {};
    const hex = (value) =>
      Number.isInteger(value) ? value.toString(16).padStart(4, "0").toUpperCase() : null;
    const vid = hex(info.usbVendorId);
    const pid = hex(info.usbProductId);
    return vid && pid ? `USB VID:PID 0x${vid}:0x${pid}` : "serial port";
  }

  function enqueue(op) {
    const next = chain.then(op);
    chain = next.catch(() => {});
    return next;
  }

  async function parkPort(port) {
    if (suspended || parked.has(port)) {
      return;
    }
    try {
      await port.open(PARK_OPTIONS);
      parked.add(port);
      log(
        `PTT guard: opened ${describePort(port)} so cables that key PTT `
        + "until the port is configured stop transmitting.",
      );
    } catch (error) {
      // Held by another app, gone again, or not openable — nothing to guard.
      log(`PTT guard: could not open ${describePort(port)} (${error?.message || error}).`);
    }
  }

  async function parkGrantedPorts() {
    let ports = [];
    try {
      ports = await provider.getPorts();
    } catch {
      return;
    }
    for (const port of ports) {
      await parkPort(port);
    }
  }

  async function releaseParked() {
    for (const port of Array.from(parked)) {
      parked.delete(port);
      try {
        await port.close();
      } catch {
        // Already closed or unplugged.
      }
    }
  }

  function portFromEvent(event) {
    const port = event?.port || event?.target;
    return typeof port?.open === "function" ? port : null;
  }

  function handleConnect(event) {
    const port = portFromEvent(event);
    if (port) {
      enqueue(() => parkPort(port));
    }
  }

  function handleDisconnect(event) {
    parked.delete(event?.port || event?.target);
  }

  // Park already-granted ports and watch for granted cables being plugged in.
  function start() {
    if (started || typeof provider?.getPorts !== "function") {
      return;
    }
    started = true;
    provider.addEventListener?.("connect", handleConnect);
    provider.addEventListener?.("disconnect", handleDisconnect);
    enqueue(() => parkGrantedPorts());
  }

  // Close every parked port and stop parking, so the port the user is about
  // to pick in the browser's chooser is free to open. Resolves once released.
  function suspend() {
    suspended = true;
    return enqueue(() => releaseParked());
  }

  // Re-park granted ports after the app's own serial session has ended.
  function resume() {
    if (!started || !suspended) {
      return Promise.resolve();
    }
    suspended = false;
    return enqueue(() => parkGrantedPorts());
  }

  return {
    start,
    suspend,
    resume,
    parkedCount: () => parked.size,
    // Resolves once everything queued so far has run (used by tests).
    flush: () => chain,
  };
}

// The serial port contract every transport implements, declared once.
//
// The serial bridge (web/js/serial-bridge.ts) drives a port through nothing
// but the members listed here, so native Web Serial (wrapped by
// web/js/native-serial-port.ts), the four WebUSB chip drivers (sharing
// web/js/webusb-transport.ts), the CDC polyfill wrapper
// (web/js/webusb-serial.ts), the Web Bluetooth port
// (web/js/webbluetooth-serial.ts) and the node-serialport adapter the CLI and
// test harness use (tests/support/node-serial-port.mjs) are interchangeable
// behind it. What a transport cannot do is a declared capability, read by the
// bridge, rather than a property the bridge has to probe for or an error it has
// to recognise.
//
// No DOM or navigator access at module scope: Node imports this too.
//
// The types below are the contract's single statement: every transport
// class declares implements SerialTransport, so tsc (npm run check:js)
// checks each one against them, and assertSerialTransport() checks the same
// members at runtime for ports tsc never sees (a test's stand-in, the Node
// adapter).

/** What open() and reconfigure() take, in Web Serial's spelling. */
export interface SerialOpenOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
}

/** Output control lines. An absent line is left as it is. */
export interface SerialSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
}

/**
 * What a transport can do, declared rather than discovered by trying.
 * Transports that only learn their adapter at open() (Web Bluetooth) answer
 * for the adapter they hold once open, and conservatively before.
 */
export interface SerialTransportCapabilities {
  /**
   * open() honours dataBits, stopBits and parity. A
   * transport that programs 8N1 whatever it is asked must say false, or a
   * driver's even parity is "applied" and every byte is misframed.
   */
  framing: boolean;
  /**
   * How a settings change lands:
   * "reopen" is close() then open() on the same port (Web Serial has no other
   * route); "update" is reconfigure(options) in place, with readable and
   * writable surviving it.
   */
  reconfigure: "reopen" | "update";
  /** setSignals() reaches DTR/RTS. */
  signals: boolean;
}

/**
 * The one shape a lost port is reported in, whatever the transport's own
 * event looks like.
 */
export interface SerialDisconnectPayload {
  /** The port's transport name. */
  transport: string;
  /** The port that went away. */
  port: SerialTransport;
}

/**
 * A serial port as the bridge sees it: Web Serial's SerialPort surface plus
 * the declarations every transport has to make explicitly.
 */
export interface SerialTransport {
  /** "webserial", "webusb", "webbluetooth" or "node". */
  transport: string;
  capabilities: SerialTransportCapabilities;
  open: (options: SerialOpenOptions) => Promise<void>;
  close: () => Promise<void>;
  /** Null while closed. */
  readable: ReadableStream<Uint8Array> | null;
  /** Null while closed. */
  writable: WritableStream<Uint8Array> | null;
  setSignals: (signals: SerialSignals) => Promise<void>;
  getInfo: () => {usbVendorId?: number, usbProductId?: number};
  /**
   * The USBDevice behind the port, or null
   * when there is none (native Web Serial, Bluetooth, node-serialport).
   */
  usbDevice: USBDevice | null;
  /**
   * Registers a callback for the loss of the open port and returns its
   * unsubscribe. Called once per loss, never for an intentional close().
   */
  onDisconnect: (callback: (payload: SerialDisconnectPayload) => void) => () => void;
  /** Required when capabilities.reconfigure is "update". */
  reconfigure?: (options: SerialOpenOptions) => Promise<void>;
  /**
   * How the debug panel names the port when
   * USB ids cannot (a Bluetooth adapter's profile, a tty path).
   */
  displayName?: string;
  /**
   * Drops bytes the transport
   * holds but has not delivered yet (the OS queue behind node-serialport).
   */
  discardInput?: () => Promise<void>;
  /** Input lines, where readable. */
  getSignals?: () => Promise<object>;
}

/** One-shot loss reporting, as createDisconnectNotifier() builds it. */
export interface DisconnectNotifier {
  /** What a transport's onDisconnect() forwards to. */
  subscribe: (callback: (payload: SerialDisconnectPayload) => void) => () => void;
  /** At the end of a successful open(). */
  arm: () => void;
  /** At the start of close(). */
  disarm: () => void;
  /** On loss; false when not armed. */
  fire: () => boolean;
}

/** One member of the contract and the test a port's value for it must pass. */
export interface SerialTransportMember {
  name: string;
  /** What a passing value looks like, for the error. */
  expect: string;
  check: (port: any) => boolean;
}

// The transport names a port may declare.
export const SERIAL_TRANSPORT_NAMES = Object.freeze(["webserial", "webusb", "webbluetooth", "node"]);

// The open() options that describe the character frame rather than its speed;
// a change to any of them needs capabilities.framing.
export const FRAMING_OPTIONS = Object.freeze(["dataBits", "stopBits", "parity"]);

// What a port is opened with before any driver has asked for something else.
// A clone starts from these every time: framing a previous clone's driver set
// (tk280 wants even parity, tg_uv2p two stop bits) must not be inherited by the
// next radio, which would corrupt every byte it reads. The browser and the
// node-serialport bridge both open from this one object.
export const DEFAULT_PORT_OPTIONS: Readonly<Omit<SerialOpenOptions, "baudRate">> = Object.freeze({
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
});

const RECONFIGURE_MODES = Object.freeze(["reopen", "update"]);

// True for a function-valued member; the methods every port must have.
function isFunction(value: unknown): value is Function {
  return typeof value === "function";
}

// True for a capabilities object whose every field is one the bridge can act
// on. A missing or misspelt field would otherwise read as undefined, which the
// bridge would have to guess about -- the probing this contract replaces.
function isCapabilities(value: any): value is SerialTransportCapabilities {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.framing === "boolean"
    && typeof value.signals === "boolean"
    && RECONFIGURE_MODES.includes(value.reconfigure);
}

// Every member the bridge relies on, each with the test it must pass. The
// streams and usbDevice only have to be present: they are legitimately null
// while the port is closed, or when no USBDevice exists.
export const SERIAL_TRANSPORT_MEMBERS: readonly Readonly<SerialTransportMember>[] = Object.freeze([
  Object.freeze({
    name: "transport",
    expect: `one of ${SERIAL_TRANSPORT_NAMES.join(", ")}`,
    check: (port) => SERIAL_TRANSPORT_NAMES.includes(port.transport),
  }),
  Object.freeze({
    name: "capabilities",
    expect: "{framing: boolean, signals: boolean, reconfigure: \"reopen\"|\"update\"}",
    check: (port) => isCapabilities(port.capabilities),
  }),
  Object.freeze({ name: "open", expect: "a method", check: (port) => isFunction(port.open) }),
  Object.freeze({ name: "close", expect: "a method", check: (port) => isFunction(port.close) }),
  Object.freeze({ name: "readable", expect: "a member (null while closed)", check: (
    port,
  ) => "readable" in port }),
  Object.freeze({ name: "writable", expect: "a member (null while closed)", check: (
    port,
  ) => "writable" in port }),
  Object.freeze({ name: "setSignals", expect: "a method", check: (port) => isFunction(port.setSignals) }),
  Object.freeze({ name: "getInfo", expect: "a method", check: (port) => isFunction(port.getInfo) }),
  Object.freeze({ name: "usbDevice", expect: "a member (USBDevice or null)", check: (
    port,
  ) => "usbDevice" in port }),
  Object.freeze({ name: "onDisconnect", expect: "a method", check: (port) => isFunction(port.onDisconnect) }),
  Object.freeze({
    name: "reconfigure",
    expect: "a method, since capabilities.reconfigure is \"update\"",
    check: (port) => port.capabilities?.reconfigure !== "update" || isFunction(port.reconfigure),
  }),
]);

// Throw naming every member the port is missing or has in the wrong shape,
// all at once, the way web/js/ui/dom.ts reports missing elements: a port that
// half-implements the contract is an authoring error, and finding its gaps one
// failed clone at a time is how the old by-convention interface drifted.
// Returns the port so a caller can assert and use it in one expression.
/**
 * @param port Anything claiming to be a port.
 * @param label How the error names it; the class name by default.
 */
export function assertSerialTransport(port: any, label: string = ""): SerialTransport {
  const name = label || port?.constructor?.name || "serial port";
  if (!port || typeof port !== "object") {
    throw new TypeError(`${name} is not a serial transport: got ${port === null ? "null" : typeof port}`);
  }
  const missing = SERIAL_TRANSPORT_MEMBERS
    .filter((member) => !member.check(port))
    .map((member) => `${member.name} (${member.expect})`);
  if (missing.length > 0) {
    throw new TypeError(
      `${name} does not satisfy the serial transport contract; `
      + `missing or invalid ${missing.length} member(s):\n  ${missing.join("\n  ")}`,
    );
  }
  return port;
}

// One-shot loss reporting shared by every transport, so each reports a loss
// the same way: once, as {transport, port}, and never for a close() it was
// asked to do. arm() at the end of a successful open(), disarm() at the start
// of close(); fire() from whatever the transport's own loss signal is.
/**
 * @param port The port the payload names.
 */
export function createDisconnectNotifier(port: SerialTransport): DisconnectNotifier {
  const callbacks: Set<(payload: SerialDisconnectPayload) => void> = new Set();
  let armed = false;
  return {
    // Register a callback; returns its unsubscribe, which is what the
    // contract's onDisconnect() hands back.
    subscribe(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    arm() {
      armed = true;
    },
    disarm() {
      armed = false;
    },
    // Report the loss to every subscriber, once per armed session. Returns
    // whether anything was reported, so a transport can tell a late event for
    // a port it already closed from a real loss.
    fire() {
      if (!armed) {
        return false;
      }
      armed = false;
      const payload = Object.freeze({ transport: port.transport, port });
      for (const callback of Array.from(callbacks)) {
        try {
          callback(payload);
        } catch {
          // A broken subscriber must not stop the others hearing of the loss.
        }
      }
      return true;
    },
  };
}

// Watch a WebUSB event source (navigator.usb, or a test's stand-in) for the
// loss of one USBDevice. WebUSB fires "disconnect" at navigator.usb naming the
// device, never at a port, so every WebUSB-backed transport matches by device
// identity here; a second adapter with the same ids is a different object and
// is ignored. Returns the function that stops watching. A missing source
// (Node without a stand-in) watches nothing.
/**
 * @param usbEvents navigator.usb, or a stand-in.
 * @returns Stops watching.
 */
export function watchUsbDisconnect(
  usbEvents: EventTarget | null | undefined,
  device: USBDevice | null | undefined,
  onLost: () => void,
): () => void {
  if (!usbEvents || typeof usbEvents.addEventListener !== "function" || !device) {
    return () => {};
  }
  const handler = (event: Event & { device?: USBDevice }) => {
    if (event?.device === device) {
      onLost();
    }
  };
  usbEvents.addEventListener("disconnect", handler);
  return () => {
    try {
      usbEvents.removeEventListener("disconnect", handler);
    } catch {
      // The watch is gone either way.
    }
  };
}

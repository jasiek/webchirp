// node-serialport wrapped to the serial transport contract
// (web/js/serial-transport.ts), so the agent CLI (scripts/radio-codeplug.ts)
// and the Pyodide suites drive a tty through the same SerialBridge
// (web/js/serial-bridge.ts) the browser uses. Lives with the harness because
// it is Node-only: it imports serialport, which no browser module may.
import { SerialPort } from "serialport";
import { FRAMING_OPTIONS, createDisconnectNotifier } from "../../web/js/serial-transport.ts";

// What node-serialport can do: the OS driver honours framing and DTR/RTS, and
// settings change on the open handle (update() for the rate; framing by
// reopening the handle underneath streams that stay put), so the bridge never
// has to release its reader for a mid-clone change.
export const NODE_SERIAL_CAPABILITIES = Object.freeze({
  framing: true,
  signals: true,
  reconfigure: "update",
});

// Turn one of node-serialport's callback methods into a promise.
function callPort(port, method, ...args) {
  return new Promise((resolve, reject) => {
    port[method](...args, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

// The constructor options node-serialport takes for a Web Serial option set.
function nodeOpenOptions(path, options) {
  return {
    path,
    baudRate: Number(options.baudRate) || 9600,
    dataBits: Number(options.dataBits) || 8,
    stopBits: Number(options.stopBits) || 1,
    parity: options.parity || "none",
    rtscts: options.flowControl === "hardware",
    autoOpen: false,
  };
}

export class NodeSerialPort {
  // SerialPortClass lets a test substitute serialport's SerialPortMock, which
  // runs the real stream code over MockBinding instead of a device.
  constructor(path, { SerialPortClass = SerialPort } = {}) {
    this.path = String(path || "");
    this._SerialPortClass = SerialPortClass;
    // The node-serialport handle; replaced when a framing change reopens it.
    this.nodePort = null;
    this.readable = null;
    this.writable = null;
    this._controller = null;
    this._options = null;
    // Last DTR/RTS sent. node-serialport's set() writes every line on each
    // call, defaulting the unnamed ones, so one-line changes are merged here.
    this._lines = null;
    this._lossNotifier = createDisconnectNotifier(this);
    this._onData = (chunk) => {
      if (chunk?.length && this._controller) {
        this._controller.enqueue(Uint8Array.from(chunk));
      }
    };
    // A close carrying a DisconnectedError is the device going away; one
    // without is our own close().
    this._onClose = (error) => {
      if (error?.disconnected) {
        this._controller?.error(new Error(`Serial port ${this.path} disconnected.`));
        this._controller = null;
        this._lossNotifier.fire();
      }
    };
  }

  get transport() {
    return "node";
  }

  get capabilities() {
    return NODE_SERIAL_CAPABILITIES;
  }

  // A tty has no USBDevice; the bridge names it by its path instead.
  get usbDevice() {
    return null;
  }

  get displayName() {
    return this.path;
  }

  getInfo() {
    return {};
  }

  // Contract: register a loss callback, get its unsubscribe back.
  onDisconnect(callback) {
    return this._lossNotifier.subscribe(callback);
  }

  // Open the tty and expose it as Web Serial-style streams. The streams belong
  // to this object, not to the handle, so a framing change can swap the
  // handle without the bridge noticing.
  async open(options = {}) {
    if (this.nodePort) {
      throw new Error(`Serial port ${this.path} is already open.`);
    }
    await this._openHandle(options);
    this.readable = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this._controller = null;
      },
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        const port = this.nodePort;
        if (!port) {
          throw new Error(`Serial port ${this.path} is not open.`);
        }
        // Drained, not just queued: a driver's next read times its reply from
        // here, and pyserial's write() returns once the bytes are with the OS.
        await callPort(port, "write", Buffer.from(chunk));
        await callPort(port, "drain");
      },
    });
    this._lossNotifier.arm();
  }

  async close() {
    this._lossNotifier.disarm();
    try {
      this._controller?.close();
    } catch {
      // Already closed or errored.
    }
    this._controller = null;
    await this._closeHandle();
    this.readable = null;
    this.writable = null;
    this._options = null;
    this._lines = null;
  }

  // Change settings on the open port. A rate change is update() on the
  // handle; a framing change needs a new handle, opened under the same
  // streams, with the control lines put back because the reopen dropped them.
  async reconfigure(options = {}) {
    const current = this._options || {};
    const framingChanged = [...FRAMING_OPTIONS, "flowControl"]
      .some((key) => options[key] !== current[key]);
    if (this.nodePort && !framingChanged) {
      if (Number(options.baudRate) !== Number(current.baudRate)) {
        await callPort(this.nodePort, "update", { baudRate: Number(options.baudRate) });
      }
      this._options = { ...options };
      return;
    }
    await this._closeHandle();
    await this._openHandle(options);
    if (this._lines) {
      await callPort(this.nodePort, "set", { ...this._lines });
    }
  }

  // Merge the named lines into the last state sent and send both.
  async setSignals(signals = {}) {
    if (!this.nodePort) {
      throw new Error(`Serial port ${this.path} is not open.`);
    }
    const lines = { ...(this._lines || { dtr: true, rts: true }) };
    if (signals.dataTerminalReady !== undefined) {
      lines.dtr = Boolean(signals.dataTerminalReady);
    }
    if (signals.requestToSend !== undefined) {
      lines.rts = Boolean(signals.requestToSend);
    }
    await callPort(this.nodePort, "set", lines);
    this._lines = lines;
  }

  // Drop what the OS has received but not delivered, so a clone's buffer
  // clear reaches below the stream.
  async discardInput() {
    if (this.nodePort?.isOpen) {
      await callPort(this.nodePort, "flush");
    }
  }

  // Construct and open a handle for options; on failure nothing is left held.
  async _openHandle(options) {
    const port = new this._SerialPortClass(nodeOpenOptions(this.path, options));
    port.on("data", this._onData);
    port.on("close", this._onClose);
    try {
      await callPort(port, "open");
    } catch (error) {
      port.off("data", this._onData);
      port.off("close", this._onClose);
      throw error;
    }
    this.nodePort = port;
    this._options = { ...options };
  }

  // Close the current handle, if any, without reporting it as a loss.
  async _closeHandle() {
    const port = this.nodePort;
    this.nodePort = null;
    if (!port) {
      return;
    }
    port.off("data", this._onData);
    port.off("close", this._onClose);
    if (port.isOpen) {
      await callPort(port, "close");
    }
  }
}

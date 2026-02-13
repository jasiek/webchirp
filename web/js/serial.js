// Parse user-entered hex byte text into a Uint8Array for serial writes.
function parseHex(input) {
  const text = String(input || "").trim();
  if (!text) {
    return new Uint8Array(0);
  }
  const parts = text
    .replace(/[^0-9a-fA-F]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    const value = Number.parseInt(parts[i], 16);
    if (Number.isNaN(value) || value < 0 || value > 255) {
      throw new Error(`Invalid hex byte: ${parts[i]}`);
    }
    out[i] = value;
  }
  return out;
}

// Convert a byte array into uppercase space-delimited hex for display/logging.
function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

// Concatenate two Uint8Array buffers into one contiguous buffer.
function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Manage Web Serial lifecycle and provide buffered byte-oriented I/O helpers.
export class BrowserSerialBridge {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readBuffer = new Uint8Array(0);
  }

  isSupported() {
    return "serial" in navigator;
  }

  async open(baudRate) {
    if (!this.isSupported()) {
      throw new Error("Web Serial is not supported in this browser.");
    }
    if (this.port) {
      return { connected: true, message: "Already connected." };
    }

    this.port = await navigator.serial.requestPort({});
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this._startReadLoop();
    return { connected: true, message: `Connected at ${baudRate} baud` };
  }

  async close() {
    if (!this.port) {
      return { connected: false, message: "No port connected." };
    }

    try {
      await this.reader?.cancel();
    } catch {
      // Ignore cancellation errors.
    }
    try {
      this.reader?.releaseLock();
    } catch {
      // Ignore lock-release errors.
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // Ignore lock-release errors.
    }
    try {
      await this.port.close();
    } catch {
      // Ignore close errors.
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readBuffer = new Uint8Array(0);
    return { connected: false, message: "Disconnected." };
  }

  async writeHex(hex) {
    if (!this.writer) {
      throw new Error("Port is not connected.");
    }
    const bytes = parseHex(hex);
    await this.writer.write(bytes);
    return { written: bytes.length, hex: bytesToHex(bytes) };
  }

  async writeBytes(bytesLike) {
    if (!this.writer) {
      throw new Error("Port is not connected.");
    }
    const bytes = Uint8Array.from(bytesLike || []);
    await this.writer.write(bytes);
    return { written: bytes.length };
  }

  async readHex(count, timeoutMs) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    const start = performance.now();
    while (this.readBuffer.length < count) {
      const elapsed = performance.now() - start;
      if (elapsed >= timeoutMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const available = Math.min(count, this.readBuffer.length);
    const out = this.readBuffer.slice(0, available);
    this.readBuffer = this.readBuffer.slice(available);
    return {
      read: out.length,
      hex: bytesToHex(out),
      timedOut: out.length < count,
    };
  }

  async readBytes(count, timeoutMs) {
    const result = await this.readHex(count, timeoutMs);
    const bytes = result.hex
      ? result.hex.split(/\s+/).filter(Boolean).map((part) => Number.parseInt(part, 16))
      : [];
    return bytes;
  }

  async prepareClone(wantsDtr, wantsRts, settleMs) {
    if (!this.port) {
      throw new Error("Port is not connected.");
    }
    this.readBuffer = new Uint8Array(0);
    try {
      await this.port.setSignals({
        dataTerminalReady: Boolean(wantsDtr),
        requestToSend: Boolean(wantsRts),
      });
    } catch {
      // Some adapters/browsers may not support control line changes.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(settleMs || 0))));
    return { prepared: true };
  }

  async _startReadLoop() {
    while (this.port && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          this.readBuffer = concatUint8(this.readBuffer, value);
        }
      } catch {
        break;
      }
    }
  }
}

// Build a serial RPC dispatcher used by worker-rpc bridge messages.
export function createSerialRpcHandler({ serialBridge, logSerial }) {
  return async function handleSerialRpc(msg) {
    const { op, payload } = msg;

    if (op === "open") {
      const res = await serialBridge.open(payload.baudRate);
      logSerial(res.message);
      return res;
    }
    if (op === "close") {
      const res = await serialBridge.close();
      logSerial(res.message);
      return res;
    }
    if (op === "writeHex") {
      const res = await serialBridge.writeHex(payload.hex);
      logSerial(`TX ${res.hex}`);
      return res;
    }
    if (op === "readHex") {
      const res = await serialBridge.readHex(payload.count, payload.timeoutMs);
      logSerial(`RX ${res.hex || "<none>"}${res.timedOut ? " (timeout)" : ""}`);
      return res;
    }
    if (op === "writeBytes") {
      return serialBridge.writeBytes(payload.bytes || []);
    }
    if (op === "readBytes") {
      return serialBridge.readBytes(payload.count, payload.timeoutMs);
    }
    if (op === "log") {
      logSerial(String(payload.message || ""));
      return { logged: true };
    }
    if (op === "prepareClone") {
      const res = await serialBridge.prepareClone(
        payload.wantsDtr,
        payload.wantsRts,
        payload.settleMs,
      );
      logSerial(
        `Prepared clone session (DTR=${Boolean(payload.wantsDtr)} RTS=${Boolean(payload.wantsRts)})`,
      );
      return res;
    }
    if (op === "resetBuffers") {
      serialBridge.readBuffer = new Uint8Array(0);
      return { reset: true };
    }

    throw new Error(`Unknown serial op: ${op}`);
  };
}

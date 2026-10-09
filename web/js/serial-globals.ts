import type { SerialBridge } from "./serial-bridge.ts";
import type { SerialOpenOptions } from "./serial-transport.ts";
import { errorFields } from "./error-details.ts";

// The serial_* functions CHIRP's Python imports from the js module, defined
// once for the browser (web/js/runtime-rpc.ts) and the Node harness
// (tests/support/radio-harness.mjs). web/python/typings/js.pyi declares the
// same names from the Python side; tests/webusb/serial-globals.mjs fails when
// the two lists disagree.
//
// Two layers, both shared: installSerialBridgeGlobals() turns each Python call
// into one {op, payload} message with its arguments normalised, and
// createSerialRpcHandler() answers those messages from a serial bridge
// (web/js/serial-bridge.ts), logging what the debug panel needs to see.

/**
 * One serial operation as it crosses from a Python serial_* call to the
 * bridge: the op name and its normalised arguments.
 */
export interface SerialRpcMessage {
  /** A key of the handler's op table ("open", "readBytes", ...). */
  op: string;
  payload?: SerialRpcPayload;
}

/**
 * An op's arguments, already normalised by SERIAL_GLOBAL_OPS below. Values
 * arrive from Python through Pyodide, so each handler reads only the keys its
 * own op sends.
 */
export type SerialRpcPayload = Record<string, any>;

/**
 * What answers SerialRpcMessages: createSerialRpcHandler()'s result, or a
 * test's stand-in.
 */
export type SerialRpcHandler = (msg: SerialRpcMessage) => Promise<unknown>;

export interface SerialRpcHandlerOptions {
  serialBridge: SerialBridge;
  /** The serial/debug log. */
  logSerial: (line: string) => void;
  /** Clone progress; cur and max are -1 when a driver reports no counts. */
  onProgress?: (cur: number, max: number, message: string) => void;
}

// Render a setSignals payload for the debug panel, naming only the lines the
// caller actually asked to change.
function describeSignals(payload: SerialRpcPayload = {}) {
  const parts: string[] = [];
  if (payload.dataTerminalReady !== null && payload.dataTerminalReady !== undefined) {
    parts.push(`DTR=${Boolean(payload.dataTerminalReady)}`);
  }
  if (payload.requestToSend !== null && payload.requestToSend !== undefined) {
    parts.push(`RTS=${Boolean(payload.requestToSend)}`);
  }
  return parts.length ? parts.join(" ") : "no lines";
}

// Name the port options a reconfigure actually changed, for the debug panel.
function describeOptions(options: Partial<SerialOpenOptions> = {}, changed: readonly string[] = []): string {
  const values: Record<string, unknown> = { ...options };
  const keys = changed.length ? changed : Object.keys(values);
  return keys.map((key) => `${key}=${values[key]}`).join(" ") || "no change";
}

// Build the handler that answers serial ops from a bridge. logSerial receives
// the lines meant for the serial/debug log; onProgress receives clone progress.
export function createSerialRpcHandler(
  { serialBridge, logSerial, onProgress }: SerialRpcHandlerOptions,
): SerialRpcHandler {
  async function handleOpen(payload: SerialRpcPayload = {}) {
    const res = await serialBridge.open(payload.baudRate);
    logSerial(res.message);
    return res;
  }

  async function handleClose() {
    const res = await serialBridge.close();
    logSerial(res.message);
    return res;
  }

  async function handleWriteHex(payload: SerialRpcPayload = {}) {
    const res = await serialBridge.writeHex(payload.hex);
    logSerial(`TX ${res.hex}`);
    return res;
  }

  async function handleReadHex(payload: SerialRpcPayload = {}) {
    const res = await serialBridge.readHex(payload.count, payload.timeoutMs);
    logSerial(`RX ${res.hex || "<none>"}${res.timedOut ? " (timeout)" : ""}`);
    return res;
  }

  async function handleWriteBytes(payload: SerialRpcPayload = {}) {
    return serialBridge.writeBytes(payload.bytes || []);
  }

  async function handleReadBytes(payload: SerialRpcPayload = {}) {
    return serialBridge.readBytes(payload.count, payload.timeoutMs);
  }

  async function handleLog(payload: SerialRpcPayload = {}) {
    logSerial(String(payload.message || ""));
    return { logged: true };
  }

  // CHIRP drivers report clone progress once per transferred block; forward
  // it to the UI (cur/max may be -1 when a driver reports no counts).
  async function handleProgress(payload: SerialRpcPayload = {}) {
    onProgress?.(Number(payload.cur), Number(payload.max), String(payload.msg || ""));
    return { reported: true };
  }

  async function handlePrepareClone(payload: SerialRpcPayload = {}) {
    const res = await serialBridge.prepareClone(
      payload.wantsDtr,
      payload.wantsRts,
      payload.settleMs,
      payload.baudRate,
    );
    // The baud rate belongs in this line because it is the one clone parameter
    // that can differ from what the user chose at Connect time; a mismatch
    // shows up as timeouts, and the log is where that gets diagnosed.
    logSerial(
      `Prepared clone session (DTR=${Boolean(payload.wantsDtr)} RTS=${Boolean(payload.wantsRts)}`
      + ` baud=${res.baudRate || "unchanged"}${res.baudRateChanged ? ", reopened" : ""})`,
    );
    return res;
  }

  // Control-line changes are advisory: adapters and browsers that cannot set
  // DTR/RTS must not abort a clone that would otherwise work, so a failure is
  // reported to the debug panel instead of propagating into the driver.
  async function handleSetSignals(payload: SerialRpcPayload = {}) {
    try {
      const res = await serialBridge.setSignals(
        payload.dataTerminalReady,
        payload.requestToSend,
      );
      if (res.applied) {
        logSerial(`Set control lines (${describeSignals(payload)})`);
      }
      return res;
    } catch (err) {
      logSerial(
        `Control lines unchanged (${describeSignals(payload)}): ${errorFields(err).message || err}`,
      );
      return { applied: false, error: String(errorFields(err).message || err) };
    }
  }

  // A rate change is not advisory the way DTR/RTS is. By the time a driver
  // assigns it the radio has already switched, so a port left at the old rate
  // cannot complete the clone -- a silent timeout ten seconds later is a much
  // worse diagnostic than the failure itself. This one propagates.
  async function handleReconfigure(payload: SerialRpcPayload = {}) {
    const res = await serialBridge.reconfigure(payload.options || {});
    if (res.reconfigured) {
      logSerial(`Reopened port (${describeOptions(res.options, res.changed)})`);
    }
    return res;
  }

  // Deliberately unlogged: a clone polls this once per byte, so echoing it to
  // the debug panel would bury every diagnostic the panel exists for.
  async function handleInWaiting(payload: SerialRpcPayload = {}) {
    return serialBridge.inWaiting(payload.waitMs);
  }

  // pyserial's reset_input_buffer(). Asked of the bridge rather than done to
  // its buffer from here, so a transport with a queue of its own drops it too.
  async function handleResetBuffers() {
    return serialBridge.resetBuffers();
  }

  async function handleGetPortInfo() {
    return serialBridge.getPortInfo();
  }

  const OP_HANDLERS: Readonly<Record<string, (payload: SerialRpcPayload) => Promise<unknown>>> = Object.freeze({
    open: handleOpen,
    close: handleClose,
    writeHex: handleWriteHex,
    readHex: handleReadHex,
    writeBytes: handleWriteBytes,
    readBytes: handleReadBytes,
    inWaiting: handleInWaiting,
    log: handleLog,
    progress: handleProgress,
    prepareClone: handlePrepareClone,
    setSignals: handleSetSignals,
    reconfigure: handleReconfigure,
    resetBuffers: handleResetBuffers,
    getPortInfo: handleGetPortInfo,
  });

  return async function handleSerialRpc(msg) {
    const { op, payload } = msg;
    const handler = OP_HANDLERS[op];
    if (!handler) {
      throw new Error(`Unknown serial op: ${op}`);
    }
    return handler(payload || {});
  };
}

// Pass a nullable line through as null, so a driver setting one line never
// implicitly clears the other.
function optionalBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}

/**
 * One serial_* global: Python's arguments in (whatever Pyodide converted them
 * to, so any), the op name and its normalised payload out.
 */
export type SerialGlobalOp = (...args: any[]) => [string, SerialRpcPayload];

// Each global Python can call, by the name it imports, mapped to the op and
// normalised payload it sends. Defaults live here, once: a read with no count
// asks for one byte within 1200 ms, a clone settles 350 ms unless told
// otherwise, and a driver that declares no BAUD_RATE sends 0, which the bridge
// reads as "keep the rate the port has".
const SERIAL_GLOBAL_OPS = Object.freeze({
  serial_open: (baudRate) => ["open", { baudRate: Number(baudRate) }],
  serial_close: () => ["close", {}],
  serial_write_hex: (hex) => ["writeHex", { hex: String(hex || "") }],
  serial_read_hex: (count, timeoutMs) => ["readHex", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  }],
  serial_write_bytes: (bytes) => ["writeBytes", { bytes: Array.from(bytes || []) }],
  serial_read_bytes: (count, timeoutMs) => ["readBytes", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  }],
  serial_in_waiting: (waitMs) => ["inWaiting", { waitMs: Number(waitMs || 0) }],
  serial_log: (message) => ["log", { message: String(message || "") }],
  serial_progress: (cur, max, msg) => ["progress", {
    cur: Number(cur),
    max: Number(max),
    msg: String(msg || ""),
  }],
  serial_prepare_clone: (wantsDtr, wantsRts, settleMs, baudRate) => ["prepareClone", {
    wantsDtr: Boolean(wantsDtr),
    wantsRts: Boolean(wantsRts),
    settleMs: Number(settleMs || 350),
    baudRate: Number(baudRate || 0),
  }],
  // Mid-clone control-line changes from CHIRP drivers; null means "no
  // opinion on this line yet".
  serial_set_signals: (dtr, rts) => ["setSignals", {
    dataTerminalReady: optionalBoolean(dtr),
    requestToSend: optionalBoolean(rts),
  }],
  // Mid-clone port reconfiguration (baud rate and framing). Only the fields
  // the pipe actually holds a value for are sent; the rest keep what the port
  // was opened with.
  serial_reconfigure: (baudRate, dataBits, stopBits, parity) => {
    const options: Record<string, number | string> = {};
    if (baudRate !== null && baudRate !== undefined) {
      options.baudRate = Number(baudRate);
    }
    if (dataBits !== null && dataBits !== undefined) {
      options.dataBits = Number(dataBits);
    }
    if (stopBits !== null && stopBits !== undefined) {
      options.stopBits = Number(stopBits);
    }
    if (parity !== null && parity !== undefined) {
      options.parity = String(parity);
    }
    return ["reconfigure", { options }];
  },
  serial_reset_buffers: () => ["resetBuffers", {}],
} satisfies Record<string, SerialGlobalOp>);

// The names installSerialBridgeGlobals() defines, for the typings check.
export const SERIAL_GLOBAL_NAMES = Object.freeze(Object.keys(SERIAL_GLOBAL_OPS));

// Define every serial_* function on target (globalThis in both environments),
// each forwarding one {op, payload} message to handleSerialRpc -- the function
// createSerialRpcHandler() returns, or anything answering the same messages.
// Installed before the runtime boots: Python binds these by name at import.
export function installSerialBridgeGlobals<T extends object>(
  target: T,
  handleSerialRpc: SerialRpcHandler,
): T {
  // The globals are defined by name, so the target is written as a record.
  const globals = target as Record<string, unknown>;
  const ops: [string, SerialGlobalOp][] = Object.entries(SERIAL_GLOBAL_OPS);
  for (const [name, toMessage] of ops) {
    globals[name] = (...args: unknown[]) => {
      const [op, payload] = toMessage(...args);
      return handleSerialRpc({ op, payload });
    };
  }
  return target;
}

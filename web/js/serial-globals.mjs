// The serial_* functions CHIRP's Python imports from the js module, defined
// once for the browser (web/js/runtime-rpc.ts) and the Node harness
// (tests/support/radio-harness.mjs). web/python/typings/js.pyi declares the
// same names from the Python side; tests/webusb/serial-globals.mjs fails when
// the two lists disagree.
//
// Two layers, both shared: installSerialBridgeGlobals() turns each Python call
// into one {op, payload} message with its arguments normalised, and
// createSerialRpcHandler() answers those messages from a serial bridge
// (web/js/serial-bridge.mjs), logging what the debug panel needs to see.

/**
 * One serial operation as it crosses from a Python serial_* call to the
 * bridge: the op name and its normalised arguments.
 * @typedef {Object} SerialRpcMessage
 * @property {string} op  A key of the handler's op table ("open", "readBytes", ...).
 * @property {Record<string, any>} [payload]
 */

/**
 * What answers SerialRpcMessages: createSerialRpcHandler()'s result, or a
 * test's stand-in.
 * @typedef {(msg: SerialRpcMessage) => Promise<unknown>} SerialRpcHandler
 */

/**
 * @typedef {Object} SerialRpcHandlerOptions
 * @property {import("./serial-bridge.mjs").SerialBridge} serialBridge
 * @property {(line: string) => void} logSerial  The serial/debug log.
 * @property {(cur: number, max: number, message: string) => void} [onProgress]
 *   Clone progress; cur and max are -1 when a driver reports no counts.
 */

// Render a setSignals payload for the debug panel, naming only the lines the
// caller actually asked to change.
function describeSignals(payload = {}) {
  const parts = [];
  if (payload.dataTerminalReady !== null && payload.dataTerminalReady !== undefined) {
    parts.push(`DTR=${Boolean(payload.dataTerminalReady)}`);
  }
  if (payload.requestToSend !== null && payload.requestToSend !== undefined) {
    parts.push(`RTS=${Boolean(payload.requestToSend)}`);
  }
  return parts.length ? parts.join(" ") : "no lines";
}

// Name the port options a reconfigure actually changed, for the debug panel.
function describeOptions(options = {}, changed = []) {
  const keys = changed.length ? changed : Object.keys(options);
  return keys.map((key) => `${key}=${options[key]}`).join(" ") || "no change";
}

// Build the handler that answers serial ops from a bridge. logSerial receives
// the lines meant for the serial/debug log; onProgress receives clone progress.
/**
 * @param {SerialRpcHandlerOptions} options
 * @returns {SerialRpcHandler}
 */
export function createSerialRpcHandler({ serialBridge, logSerial, onProgress }) {
  async function handleOpen(payload = {}) {
    const res = await serialBridge.open(payload.baudRate);
    logSerial(res.message);
    return res;
  }

  async function handleClose() {
    const res = await serialBridge.close();
    logSerial(res.message);
    return res;
  }

  async function handleWriteHex(payload = {}) {
    const res = await serialBridge.writeHex(payload.hex);
    logSerial(`TX ${res.hex}`);
    return res;
  }

  async function handleReadHex(payload = {}) {
    const res = await serialBridge.readHex(payload.count, payload.timeoutMs);
    logSerial(`RX ${res.hex || "<none>"}${res.timedOut ? " (timeout)" : ""}`);
    return res;
  }

  async function handleWriteBytes(payload = {}) {
    return serialBridge.writeBytes(payload.bytes || []);
  }

  async function handleReadBytes(payload = {}) {
    return serialBridge.readBytes(payload.count, payload.timeoutMs);
  }

  async function handleLog(payload = {}) {
    logSerial(String(payload.message || ""));
    return { logged: true };
  }

  // CHIRP drivers report clone progress once per transferred block; forward
  // it to the UI (cur/max may be -1 when a driver reports no counts).
  async function handleProgress(payload = {}) {
    onProgress?.(Number(payload.cur), Number(payload.max), String(payload.msg || ""));
    return { reported: true };
  }

  async function handlePrepareClone(payload = {}) {
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
  async function handleSetSignals(payload = {}) {
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
        `Control lines unchanged (${describeSignals(payload)}): ${err?.message || err}`,
      );
      return { applied: false, error: String(err?.message || err) };
    }
  }

  // A rate change is not advisory the way DTR/RTS is. By the time a driver
  // assigns it the radio has already switched, so a port left at the old rate
  // cannot complete the clone -- a silent timeout ten seconds later is a much
  // worse diagnostic than the failure itself. This one propagates.
  async function handleReconfigure(payload = {}) {
    const res = await serialBridge.reconfigure(payload.options || {});
    if (res.reconfigured) {
      logSerial(`Reopened port (${describeOptions(res.options, res.changed)})`);
    }
    return res;
  }

  // Deliberately unlogged: a clone polls this once per byte, so echoing it to
  // the debug panel would bury every diagnostic the panel exists for.
  async function handleInWaiting(payload = {}) {
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

  const OP_HANDLERS = Object.freeze({
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
/**
 * @param {unknown} value
 * @returns {boolean|null}
 */
function optionalBoolean(value) {
  return value === null || value === undefined ? null : Boolean(value);
}

// Each global Python can call, by the name it imports, mapped to the op and
// normalised payload it sends. Defaults live here, once: a read with no count
// asks for one byte within 1200 ms, a clone settles 350 ms unless told
// otherwise, and a driver that declares no BAUD_RATE sends 0, which the bridge
// reads as "keep the rate the port has".
/** @typedef {(...args: any[]) => [string, Record<string, any>]} SerialGlobalOp */
const SERIAL_GLOBAL_OPS = Object.freeze(/** @satisfies {Record<string, SerialGlobalOp>} */ ({
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
    /** @type {Record<string, number|string>} */
    const options = {};
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
}));

// The names installSerialBridgeGlobals() defines, for the typings check.
export const SERIAL_GLOBAL_NAMES = Object.freeze(Object.keys(SERIAL_GLOBAL_OPS));

// Define every serial_* function on target (globalThis in both environments),
// each forwarding one {op, payload} message to handleSerialRpc -- the function
// createSerialRpcHandler() returns, or anything answering the same messages.
// Installed before the runtime boots: Python binds these by name at import.
/**
 * @template {object} T
 * @param {T} target
 * @param {SerialRpcHandler} handleSerialRpc
 * @returns {T}
 */
export function installSerialBridgeGlobals(target, handleSerialRpc) {
  /** @type {[string, SerialGlobalOp][]} */
  const ops = Object.entries(SERIAL_GLOBAL_OPS);
  for (const [name, toMessage] of ops) {
    target[name] = (...args) => {
      const [op, payload] = toMessage(...args);
      return handleSerialRpc({ op, payload });
    };
  }
  return target;
}

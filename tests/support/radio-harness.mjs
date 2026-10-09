import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { seedPyodideRuntime } from "../../web/js/python-sources.ts";
import { rpcDispatcherFor } from "../../web/js/rpc-dispatch.ts";
import { SerialBridge } from "../../web/js/serial-bridge.ts";
import {
  createSerialRpcHandler,
  installSerialBridgeGlobals,
} from "../../web/js/serial-globals.ts";
import { createLocalPythonSource } from "./chirp-bundle-source.mjs";
import { NodeSerialPort } from "./node-serial-port.mjs";
import { startPythonCoverage } from "./python-coverage.mjs";

// The test-only flattening of the bridge package into Pyodide's globals, run
// after the production seed so runPython() snippets can keep calling bridge
// functions by bare name. See the docstring in that file for why it is here
// and not in web/python.
const BRIDGE_NAMESPACE_PYTHON_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bridge_namespace.py",
);

function decodeBase64ToBytes(base64Text) {
  return Uint8Array.from(Buffer.from(String(base64Text || ""), "base64"));
}

function encodeBytesToBase64(bytesLike) {
  return Buffer.from(Array.from(bytesLike || []).map((value) => Number(value) & 0xff)).toString(
    "base64",
  );
}

// The serial bridge behind the agent CLI and serialMode "node": the browser's
// SerialBridge (web/js/serial-bridge.ts) with a transport factory that opens
// the tty through node-serialport (tests/support/node-serial-port.mjs) instead
// of showing a chooser. Everything else -- buffering, re-rating, mid-clone
// reconfigure, control lines -- is the same code the browser runs.
// SerialPortClass is for tests, which pass serialport's SerialPortMock.
export class NodeSerialBridge extends SerialBridge {
  /**
   * @param {string} portPath  The tty, e.g. /dev/ttyUSB0.
   * @param {{SerialPortClass?: typeof import("serialport").SerialPort}} [options]
   */
  constructor(portPath, { SerialPortClass } = {}) {
    super({
      requestTransport: async () => new NodeSerialPort(portPath, { SerialPortClass }),
    });
    this.portPath = String(portPath || "");
  }
}

class StubSerialBridge {
  constructor() {
    // Recorded so tests can assert what the Python bridge asked for — the
    // driver's baud rate in particular, which nothing else observes.
    this.prepareCloneCalls = [];
    // Every setSignals() call, in order, so tests can assert that a driver's
    // control-line changes actually reached the transport (issue #77).
    this.signalCalls = [];
    // Every reconfigure() the pipe actually pushed, in order. The stub opens at
    // no particular rate, so it reports every call as a change.
    this.reconfigureCalls = [];
  }

  async open() {
    return { connected: true, message: "stub open" };
  }

  async close() {
    return { connected: false, message: "stub close" };
  }

  async writeHex() {
    return { written: 0, hex: "" };
  }

  async readHex() {
    return { read: 0, hex: "", timedOut: true };
  }

  async writeBytes() {
    return { written: 0 };
  }

  async readBytes() {
    return [];
  }

  async inWaiting() {
    return { available: 0 };
  }

  async resetBuffers() {
    return { reset: true };
  }

  async prepareClone(wantsDtr, wantsRts, settleMs, baudRate) {
    this.prepareCloneCalls.push({
      wantsDtr: Boolean(wantsDtr),
      wantsRts: Boolean(wantsRts),
      settleMs: Number(settleMs || 0),
      baudRate: Number(baudRate || 0),
    });
    return { prepared: true, settleMs: 0, baudRate: Number(baudRate || 0) };
  }

  async setSignals(dataTerminalReady, requestToSend) {
    this.signalCalls.push({ dataTerminalReady, requestToSend });
    return { applied: true };
  }

  async reconfigure(options = {}) {
    this.reconfigureCalls.push({ ...options });
    return { reconfigured: true, options, changed: Object.keys(options) };
  }
}

// The serial_* globals Python imports, installed by the same code the browser
// uses (web/js/serial-globals.ts) and answered by this harness's bridge. Log
// lines go to stdout, where the CLI's user and a failing test's output show
// them; clone progress has no UI here.
function installSerialGlobals(serialBridge, target = globalThis) {
  installSerialBridgeGlobals(target, createSerialRpcHandler({
    serialBridge,
    logSerial: (message) => console.log(`[SERIAL] ${String(message || "")}`),
    onProgress: () => {},
  }));
}

/**
 * @typedef {Object} TestRadioHarnessOptions
 * @property {string} [repoRoot]  The process's cwd by default.
 * @property {string} [chirpDir]
 * @property {string} [driverSet]
 * @property {string} [portPath]  The tty serialMode "node" opens.
 * @property {string} [serialMode]  "stub" or "node".
 * @property {{close(): Promise<unknown>}|null} [serialBridge]  A bridge of the
 *   caller's own; anything answering what createSerialRpcHandler() calls.
 * @property {boolean} [isolated]  createTestRadioHarness(): never share a boot.
 */

export class TestRadioHarness {
  // serialBridge lets a caller supply its own bridge object - a simulated
  // radio, say - in place of the stub or the real serial port. It only has to
  // answer the bridge methods createSerialRpcHandler() calls
  // (web/js/serial-globals.ts).
  /** @param {TestRadioHarnessOptions} [options] */
  constructor({
    repoRoot,
    chirpDir = "",
    driverSet = "chirp",
    portPath = "",
    serialMode = "stub",
    serialBridge = null,
  } = {}) {
    this.repoRoot = path.resolve(String(repoRoot || process.cwd()));
    this.chirpDir = String(chirpDir || "");
    this.driverSet = String(driverSet || "chirp");
    this.portPath = String(portPath || "");
    this.serialMode = String(serialMode || "stub");
    this.pythonSource = null;
    this.pyodide = null;
    this.serialBridge = serialBridge;
    // Open radio sessions by "module:class", so the codeplug methods below
    // open one session per driver and reuse it -- a download's image has to
    // be there for the upload that follows, the way it is in the browser.
    this.sessionIds = new Map();
  }

  async init() {
    if (this.pyodide) {
      return this;
    }
    this.pythonSource = await createLocalPythonSource({
      repoRoot: this.repoRoot,
      chirpDir: this.chirpDir,
      driverSet: this.driverSet,
    });

    if (!this.serialBridge) {
      this.serialBridge =
        this.serialMode === "node"
          ? new NodeSerialBridge(this.portPath)
          : new StubSerialBridge();
    }
    installSerialGlobals(this.serialBridge);

    this.pyodide = await loadPyodide();
    // Before the seed, not after: the bridge's module-level code only counts
    // as executed if the tracer is already running when it is imported. A
    // no-op unless WEBCHIRP_PY_COVERAGE names an output directory.
    await startPythonCoverage(this.pyodide);
    await seedPyodideRuntime(this.pyodide, this.pythonSource);
    await this.pyodide.runPythonAsync(
      await fs.readFile(BRIDGE_NAMESPACE_PYTHON_PATH, "utf8"),
    );
    return this;
  }

  // Call one runtime method the way the browser does: through rpc_dispatch
  // (web/python/webchirp_bridge/rpc.py) with named parameters checked
  // against RPC_METHODS (web/js/rpc-dispatch.ts). The harness's own
  // codeplug methods below go this way, so a test that uses them exercises
  // the production contract rather than a snippet of its own.
  async rpc(name, params = {}) {
    return rpcDispatcherFor(await this.interpreter()).call(name, params);
  }

  // The seeded interpreter, booting it first. init() either sets it or
  // throws, so the check only names a harness whose boot went wrong instead
  // of handing a null to the dispatcher.
  async interpreter() {
    await this.init();
    if (!this.pyodide) {
      throw new Error("The test radio harness has no Pyodide runtime after init()");
    }
    return this.pyodide;
  }

  // Run Python in the seeded runtime and hand back whatever the last
  // expression evaluates to. Exists so tests that want a bare call -- an
  // import that is expected to raise, say -- do not have to reach into
  // harness.pyodide for it. vars are bound as Python globals first. The
  // snippet sees every bridge name flattened into the globals by
  // tests/support/bridge_namespace.py; production code does not.
  async runPython(python, vars = {}) {
    const pyodide = await this.interpreter();
    for (const [key, value] of Object.entries(vars)) {
      pyodide.globals.set(key, value);
    }
    return pyodide.runPythonAsync(python);
  }

  async runPythonJson(python, vars = {}) {
    return JSON.parse(await this.runPython(python, vars));
  }

  // The open session for a driver, opened on first use and reused after --
  // the browser does the same for the selected radio. Returns the session id
  // every radio-bound RPC method takes.
  async session(moduleName, className) {
    const key = `${moduleName}:${className}`;
    if (!this.sessionIds.has(key)) {
      await this.rpc("ensure_radio_module", { module_short_name: moduleName });
      const opened = await this.rpc("open_session", {
        module_name: moduleName,
        class_name: className,
      });
      this.sessionIds.set(key, opened.sessionId);
    }
    return this.sessionIds.get(key);
  }

  // Make a session the one the codeplug methods use for its driver, closing
  // the one they used before. An image load opens a session of its own for
  // the driver the image names, and the write that follows has to see that
  // image rather than whatever the driver's earlier session held.
  async adoptSession(moduleName, className, sessionId) {
    const key = `${moduleName}:${className}`;
    const previous = this.sessionIds.get(key);
    if (previous && previous !== sessionId) {
      await this.rpc("close_session", { session_id: previous });
    }
    this.sessionIds.set(key, sessionId);
  }

  // Close a driver's session, so a later call opens a fresh one with no image.
  async closeSession(moduleName, className) {
    const key = `${moduleName}:${className}`;
    const sessionId = this.sessionIds.get(key);
    this.sessionIds.delete(key);
    if (sessionId) {
      await this.rpc("close_session", { session_id: sessionId });
    }
  }

  // The identity and line rate of one driver class, read off the class the
  // way the CLI needs them before it opens the port. No RPC method exposes
  // this -- the browser reads the same fields from the catalog -- so it stays
  // a snippet, importing from the owning module explicitly.
  async getRadioInfo(moduleName, className) {
    await this.rpc("ensure_radio_module", { module_short_name: moduleName });
    return this.runPythonJson(
      `
from webchirp_bridge.session import _import_radio_class
_cls = _import_radio_class(_sel_module, _sel_class)
_baud = int(getattr(_cls, "BAUD_RATE", 0) or 9600)
json.dumps({
  "vendor": str(getattr(_cls, "VENDOR", "")),
  "model": str(getattr(_cls, "MODEL", "")),
  "baudRate": _baud,
})
      `,
      { _sel_module: moduleName, _sel_class: className },
    );
  }

  /**
   * @param {{moduleName?: string, className?: string, baudRate?: number}} [options]
   *   baudRate: the driver's own when absent.
   */
  async connect({ moduleName, className, baudRate } = {}) {
    const radioInfo =
      moduleName && className ? await this.getRadioInfo(moduleName, className) : null;
    const effectiveBaud = Number.isFinite(Number(baudRate))
      ? Number(baudRate)
      : Number(radioInfo?.baudRate || 9600);
    return this.rpc("webserial_connect", { baudrate: effectiveBaud });
  }

  async disconnect() {
    try {
      return await this.rpc("webserial_disconnect");
    } catch (error) {
      try {
        await this.serialBridge?.close();
      } catch {
        // no-op
      }
      throw error;
    }
  }

  async readCodeplug(moduleName, className) {
    return this.rpc("download_selected_radio", {
      session_id: await this.session(moduleName, className),
    });
  }

  async writeCodeplug(moduleName, className, rows, settingsGroups = []) {
    const codeplug =
      rows && typeof rows === "object" && !Array.isArray(rows) ? rows : null;
    const normalizedRows = codeplug ? codeplug.rows || [] : rows || [];
    const normalizedSettings = codeplug ? codeplug.settings || [] : settingsGroups || [];
    return this.rpc("upload_selected_radio", {
      session_id: await this.session(moduleName, className),
      rows: normalizedRows,
      settings_groups: normalizedSettings,
    });
  }

  async readCodeplugBinary(moduleName, className) {
    const result = await this.rpc("get_cached_image_base64", {
      session_id: await this.session(moduleName, className),
    });
    return {
      ...result,
      image: decodeBase64ToBytes(result.imageBase64),
    };
  }

  async exportCodeplugBinary(moduleName, className, rows, settingsGroups = []) {
    const codeplug =
      rows && typeof rows === "object" && !Array.isArray(rows) ? rows : null;
    const normalizedRows = codeplug ? codeplug.rows || [] : rows || [];
    const normalizedSettings = codeplug ? codeplug.settings || [] : settingsGroups || [];
    const result = await this.rpc("export_image_base64", {
      session_id: await this.session(moduleName, className),
      rows: normalizedRows,
      settings_groups: normalizedSettings,
    });
    return {
      ...result,
      image: decodeBase64ToBytes(result.imageBase64),
    };
  }

  // Load an image the way the browser does: the runtime opens a session for
  // the driver the image names, and that session becomes the one the other
  // codeplug methods use for that driver.
  async loadCodeplugBinary(imageBytes) {
    const result = await this.rpc("load_image_base64", {
      image_b64: encodeBytesToBase64(imageBytes),
    });
    await this.adoptSession(result.module, result.className, result.sessionId);
    return {
      ...result,
      image: Uint8Array.from(imageBytes || []),
    };
  }

  async writeCodeplugBinary(moduleName, className, imageBytes) {
    const loaded = await this.loadCodeplugBinary(imageBytes);
    if (String(loaded.module || "") !== String(moduleName || "")) {
      throw new Error(
        `Binary image driver mismatch: expected module ${moduleName}, got ${loaded.module || "<unknown>"}`,
      );
    }
    if (String(loaded.className || "") !== String(className || "")) {
      throw new Error(
        `Binary image driver mismatch: expected class ${className}, got ${loaded.className || "<unknown>"}`,
      );
    }
    return this.writeCodeplug(moduleName, className, loaded);
  }
}

// Booted harnesses by their serializable options, so a test file that asks
// for the same runtime from several tests gets one boot rather than one per
// test. Holds the init() promise, not the harness, so concurrent first calls
// share a single boot too.
const sharedHarnesses = new Map();

// The cache key: everything that shapes the runtime and can be compared by
// value. A custom serialBridge is an object identity, so it is never keyed.
/** @param {TestRadioHarnessOptions} [options] */
function harnessCacheKey({
  repoRoot,
  chirpDir = "",
  driverSet = "chirp",
  portPath = "",
  serialMode = "stub",
} = {}) {
  return JSON.stringify({
    repoRoot: path.resolve(String(repoRoot || process.cwd())),
    chirpDir: String(chirpDir || ""),
    driverSet: String(driverSet || "chirp"),
    portPath: String(portPath || ""),
    serialMode: String(serialMode || "stub"),
  });
}

// Sharing is the default for two reasons. A Pyodide boot plus the runtime seed
// costs about 1.3 s, and a file with eight tests was paying that eight times
// over. And every boot writes the serial_* callables to
// globalThis, so the second harness in a process repoints those globals at its
// own bridge; the first harness's Python keeps the callables it bound at seed
// time, but anything in JS that reads them afterwards sees the newest bridge.
// One harness per option set sidesteps both.
//
// Pass isolated: true for a fresh boot when a test mutates Python state that a
// later test in the same file must not see -- importing every driver, say,
// when the next test asserts that a driver is still absent. A custom
// serialBridge always gets its own harness, since the bridge is the point.
/**
 * @param {TestRadioHarnessOptions} [options]
 * @returns {Promise<TestRadioHarness>}
 */
export async function createTestRadioHarness(options = {}) {
  const { isolated = false, ...harnessOptions } = options;
  if (isolated || harnessOptions.serialBridge) {
    return new TestRadioHarness(harnessOptions).init();
  }
  const key = harnessCacheKey(harnessOptions);
  if (!sharedHarnesses.has(key)) {
    const booting = new TestRadioHarness(harnessOptions).init().catch((error) => {
      // A failed boot must not be handed to every later caller.
      sharedHarnesses.delete(key);
      throw error;
    });
    sharedHarnesses.set(key, booting);
  }
  return sharedHarnesses.get(key);
}

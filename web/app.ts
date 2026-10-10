import { BrowserSerialBridge } from "./js/serial.ts";
import { createSerialRpcHandler } from "./js/serial-globals.ts";
import { createRuntimeRpcClient } from "./js/runtime-rpc.ts";
import { createUiController } from "./js/ui.ts";
import { installTooltips } from "./js/tooltip.ts";
import { registerOfflineSupport } from "./js/offline.ts";
import { deferAnalytics, replayDeferredAnalytics, trackEvent } from "./js/ui/analytics.ts";
import { WEBUSB_SUPPORTED_ADAPTERS } from "./js/webusb-serial.ts";

installTooltips();
const ui = createUiController();
const serialBridge = new BrowserSerialBridge();
const serialRpcHandler = createSerialRpcHandler({
  serialBridge,
  logSerial: ui.logSerial,
  onProgress: ui.updateCloneProgress,
});

const rpcClient = createRuntimeRpcClient({
  handleSerialRpc: serialRpcHandler,
  logDebug: ui.logDebug,
  onProgress: ui.beginProgress,
  onRuntimeCrash: ui.onRuntimeCrash,
});

ui.setRuntimeApi(rpcClient);

// Read-path diagnostics (loop death, USB stats) go to the serial log.
serialBridge.onDebug = (message) => ui.logSerial(message);
// An adapter can vanish mid-session — unplugged, or powered down with the radio.
// The bridge closes the port itself; this is what tells the UI to stop offering
// clone actions against it.
serialBridge.onPortLost = ({ deviceName, reason } = {}) => ui.onSerialPortLost(deviceName, reason);

const serialCapability = serialBridge.getCapability();
ui.setSerialController({
  capability: serialCapability,
  setPreferredTransport: (transport) => serialBridge.setPreferredTransport(transport),
});
// Pyodide's run_sync — how CHIRP's blocking clone loops wait on the serial
// bridge — needs WebAssembly JSPI (stack switching). Nothing else does: the
// drivers import from the mounted CHIRP archive, so a browser without JSPI
// (Firefox before 152, Safari, Chrome before 137) still boots, edits files and
// exports images; only the download/upload path is refused, at the point the
// user starts it, with an explanation instead of a bare traceback.
const jspiSupported =
  typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
ui.init(serialCapability.supported, jspiSupported);
if (serialCapability.webusb && !serialCapability.native) {
  ui.logSerial(
    "This browser has no native Web Serial; wired serial connections use WebUSB. "
    + `WebUSB supports ${WEBUSB_SUPPORTED_ADAPTERS}; `
    + "other vendor-specific UART chips are not supported yet.",
  );
} else if (serialCapability.webusb && serialCapability.native
  && /\bAndroid\b/i.test(navigator.userAgent || "")) {
  ui.logSerial(
    "Android detected with native Web Serial: use WebSerial for Bluetooth "
    + "serial ports, or WebUSB for wired USB adapters "
    + `(${WEBUSB_SUPPORTED_ADAPTERS}).`,
  );
}
if (serialCapability.webbluetooth) {
  ui.logSerial("Use WebBluetooth for a BT-1AD BLE programming dongle used with Ola Radio.");
}
// Keep this version cached so the next visit loads without a network.
void registerOfflineSupport({
  logDebug: ui.logDebug,
  trackEvent: (name, params) => trackEvent(name, params),
  replay: { defer: () => deferAnalytics(), replay: () => replayDeferredAnalytics() },
});

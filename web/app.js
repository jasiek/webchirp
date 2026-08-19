import { BrowserSerialBridge, createSerialRpcHandler } from "./js/serial.js";
import { createRuntimeRpcClient } from "./js/runtime-rpc.js";
import { createUiController } from "./js/ui.js";
import { installTooltips } from "./js/tooltip.js";
import { WEBUSB_SUPPORTED_ADAPTERS } from "./js/webusb-serial.js";

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

const serialCapability = serialBridge.getCapability();
ui.setSerialController({
  capability: serialCapability,
  setPreferredTransport: (transport) => serialBridge.setPreferredTransport(transport),
});
ui.init(serialCapability.supported);
if (serialCapability.webusb && !serialCapability.native) {
  ui.logSerial(
    "This browser has no native Web Serial, so serial connections use WebUSB. "
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

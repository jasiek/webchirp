import { BrowserSerialBridge, createSerialRpcHandler } from "./js/serial.js";
import { createRuntimeRpcClient } from "./js/runtime-rpc.js";
import { createUiController } from "./js/ui.js";

const ui = createUiController();
const serialBridge = new BrowserSerialBridge();
const serialRpcHandler = createSerialRpcHandler({
  serialBridge,
  logSerial: ui.logSerial,
});

const rpcClient = createRuntimeRpcClient({
  handleSerialRpc: serialRpcHandler,
  logDebug: ui.logDebug,
  onRuntimeCrash: ui.onRuntimeCrash,
});

ui.setRuntimeApi(rpcClient);
ui.init(serialBridge.isSupported());

import { BrowserSerialBridge, createSerialRpcHandler } from "./js/serial.js";
import { createWorkerRpcClient } from "./js/worker-rpc.js";
import { createUiController } from "./js/ui.js";

const ui = createUiController();
const serialBridge = new BrowserSerialBridge();
const serialRpcHandler = createSerialRpcHandler({
  serialBridge,
  logSerial: ui.logSerial,
});

const rpcClient = createWorkerRpcClient({
  workerUrl: "./py-worker.js",
  handleSerialRpc: serialRpcHandler,
  logDebug: ui.logDebug,
  onWorkerCrash: ui.onWorkerCrash,
});

ui.setCallWorker(rpcClient.callWorker);
ui.init(serialBridge.isSupported());

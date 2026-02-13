import { BrowserSerialBridge, createSerialRpcHandler } from "/web/js/serial.js";
import { createWorkerRpcClient } from "/web/js/worker-rpc.js";
import { createUiController } from "/web/js/ui.js";

const ui = createUiController();
const serialBridge = new BrowserSerialBridge();
const serialRpcHandler = createSerialRpcHandler({
  serialBridge,
  logSerial: ui.logSerial,
});

const rpcClient = createWorkerRpcClient({
  workerUrl: "/web/py-worker.js",
  handleSerialRpc: serialRpcHandler,
  logDebug: ui.logDebug,
  onWorkerCrash: ui.onWorkerCrash,
});

ui.setCallWorker(rpcClient.callWorker);
ui.init(serialBridge.isSupported());

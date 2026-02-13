// Create an RPC client for communication with the Pyodide worker.
export function createWorkerRpcClient({
  workerUrl,
  handleSerialRpc,
  logDebug,
  onWorkerCrash,
}) {
  const worker = new Worker(workerUrl);
  let reqId = 0;
  const pending = new Map();

  worker.addEventListener("message", async (event) => {
    const msg = event.data || {};

    if (msg.type === "serial-rpc") {
      try {
        const data = await handleSerialRpc(msg);
        worker.postMessage({
          type: "serial-rpc-result",
          id: msg.id,
          ok: true,
          data,
        });
      } catch (error) {
        worker.postMessage({
          type: "serial-rpc-result",
          id: msg.id,
          ok: false,
          error: error?.message || String(error),
        });
      }
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(msg, "id")) {
      return;
    }

    const p = pending.get(msg.id);
    if (!p) {
      return;
    }
    pending.delete(msg.id);

    if (msg.ok) {
      p.resolve(msg.data);
    } else {
      logDebug(`WORKER ERROR ${msg.error || "Worker failure"}`);
      p.reject(new Error(msg.error || "Worker failure"));
    }
  });

  worker.addEventListener("error", (event) => {
    if (onWorkerCrash) {
      onWorkerCrash(event.message);
    }
  });

  // Send a method call to worker and resolve with returned data.
  function callWorker(method, payload = {}) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, payload });
    });
  }

  return {
    callWorker,
    worker,
  };
}

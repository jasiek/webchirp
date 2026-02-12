const DEFAULT_SAMPLE_CSV = `Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment\n0,Simplex1,146.520000,,0.600000,,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,National Calling\n1,RepeaterA,146.940000,-,0.600000,TSQL,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,Local repeater\n`;

const VISIBLE_COLUMNS = [
  "Location",
  "Name",
  "Frequency",
  "Duplex",
  "Offset",
  "Tone",
  "rToneFreq",
  "cToneFreq",
  "Mode",
  "Comment",
];

const statusEl = document.querySelector("#status");
const tableHead = document.querySelector("#mem-table thead");
const tableBody = document.querySelector("#mem-table tbody");
const fileInput = document.querySelector("#csv-file");
const serialLogEl = document.querySelector("#serial-log");
const debugOutputEl = document.querySelector("#debug-output");

const worker = new Worker("/web/py-worker.js");
let reqId = 0;
let currentHeaders = [];
let currentRows = [];

class BrowserSerialBridge {
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

const serialBridge = new BrowserSerialBridge();

function setStatus(text) {
  statusEl.textContent = text;
  logDebug(`STATUS ${text}`);
}

function logSerial(line) {
  const text = String(line || "");
  serialLogEl.textContent = `${new Date().toLocaleTimeString()} ${line}\n${serialLogEl.textContent}`
    .split("\n")
    .slice(0, 20)
    .join("\n");
  logDebug(`SERIAL ${text}`);
}

function logDebug(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${String(line || "")}`;
  const current = debugOutputEl.value ? `${debugOutputEl.value}\n` : "";
  debugOutputEl.value = `${current}${text}`;
  debugOutputEl.scrollTop = debugOutputEl.scrollHeight;
}

function callWorker(method, payload = {}) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.type === "serial-rpc") {
        handleSerialRpc(event.data).catch((error) => {
          worker.postMessage({
            type: "serial-rpc-result",
            id: event.data.id,
            ok: false,
            error: error.message,
          });
        });
        return;
      }

      if (event.data.id !== id) {
        return;
      }
      worker.removeEventListener("message", onMessage);

      if (event.data.ok) {
        resolve(event.data.data);
      } else {
        logDebug(`WORKER ERROR ${event.data.error || "Worker failure"}`);
        reject(new Error(event.data.error || "Worker failure"));
      }
    };

    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, method, payload });
  });
}

async function handleSerialRpc(msg) {
  const { id, op, payload } = msg;
  const send = (ok, data, error) =>
    worker.postMessage({
      type: "serial-rpc-result",
      id,
      ok,
      data,
      error,
    });

  try {
    if (op === "open") {
      const res = await serialBridge.open(payload.baudRate);
      logSerial(res.message);
      send(true, res, null);
      return;
    }
    if (op === "close") {
      const res = await serialBridge.close();
      logSerial(res.message);
      send(true, res, null);
      return;
    }
    if (op === "writeHex") {
      const res = await serialBridge.writeHex(payload.hex);
      logSerial(`TX ${res.hex}`);
      send(true, res, null);
      return;
    }
    if (op === "readHex") {
      const res = await serialBridge.readHex(payload.count, payload.timeoutMs);
      logSerial(`RX ${res.hex || "<none>"}${res.timedOut ? " (timeout)" : ""}`);
      send(true, res, null);
      return;
    }
    if (op === "writeBytes") {
      const res = await serialBridge.writeBytes(payload.bytes || []);
      send(true, res, null);
      return;
    }
    if (op === "readBytes") {
      const res = await serialBridge.readBytes(payload.count, payload.timeoutMs);
      send(true, res, null);
      return;
    }
    if (op === "log") {
      logSerial(String(payload.message || ""));
      send(true, { logged: true }, null);
      return;
    }

    throw new Error(`Unknown serial op: ${op}`);
  } catch (error) {
    send(false, null, error.message);
  }
}

function getVisibleColumns(headers) {
  return VISIBLE_COLUMNS.filter((col) => headers.includes(col));
}

function renderTable() {
  const columns = getVisibleColumns(currentHeaders);

  tableHead.innerHTML = "";
  tableBody.innerHTML = "";

  const headerRow = document.createElement("tr");
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column;
    headerRow.appendChild(th);
  });
  tableHead.appendChild(headerRow);

  currentRows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");

    columns.forEach((column) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = row[column] || "";
      input.addEventListener("input", () => {
        currentRows[rowIdx][column] = input.value;
      });
      td.appendChild(input);
      tr.appendChild(td);
    });

    tableBody.appendChild(tr);
  });
}

async function loadCsvText(csvText) {
  setStatus("Parsing CSV with CHIRP Python...");
  const parsed = await callWorker("parseCsv", { csvText });
  currentHeaders = parsed.headers;
  currentRows = parsed.rows;
  renderTable();

  const issues = parsed.errors.length
    ? ` (${parsed.errors.length} parse warnings)`
    : "";
  setStatus(`Loaded ${currentRows.length} channel(s)${issues}.`);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportCsv() {
  setStatus("Normalizing rows with CHIRP Python...");
  const csvText = await callWorker("normalizeRows", { rows: currentRows });
  downloadText("webchirp-export.csv", csvText);
  setStatus("Exported webchirp-export.csv");
}

async function init() {
  try {
    if (!serialBridge.isSupported()) {
      logSerial("Web Serial unsupported in this browser.");
    } else {
      logSerial("Web Serial available.");
    }
    await loadCsvText(DEFAULT_SAMPLE_CSV);
  } catch (error) {
    setStatus(`Initialization failed: ${error.message}`);
  }
}

document.querySelector("#load-sample").addEventListener("click", async () => {
  try {
    await loadCsvText(DEFAULT_SAMPLE_CSV);
  } catch (error) {
    setStatus(`Sample load failed: ${error.message}`);
  }
});

document.querySelector("#import-csv").addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    const csvText = await file.text();
    await loadCsvText(csvText);
  } catch (error) {
    setStatus(`CSV import failed: ${error.message}`);
  } finally {
    fileInput.value = "";
  }
});

document.querySelector("#export-csv").addEventListener("click", async () => {
  try {
    await exportCsv();
  } catch (error) {
    setStatus(`Export failed: ${error.message}`);
  }
});

document.querySelector("#serial-connect").addEventListener("click", async () => {
  const baudRate = Number(document.querySelector("#baud-rate").value || 9600);
  try {
    setStatus("Connecting serial...");
    const result = await callWorker("serialConnect", { baudRate });
    setStatus(result.message || "Serial connected.");
  } catch (error) {
    setStatus(`Serial connect failed: ${error.message}`);
    logSerial(`ERROR ${error.message}`);
  }
});

document.querySelector("#serial-disconnect").addEventListener("click", async () => {
  try {
    const result = await callWorker("serialDisconnect");
    setStatus(result.message || "Serial disconnected.");
  } catch (error) {
    setStatus(`Serial disconnect failed: ${error.message}`);
    logSerial(`ERROR ${error.message}`);
  }
});

document.querySelector("#serial-transaction").addEventListener("click", async () => {
  const txHex = document.querySelector("#tx-hex").value;
  const rxBytes = Number(document.querySelector("#rx-bytes").value || 32);
  const timeoutMs = Number(document.querySelector("#rx-timeout").value || 1200);

  try {
    setStatus("Running Python serial transaction...");
    const result = await callWorker("serialTxRx", { txHex, rxBytes, timeoutMs });
    setStatus("Python serial transaction complete.");
    logSerial(`PY TX ${result.tx.hex} | PY RX ${result.rx.hex || "<none>"}`);
  } catch (error) {
    setStatus(`Serial transaction failed: ${error.message}`);
    logSerial(`ERROR ${error.message}`);
  }
});

document.querySelector("#debug-clear").addEventListener("click", () => {
  debugOutputEl.value = "";
});

worker.addEventListener("error", (event) => {
  logDebug(`WORKER CRASH ${event.message}`);
});

window.addEventListener("error", (event) => {
  logDebug(`WINDOW ERROR ${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const msg = event.reason?.message || String(event.reason || "Unhandled rejection");
  logDebug(`PROMISE ERROR ${msg}`);
});

document.querySelector("#bf888-download").addEventListener("click", async () => {
  try {
    setStatus("Downloading from BF-888...");
    const result = await callWorker("bf888Download");
    currentHeaders = result.headers;
    currentRows = result.rows;
    renderTable();
    setStatus(`BF-888 download complete (${currentRows.length} channels).`);
    logSerial(`BF-888 ident ${result.ident}`);
  } catch (error) {
    setStatus(`BF-888 download failed: ${error.message}`);
    logSerial(`ERROR ${error.message}`);
  }
});

document.querySelector("#bf888-upload").addEventListener("click", async () => {
  try {
    setStatus("Uploading to BF-888...");
    await callWorker("bf888Upload", { rows: currentRows });
    setStatus("BF-888 upload complete.");
  } catch (error) {
    setStatus(`BF-888 upload failed: ${error.message}`);
    logSerial(`ERROR ${error.message}`);
  }
});

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

function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

init();

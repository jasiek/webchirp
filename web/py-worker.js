/* global importScripts, loadPyodide */

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js";

const CHIRP_FILES = [
  ["/chirp/chirp/__init__.py", "chirp/__init__.py"],
  ["/chirp/chirp/errors.py", "chirp/errors.py"],
  ["/chirp/chirp/util.py", "chirp/util.py"],
  ["/chirp/chirp/memmap.py", "chirp/memmap.py"],
  ["/chirp/chirp/chirp_common.py", "chirp/chirp_common.py"],
  ["/chirp/chirp/directory.py", "chirp/directory.py"],
  ["/chirp/chirp/pyPEG.py", "chirp/pyPEG.py"],
  ["/chirp/chirp/bitwise_grammar.py", "chirp/bitwise_grammar.py"],
  ["/chirp/chirp/bitwise.py", "chirp/bitwise.py"],
  ["/chirp/chirp/settings.py", "chirp/settings.py"],
  ["/chirp/chirp/drivers/generic_csv.py", "chirp/drivers/generic_csv.py"],
  ["/chirp/chirp/drivers/h777.py", "chirp/drivers/h777.py"],
];

let pyodide;
let bootstrapPromise;
let rpcId = 0;
const rpcPending = new Map();

function serialRpc(op, payload = {}) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    self.postMessage({ type: "serial-rpc", id, op, payload });
  });
}

function mkdirp(path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      pyodide.FS.mkdir(current);
    } catch {
      // Exists.
    }
  }
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status}`);
  }
  return await res.text();
}

async function ensurePyodide() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      importScripts(PYODIDE_URL);
      pyodide = await loadPyodide();

      mkdirp("/webchirp_runtime/chirp/drivers");

      await Promise.all(
        CHIRP_FILES.map(async ([src, dest]) => {
          const text = await fetchText(src);
          pyodide.FS.writeFile(`/webchirp_runtime/${dest}`, text, {
            encoding: "utf8",
          });
        }),
      );

      await pyodide.runPythonAsync(`
import csv
import io
import json
import struct
import sys
import asyncio

sys.path.insert(0, "/webchirp_runtime")

from chirp import chirp_common, errors, memmap
from chirp.drivers.generic_csv import CSVRadio
from chirp.drivers.h777 import H777Radio
from js import (
    serial_open,
    serial_close,
    serial_write_hex,
    serial_read_hex,
    serial_write_bytes,
    serial_read_bytes,
    serial_log,
)

CSV_HEADERS = list(chirp_common.Memory.CSV_FORMAT)


def _js_to_py(value):
    if hasattr(value, "to_py"):
        return value.to_py()
    return value


def parse_csv(csv_text: str):
    radio = CSVRadio(None, max_memory=999)
    radio.load_from(csv_text)
    rows = []

    for mem in radio.memories:
        if mem.empty:
            continue
        values = mem.to_csv()
        row = {}
        for header, value in zip(CSV_HEADERS, values):
            row[header] = str(value)
        rows.append(row)

    return {
        "headers": CSV_HEADERS,
        "rows": rows,
        "errors": list(radio.errors),
    }


def normalize_rows(rows):
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(CSV_HEADERS)
    for row in rows:
        writer.writerow([row.get(header, "") for header in CSV_HEADERS])

    radio = CSVRadio(None, max_memory=999)
    radio.load_from(out.getvalue())
    return radio.as_string()


async def webserial_connect(baudrate: int):
    result = await serial_open(int(baudrate))
    return _js_to_py(result)


async def webserial_disconnect():
    result = await serial_close()
    return _js_to_py(result)


async def webserial_txrx_hex(tx_hex: str, rx_bytes: int, timeout_ms: int):
    tx_result = await serial_write_hex(tx_hex)
    rx_result = await serial_read_hex(int(rx_bytes), int(timeout_ms))
    return {
        "tx": _js_to_py(tx_result),
        "rx": _js_to_py(rx_result),
    }


class WebSerialPipe:
    def __init__(self, timeout=0.5):
        self.timeout = timeout

    async def write(self, data):
        if isinstance(data, str):
            data = data.encode("latin1")
        await serial_write_bytes(list(data))

    async def read(self, count=1):
        timeout_ms = max(1, int(float(self.timeout) * 1000))
        data = await serial_read_bytes(int(count), timeout_ms)
        if hasattr(data, "to_py"):
            data = data.to_py()
        return bytes((int(x) & 0xFF) for x in data)

    def log(self, msg):
        serial_log(str(msg))


async def _h777_enter_programming_mode(pipe, program_cmd, expected_ident):
    pipe.timeout = 0.5

    await pipe.write(b"\\x02")
    await asyncio.sleep(0.1)
    await pipe.write(program_cmd)
    ack = await pipe.read(1)
    if ack != b"\\x06":
        raise errors.RadioError("Radio refused to enter programming mode")

    await pipe.write(b"\\x02")
    ident = await pipe.read(8)
    if not ident:
        raise errors.RadioError("No identification received from radio")
    if not any(sig in ident for sig in expected_ident):
        raise errors.RadioError(f"Unexpected model ident: {ident!r}")

    await pipe.write(b"\\x06")
    ack2 = await pipe.read(1)
    if ack2 != b"\\x06":
        raise errors.RadioError("No ACK after ident")

    return ident


async def _h777_exit_programming_mode(pipe):
    await pipe.write(b"E")


async def _h777_read_block(pipe, block_addr, block_size=8):
    cmd = struct.pack(">cHb", b"R", block_addr, block_size)
    expected = b"W" + cmd[1:]
    await pipe.write(cmd)
    response = await pipe.read(4 + block_size)
    if len(response) != 4 + block_size or response[:4] != expected:
        raise errors.RadioError(f"Failed block read at 0x{block_addr:04X}")
    await pipe.write(b"\\x06")
    ack = await pipe.read(1)
    if ack != b"\\x06":
        raise errors.RadioError(f"Missing ACK for block 0x{block_addr:04X}")
    return response[4:]


async def _h777_write_block(pipe, block_addr, data):
    cmd = struct.pack(">cHb", b"W", block_addr, len(data))
    await pipe.write(cmd + data)
    ack = await pipe.read(1)
    if ack != b"\\x06":
        raise errors.RadioError(f"Missing write ACK at 0x{block_addr:04X}")


def _rows_to_csv_text(rows):
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(CSV_HEADERS)
    for row in rows:
        writer.writerow([row.get(h, "") for h in CSV_HEADERS])
    return out.getvalue()


def _bf888_rows_from_mmap(mmap_bytes):
    radio = H777Radio(memmap.MemoryMapBytes(mmap_bytes))
    rows = []
    for number in range(1, 17):
        mem = radio.get_memory(number)
        row = {}
        values = mem.to_csv()
        for header, value in zip(CSV_HEADERS, values):
            row[header] = str(value)
        rows.append(row)
    return rows


def _apply_rows_to_radio(radio, rows):
    csv_radio = CSVRadio(None, max_memory=999)
    csv_radio.load_from(_rows_to_csv_text(rows))
    for row in rows:
        try:
            number = int(row.get("Location", "0") or 0)
        except ValueError:
            continue
        if number < 1 or number > 16:
            continue
        mem = csv_radio.get_memory(number)
        mem.number = number
        if not mem.mode:
            mem.mode = "FM"
        radio.set_memory(mem)


async def bf888_download():
    pipe = WebSerialPipe()
    ident = await _h777_enter_programming_mode(pipe, H777Radio.PROGRAM_CMD, H777Radio.IDENT)
    data = b""
    for addr in range(0, H777Radio._memsize, 8):
        pipe.log(f"Reading 8 block at {addr:04x}")
        data += await _h777_read_block(pipe, addr, 8)
    await _h777_exit_programming_mode(pipe)

    rows = _bf888_rows_from_mmap(data)
    return {
        "ident": ident.hex().upper(),
        "rows": rows,
        "headers": CSV_HEADERS,
        "imageHex": data.hex().upper(),
    }


async def bf888_upload(rows):
    pipe = WebSerialPipe()
    await _h777_enter_programming_mode(pipe, H777Radio.PROGRAM_CMD, H777Radio.IDENT)

    base = b""
    for addr in range(0, H777Radio._memsize, 8):
        base += await _h777_read_block(pipe, addr, 8)

    radio = H777Radio(memmap.MemoryMapBytes(base))
    _apply_rows_to_radio(radio, rows)

    image = radio.get_mmap().get_byte_compatible().get_packed()
    for start_addr, end_addr in H777Radio._ranges:
        for addr in range(start_addr, end_addr, 8):
            pipe.log(f"Writing 8 block at {addr:04x}")
            block = image[addr:addr + 8]
            await _h777_write_block(pipe, addr, block)

    await _h777_exit_programming_mode(pipe)
    return {"uploaded": True, "blocks": len(H777Radio._ranges)}
`);
    })();
  }

  return bootstrapPromise;
}

async function handleCall(method, payload) {
  await ensurePyodide();

  if (method === "parseCsv") {
    pyodide.globals.set("_csv_input", payload.csvText);
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(parse_csv(_csv_input))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "normalizeRows") {
    pyodide.globals.set("_rows_json", JSON.stringify(payload.rows));
    const result = await pyodide.runPythonAsync(
      "normalize_rows(json.loads(_rows_json))",
    );
    return result;
  }

  if (method === "serialConnect") {
    pyodide.globals.set("_baud", payload.baudRate || 9600);
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await webserial_connect(_baud))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "serialDisconnect") {
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await webserial_disconnect())",
    );
    return JSON.parse(resultJson);
  }

  if (method === "serialTxRx") {
    pyodide.globals.set("_tx_hex", payload.txHex || "");
    pyodide.globals.set("_rx_bytes", payload.rxBytes || 32);
    pyodide.globals.set("_timeout_ms", payload.timeoutMs || 1200);
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await webserial_txrx_hex(_tx_hex, _rx_bytes, _timeout_ms))",
    );
    return JSON.parse(resultJson);
  }

  if (method === "bf888Download") {
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await bf888_download())",
    );
    return JSON.parse(resultJson);
  }

  if (method === "bf888Upload") {
    pyodide.globals.set("_rows_json", JSON.stringify(payload.rows || []));
    const resultJson = await pyodide.runPythonAsync(
      "json.dumps(await bf888_upload(json.loads(_rows_json)))",
    );
    return JSON.parse(resultJson);
  }

  throw new Error(`Unknown method: ${method}`);
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === "serial-rpc-result") {
    const pending = rpcPending.get(msg.id);
    if (!pending) {
      return;
    }
    rpcPending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.data);
    } else {
      pending.reject(new Error(msg.error || "serial rpc failed"));
    }
    return;
  }

  const { id, method, payload } = msg;
  if (!id || !method) {
    return;
  }

  try {
    const data = await handleCall(method, payload || {});
    self.postMessage({ id, ok: true, data });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error?.message || String(error),
    });
  }
};

self.serial_open = (baudRate) => serialRpc("open", { baudRate: Number(baudRate) });
self.serial_close = () => serialRpc("close", {});
self.serial_write_hex = (hex) => serialRpc("writeHex", { hex: String(hex || "") });
self.serial_read_hex = (count, timeoutMs) =>
  serialRpc("readHex", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  });
self.serial_write_bytes = (bytes) =>
  serialRpc("writeBytes", {
    bytes: Array.from(bytes || []),
  });
self.serial_read_bytes = (count, timeoutMs) =>
  serialRpc("readBytes", {
    count: Number(count || 1),
    timeoutMs: Number(timeoutMs || 1200),
  });
self.serial_log = (message) =>
  serialRpc("log", {
    message: String(message || ""),
  });

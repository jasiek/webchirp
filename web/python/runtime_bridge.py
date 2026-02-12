import asyncio
import csv
import io
import json
import struct
import sys

sys.path.insert(0, "/webchirp_runtime")

from chirp import chirp_common, errors, memmap
from chirp.drivers.generic_csv import CSVRadio
from chirp.drivers.h777 import H777Radio
from js import (
    serial_close,
    serial_log,
    serial_open,
    serial_read_bytes,
    serial_read_hex,
    serial_write_bytes,
    serial_write_hex,
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

    await pipe.write(b"\x02")
    await asyncio.sleep(0.1)
    await pipe.write(program_cmd)
    ack = await pipe.read(1)
    if ack != b"\x06":
        raise errors.RadioError("Radio refused to enter programming mode")

    await pipe.write(b"\x02")
    ident = await pipe.read(8)
    if not ident:
        raise errors.RadioError("No identification received from radio")
    if not any(sig in ident for sig in expected_ident):
        raise errors.RadioError(f"Unexpected model ident: {ident!r}")

    await pipe.write(b"\x06")
    ack2 = await pipe.read(1)
    if ack2 != b"\x06":
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
    await pipe.write(b"\x06")
    ack = await pipe.read(1)
    if ack != b"\x06":
        raise errors.RadioError(f"Missing ACK for block 0x{block_addr:04X}")
    return response[4:]


async def _h777_write_block(pipe, block_addr, data):
    cmd = struct.pack(">cHb", b"W", block_addr, len(data))
    await pipe.write(cmd + data)
    ack = await pipe.read(1)
    if ack != b"\x06":
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
            block = image[addr : addr + 8]
            await _h777_write_block(pipe, addr, block)

    await _h777_exit_programming_mode(pipe)
    return {"uploaded": True, "blocks": len(H777Radio._ranges)}


def _import_radio_class(module_name: str, class_name: str):
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def _radio_rows_from_mmap(radio_cls, mmap_bytes):
    radio = radio_cls(memmap.MemoryMapBytes(mmap_bytes))
    rf = radio.get_features()
    lo, hi = rf.memory_bounds
    rows = []
    for number in range(int(lo), int(hi) + 1):
        mem = radio.get_memory(number)
        values = mem.to_csv()
        row = {}
        for header, value in zip(CSV_HEADERS, values):
            row[header] = str(value)
        rows.append(row)
    return rows


def _apply_rows_to_radio_instance(radio, rows):
    csv_radio = CSVRadio(None, max_memory=999)
    csv_radio.load_from(_rows_to_csv_text(rows))
    rf = radio.get_features()
    lo, hi = rf.memory_bounds
    for row in rows:
        try:
            number = int(row.get("Location", "0") or 0)
        except ValueError:
            continue
        if number < int(lo) or number > int(hi):
            continue
        mem = csv_radio.get_memory(number)
        mem.number = number
        if not mem.mode:
            mem.mode = "FM"
        radio.set_memory(mem)


async def download_selected_radio(module_name: str, class_name: str):
    radio_cls = _import_radio_class(module_name, class_name)
    if not issubclass(radio_cls, H777Radio):
        raise errors.RadioError(
            f"Live browser serial is currently implemented for h777-family radios only. Selected: {module_name}.{class_name}"
        )

    pipe = WebSerialPipe()
    ident = await _h777_enter_programming_mode(pipe, radio_cls.PROGRAM_CMD, radio_cls.IDENT)
    data = b""
    for addr in range(0, int(radio_cls._memsize), 8):
        pipe.log(f"Reading 8 block at {addr:04x}")
        data += await _h777_read_block(pipe, addr, 8)
    await _h777_exit_programming_mode(pipe)

    rows = _radio_rows_from_mmap(radio_cls, data)
    return {
        "ident": ident.hex().upper(),
        "rows": rows,
        "headers": CSV_HEADERS,
    }


async def upload_selected_radio(module_name: str, class_name: str, rows):
    radio_cls = _import_radio_class(module_name, class_name)
    if not issubclass(radio_cls, H777Radio):
        raise errors.RadioError(
            f"Live browser serial is currently implemented for h777-family radios only. Selected: {module_name}.{class_name}"
        )

    pipe = WebSerialPipe()
    await _h777_enter_programming_mode(pipe, radio_cls.PROGRAM_CMD, radio_cls.IDENT)

    base = b""
    for addr in range(0, int(radio_cls._memsize), 8):
        base += await _h777_read_block(pipe, addr, 8)

    radio = radio_cls(memmap.MemoryMapBytes(base))
    _apply_rows_to_radio_instance(radio, rows)

    image = radio.get_mmap().get_byte_compatible().get_packed()
    for start_addr, end_addr in radio_cls._ranges:
        for addr in range(int(start_addr), int(end_addr), 8):
            pipe.log(f"Writing 8 block at {addr:04x}")
            block = image[addr : addr + 8]
            await _h777_write_block(pipe, addr, block)

    await _h777_exit_programming_mode(pipe)
    return {"uploaded": True}

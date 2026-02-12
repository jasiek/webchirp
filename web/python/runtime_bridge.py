import asyncio
import csv
import io
import json
import sys

sys.path.insert(0, "/webchirp_runtime")

from chirp import chirp_common, errors, memmap
from chirp.drivers.generic_csv import CSVRadio
from js import (
    serial_close,
    serial_prepare_clone,
    serial_reset_buffers,
    serial_log,
    serial_open,
    serial_read_bytes,
    serial_read_hex,
    serial_write_bytes,
    serial_write_hex,
)

try:
    from pyodide.ffi import run_sync as pyodide_run_sync
except Exception:
    pyodide_run_sync = None

CSV_HEADERS = list(chirp_common.Memory.CSV_FORMAT)
LAST_IMAGE_BY_DRIVER = {}


def _js_to_py(value):
    if hasattr(value, "to_py"):
        return value.to_py()
    return value


def _await_js(awaitable):
    if pyodide_run_sync:
        return pyodide_run_sync(awaitable)
    loop = asyncio.get_event_loop()
    if not loop.is_running():
        return loop.run_until_complete(awaitable)
    raise RuntimeError(
        "No synchronous Promise bridge available in this runtime; "
        "cannot execute blocking CHIRP serial drivers"
    )


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
    """Minimal pyserial-like API over JS bridge for CHIRP drivers."""

    def __init__(self, timeout=0.5):
        self.timeout = timeout
        self.baudrate = None
        self.rts = None
        self.dtr = None

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("latin1")
        _await_js(serial_write_bytes(list(data)))

    def read(self, count=1):
        timeout_ms = max(1, int(float(self.timeout) * 1000))
        data = _await_js(serial_read_bytes(int(count), timeout_ms))
        if hasattr(data, "to_py"):
            data = data.to_py()
        return bytes((int(x) & 0xFF) for x in data)

    def flush(self):
        return

    def reset_input_buffer(self):
        _await_js(serial_reset_buffers())

    def reset_output_buffer(self):
        return

    def flushInput(self):
        self.reset_input_buffer()

    def flushOutput(self):
        self.reset_output_buffer()

    @property
    def in_waiting(self):
        return 0

    def close(self):
        return

    def setRTS(self, value):
        self.rts = bool(value)

    def setDTR(self, value):
        self.dtr = bool(value)

    def log(self, msg):
        serial_log(str(msg))


class RuntimeUnsupportedError(errors.RadioError):
    pass


def _import_radio_class(module_name: str, class_name: str):
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def _status_to_log(status):
    msg = getattr(status, "msg", "")
    cur = getattr(status, "cur", None)
    maxv = getattr(status, "max", None)
    if cur is None or maxv is None:
        serial_log(str(msg))
    else:
        serial_log(f"{msg}: {cur}/{maxv}")


def _iter_memory_numbers(radio):
    rf = radio.get_features()
    if not hasattr(rf, "memory_bounds") or not rf.memory_bounds:
        raise RuntimeUnsupportedError("Driver has no numeric memory bounds")
    lo, hi = rf.memory_bounds
    return range(int(lo), int(hi) + 1)


def _radio_rows_from_instance(radio):
    rows = []
    for number in _iter_memory_numbers(radio):
        try:
            mem = radio.get_memory(number)
        except Exception:
            continue
        values = mem.to_csv()
        row = {}
        for header, value in zip(CSV_HEADERS, values):
            row[header] = str(value)
        rows.append(row)
    return rows


def _apply_rows_to_radio_instance(radio, rows):
    valid_numbers = set(_iter_memory_numbers(radio))
    for row in rows:
        try:
            number = int(row.get("Location", "0") or 0)
        except ValueError:
            continue
        if number not in valid_numbers:
            continue
        freq_text = str(row.get("Frequency", "") or "").strip()
        if not freq_text:
            try:
                radio.erase_memory(number)
            except Exception:
                continue
            continue
        vals = [str(row.get(h, "") or "") for h in CSV_HEADERS]
        vals[0] = str(number)
        try:
            mem = chirp_common.Memory()
            mem.really_from_csv(vals)
        except Exception:
            continue
        mem.number = number
        if not mem.mode:
            mem.mode = "FM"
        try:
            radio.set_memory(mem)
        except Exception:
            # Driver-specific validation may reject some values; keep going.
            continue


def _ensure_clone_mode_radio(radio_cls):
    if not issubclass(radio_cls, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError(
            "Selected radio is not a clone-mode driver; live serial clone is unsupported in this UI"
        )


def _create_radio_for_serial(radio_cls):
    pipe = WebSerialPipe(timeout=0.5)
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio = radio_cls(pipe)
    radio.status_fn = _status_to_log
    return radio


def _prepare_clone_session(radio_cls):
    _await_js(
        serial_prepare_clone(
            bool(getattr(radio_cls, "WANTS_DTR", True)),
            bool(getattr(radio_cls, "WANTS_RTS", True)),
            350,
        )
    )


def _download_selected_radio_sync(module_name: str, class_name: str):
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)

    _prepare_clone_session(radio_cls)
    radio = _create_radio_for_serial(radio_cls)
    radio.sync_in()
    driver_key = f"{module_name}.{class_name}"
    LAST_IMAGE_BY_DRIVER[driver_key] = (
        radio.get_mmap().get_byte_compatible().get_packed()
    )

    rows = _radio_rows_from_instance(radio)
    return {
        "rows": rows,
        "headers": CSV_HEADERS,
    }


def _upload_selected_radio_sync(module_name: str, class_name: str, rows):
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    driver_key = f"{module_name}.{class_name}"
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not base_image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first, then upload."
        )
    radio = radio_cls(memmap.MemoryMapBytes(base_image))
    radio.status_fn = _status_to_log
    pipe = WebSerialPipe(timeout=0.5)
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio.set_pipe(pipe)
    _prepare_clone_session(radio_cls)
    _apply_rows_to_radio_instance(radio, rows)
    radio.sync_out()
    LAST_IMAGE_BY_DRIVER[driver_key] = (
        radio.get_mmap().get_byte_compatible().get_packed()
    )
    return {"uploaded": True}


async def download_selected_radio(module_name: str, class_name: str):
    return _download_selected_radio_sync(module_name, class_name)


async def upload_selected_radio(module_name: str, class_name: str, rows):
    return _upload_selected_radio_sync(module_name, class_name, rows)


def _mk_enum(values):
    return [str(v) for v in values] if values else []


def get_radio_column_metadata(module_name: str, class_name: str):
    radio_cls = _import_radio_class(module_name, class_name)
    try:
        radio = radio_cls(None)
    except Exception:
        radio = radio_cls("")
    rf = radio.get_features()
    lo, hi = rf.memory_bounds

    col = {}
    col["Location"] = {
        "kind": "int",
        "editable": False,
        "min": int(lo),
        "max": int(hi),
    }
    col["Name"] = {
        "kind": "text",
        "editable": bool(rf.has_name),
        "maxLength": int(rf.valid_name_length),
        "validChars": str(rf.valid_characters),
    }
    col["Frequency"] = {
        "kind": "freq",
        "editable": True,
        "bands": [[int(a), int(b)] for (a, b) in (rf.valid_bands or [])],
    }
    col["Duplex"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_duplexes),
    }
    col["Offset"] = {
        "kind": "freq",
        "editable": bool(rf.has_offset),
        "bands": [[int(a), int(b)] for (a, b) in (rf.valid_bands or [])],
    }
    col["Tone"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_tmodes),
    }
    col["rToneFreq"] = {
        "kind": "enum",
        "editable": True,
        "options": [f"{float(x):.1f}" for x in (rf.valid_tones or [])],
    }
    col["cToneFreq"] = {
        "kind": "enum",
        "editable": bool(rf.has_ctone),
        "options": [f"{float(x):.1f}" for x in (rf.valid_tones or [])],
    }
    col["DtcsCode"] = {
        "kind": "enum",
        "editable": bool(rf.has_dtcs),
        "options": [f"{int(x):03d}" for x in (rf.valid_dtcs_codes or [])],
    }
    col["RxDtcsCode"] = {
        "kind": "enum",
        "editable": bool(rf.has_rx_dtcs),
        "options": [f"{int(x):03d}" for x in (rf.valid_dtcs_codes or [])],
    }
    col["DtcsPolarity"] = {
        "kind": "enum",
        "editable": bool(rf.has_dtcs_polarity),
        "options": _mk_enum(rf.valid_dtcs_pols),
    }
    col["CrossMode"] = {
        "kind": "enum",
        "editable": bool(rf.has_cross),
        "options": _mk_enum(rf.valid_cross_modes),
    }
    col["Mode"] = {
        "kind": "enum",
        "editable": bool(rf.has_mode),
        "options": _mk_enum(rf.valid_modes),
    }
    col["TStep"] = {
        "kind": "enum",
        "editable": bool(rf.has_tuning_step),
        "options": [f"{float(x):.2f}" for x in (rf.valid_tuning_steps or [])],
    }
    col["Skip"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_skips),
    }
    col["Power"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_power_levels),
    }
    col["Comment"] = {
        "kind": "text",
        "editable": bool(rf.has_comment),
    }
    col["URCALL"] = {"kind": "text", "editable": False}
    col["RPT1CALL"] = {"kind": "text", "editable": False}
    col["RPT2CALL"] = {"kind": "text", "editable": False}
    col["DVCODE"] = {"kind": "text", "editable": False}

    return {
        "headers": list(CSV_HEADERS),
        "columns": col,
    }

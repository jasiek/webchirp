import asyncio
import csv
import io
import importlib
import importlib.abc
import json
import os
import sys

sys.path.insert(0, "/webchirp_runtime")

from chirp import chirp_common, directory, errors, memmap
from chirp.drivers.generic_csv import CSVRadio
from js import (
    fetch_chirp_source,
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
DV_ONLY_HEADERS = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]
LAST_IMAGE_BY_DRIVER = {}


def _js_to_py(value):
    """Convert a JsProxy to a native Python object when possible."""
    if hasattr(value, "to_py"):
        return value.to_py()
    return value


def _await_js(awaitable):
    """Synchronously wait for a JS Promise from Python code paths."""
    if pyodide_run_sync:
        return pyodide_run_sync(awaitable)
    loop = asyncio.get_event_loop()
    if not loop.is_running():
        return loop.run_until_complete(awaitable)
    raise RuntimeError(
        "No synchronous Promise bridge available in this runtime; "
        "cannot execute blocking CHIRP serial drivers"
    )


def _chirp_source_relpath(fullname: str) -> str:
    """Map a Python module name to the corresponding CHIRP CDN file path."""
    if fullname in ("chirp", "chirp.__init__"):
        return "/chirp/__init__.py"
    if fullname == "chirp.drivers":
        return "/chirp/drivers/__init__.py"
    return "/" + fullname.replace(".", "/") + ".py"


def _chirp_runtime_path(fullname: str) -> str:
    """Map a Python module name to its destination in Pyodide runtime FS."""
    if fullname in ("chirp", "chirp.__init__"):
        return "/webchirp_runtime/chirp/__init__.py"
    if fullname == "chirp.drivers":
        return "/webchirp_runtime/chirp/drivers/__init__.py"
    return "/webchirp_runtime/" + fullname.replace(".", "/") + ".py"


def _ensure_chirp_module_file(fullname: str) -> None:
    """Materialize a missing chirp module file into local runtime FS."""
    runtime_path = _chirp_runtime_path(fullname)
    if os.path.exists(runtime_path):
        return
    source_relpath = _chirp_source_relpath(fullname)
    source = _await_js(fetch_chirp_source(source_relpath))
    if hasattr(source, "to_py"):
        source = source.to_py()
    os.makedirs(os.path.dirname(runtime_path), exist_ok=True)
    with open(runtime_path, "w", encoding="utf-8") as f:
        f.write(str(source))


class ChirpCdnFinder(importlib.abc.MetaPathFinder):
    """Lazy materializer for missing chirp.* modules from jsDelivr."""

    def find_spec(self, fullname, path=None, target=None):
        """Ensure module file exists before regular import resolution proceeds."""
        if fullname != "chirp" and not fullname.startswith("chirp."):
            return None
        try:
            _ensure_chirp_module_file(fullname)
        except Exception:
            # Let the normal import machinery raise if still unavailable.
            return None
        return None


def _install_chirp_import_hook() -> None:
    """Install the lazy CHIRP import hook once per runtime session."""
    if any(isinstance(f, ChirpCdnFinder) for f in sys.meta_path):
        return
    # Prepend so missing chirp modules are materialized before PathFinder runs.
    sys.meta_path.insert(0, ChirpCdnFinder())


def ensure_radio_module(module_short_name: str) -> None:
    """Force-import a selected driver module so downstream calls can use it."""
    importlib.import_module(f"chirp.drivers.{module_short_name}")


_install_chirp_import_hook()


def list_registered_radios(module_short_names):
    """Import drivers and return radios from CHIRP's registration directory."""
    loaded_modules = set()
    for name in module_short_names or []:
        module_short = str(name or "").strip()
        if not module_short:
            continue
        try:
            ensure_radio_module(module_short)
            loaded_modules.add(module_short)
        except Exception:
            # Skip modules that cannot be imported in this runtime.
            continue

    seen = set()
    radios = []
    for radio_cls in directory.DRV_TO_RADIO.values():
        module_full = getattr(radio_cls, "__module__", "")
        if not module_full.startswith("chirp.drivers."):
            continue
        module_short = module_full.rsplit(".", 1)[-1]
        if loaded_modules and module_short not in loaded_modules:
            continue

        vendor = getattr(radio_cls, "VENDOR", None)
        model = getattr(radio_cls, "MODEL", None)
        if vendor is None or model is None:
            continue

        key = f"{module_short}:{radio_cls.__name__}"
        if key in seen:
            continue
        seen.add(key)

        baud_rate = getattr(radio_cls, "BAUD_RATE", None)
        try:
            baud_rate = int(baud_rate) if baud_rate is not None else None
        except Exception:
            baud_rate = None

        radios.append(
            {
                "key": key,
                "module": module_short,
                "className": radio_cls.__name__,
                "vendor": str(vendor),
                "model": str(model),
                "baudRate": baud_rate,
            }
        )

    radios.sort(key=lambda r: (r["vendor"], r["model"], r["className"]))
    return radios


def parse_csv(csv_text: str):
    """Parse CSV content with CHIRP's CSV driver and return row dictionaries."""
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
    """Round-trip rows through CHIRP CSV parser/writer to normalize formatting."""
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(CSV_HEADERS)
    for row in rows:
        writer.writerow([row.get(header, "") for header in CSV_HEADERS])

    radio = CSVRadio(None, max_memory=999)
    radio.load_from(out.getvalue())
    return radio.as_string()


async def webserial_connect(baudrate: int):
    """Open serial transport via JS bridge and return normalized result."""
    result = await serial_open(int(baudrate))
    return _js_to_py(result)


async def webserial_disconnect():
    """Close serial transport via JS bridge and return normalized result."""
    result = await serial_close()
    return _js_to_py(result)


async def webserial_txrx_hex(tx_hex: str, rx_bytes: int, timeout_ms: int):
    """Send a hex payload and read a fixed-size response via JS bridge."""
    tx_result = await serial_write_hex(tx_hex)
    rx_result = await serial_read_hex(int(rx_bytes), int(timeout_ms))
    return {
        "tx": _js_to_py(tx_result),
        "rx": _js_to_py(rx_result),
    }


class WebSerialPipe:
    """Minimal pyserial-like API over JS bridge for CHIRP drivers."""

    def __init__(self, timeout=0.5):
        """Expose a minimal pyserial-like pipe for CHIRP clone-mode drivers."""
        self.timeout = timeout
        self.baudrate = None
        self.rts = None
        self.dtr = None

    def write(self, data):
        """Write bytes to the JS serial bridge."""
        if isinstance(data, str):
            data = data.encode("latin1")
        _await_js(serial_write_bytes(list(data)))

    def read(self, count=1):
        """Read up to count bytes from JS serial bridge with timeout semantics."""
        timeout_ms = max(1, int(float(self.timeout) * 1000))
        data = _await_js(serial_read_bytes(int(count), timeout_ms))
        if hasattr(data, "to_py"):
            data = data.to_py()
        return bytes((int(x) & 0xFF) for x in data)

    def flush(self):
        """Pyserial compatibility no-op."""
        return

    def reset_input_buffer(self):
        """Clear pending inbound serial bytes in bridge buffers."""
        _await_js(serial_reset_buffers())

    def reset_output_buffer(self):
        """Pyserial compatibility no-op for write buffering."""
        return

    def flushInput(self):
        """Legacy pyserial alias for reset_input_buffer()."""
        self.reset_input_buffer()

    def flushOutput(self):
        """Legacy pyserial alias for reset_output_buffer()."""
        self.reset_output_buffer()

    @property
    def in_waiting(self):
        return 0

    def close(self):
        """Pyserial compatibility no-op; UI owns port lifecycle."""
        return

    def setRTS(self, value):
        """Store requested RTS line state for driver compatibility."""
        self.rts = bool(value)

    def setDTR(self, value):
        """Store requested DTR line state for driver compatibility."""
        self.dtr = bool(value)

    def log(self, msg):
        """Forward driver log/status text to the browser debug console."""
        serial_log(str(msg))


class RuntimeUnsupportedError(errors.RadioError):
    pass


def _import_radio_class(module_name: str, class_name: str):
    """Resolve a radio class object from selected module/class names."""
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def _status_to_log(status):
    """Adapt CHIRP status callbacks into debug log lines."""
    msg = getattr(status, "msg", "")
    cur = getattr(status, "cur", None)
    maxv = getattr(status, "max", None)
    if cur is None or maxv is None:
        serial_log(str(msg))
    else:
        serial_log(f"{msg}: {cur}/{maxv}")


def _iter_memory_numbers(radio):
    """Return numeric memory range for the active radio model."""
    rf = radio.get_features()
    if not hasattr(rf, "memory_bounds") or not rf.memory_bounds:
        raise RuntimeUnsupportedError("Driver has no numeric memory bounds")
    lo, hi = rf.memory_bounds
    return range(int(lo), int(hi) + 1)


def _radio_rows_from_instance(radio):
    """Extract channel rows from a radio instance using CHIRP memory API."""
    rows = []
    for number in _iter_memory_numbers(radio):
        try:
            mem = radio.get_memory(number)
        except Exception:
            continue
        if getattr(mem, "empty", False):
            continue
        values = mem.to_csv()
        row = {}
        for header, value in zip(CSV_HEADERS, values):
            row[header] = str(value)
        rows.append(row)
    return rows


def _apply_rows_to_radio_instance(radio, rows):
    """Apply editable row values to a radio instance with best-effort validation."""
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
    """Enforce clone-mode driver requirement for live serial workflows."""
    if not issubclass(radio_cls, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError(
            "Selected radio is not a clone-mode driver; live serial clone is unsupported in this UI"
        )


def _create_radio_for_serial(radio_cls):
    """Instantiate selected radio with configured WebSerial pipe and status hook."""
    pipe = WebSerialPipe(timeout=0.5)
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio = radio_cls(pipe)
    radio.status_fn = _status_to_log
    return radio


def _prepare_clone_session(radio_cls):
    """Reset/prepare transport lines before clone operations for stability."""
    _await_js(
        serial_prepare_clone(
            bool(getattr(radio_cls, "WANTS_DTR", True)),
            bool(getattr(radio_cls, "WANTS_RTS", True)),
            350,
        )
    )


def _download_selected_radio_sync(module_name: str, class_name: str):
    """Run selected driver's sync_in and return rows + cached image state."""
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
    """Apply rows onto cached image and run selected driver's sync_out."""
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
    """Async wrapper for selected-radio download operation."""
    return _download_selected_radio_sync(module_name, class_name)


async def upload_selected_radio(module_name: str, class_name: str, rows):
    """Async wrapper for selected-radio upload operation."""
    return _upload_selected_radio_sync(module_name, class_name, rows)


def _mk_enum(values):
    """Normalize CHIRP value lists into string enums for UI metadata."""
    return [str(v) for v in values] if values else []


def _radio_supports_dv(rf):
    """Detect whether a radio's mode capabilities include D-STAR DV mode."""
    modes = {str(mode) for mode in (rf.valid_modes or [])}
    return "DV" in modes


def get_radio_column_metadata(module_name: str, class_name: str):
    """Build CHIRP-derived column editability/options metadata for the UI."""
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

    headers = list(CSV_HEADERS)
    if not _radio_supports_dv(rf):
        headers = [h for h in headers if h not in DV_ONLY_HEADERS]

    return {
        "headers": headers,
        "columns": col,
    }

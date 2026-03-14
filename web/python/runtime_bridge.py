import asyncio
import base64
import csv
import io
import importlib
import importlib.abc
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, "/webchirp_runtime")

from chirp import chirp_common, directory, errors, memmap, settings as chirp_settings
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
DEFAULT_EXPORT_POWER = "50W"
DEFAULT_SERIAL_PIPE_TIMEOUT = 1.2


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
                "isLiveRadio": bool(issubclass(radio_cls, chirp_common.LiveRadio)),
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


def _power_label_map_for_radio(module_name: str, class_name: str):
    """Map radio power labels (e.g., High) to CSV power specs (e.g., 4.0W)."""
    if not module_name or not class_name:
        return {}
    try:
        radio_cls = _import_radio_class(module_name, class_name)
        try:
            radio = radio_cls(None)
        except Exception:
            radio = radio_cls("")
        rf = radio.get_features()
        levels = getattr(rf, "valid_power_levels", None) or []
    except Exception:
        return {}

    mapped = {}
    default_power = ""
    for level in levels:
        try:
            watts = chirp_common.dBm_to_watts(int(level))
            formatted = str(chirp_common.AutoNamedPowerLevel(watts))
            mapped[str(level)] = formatted
            mapped[formatted] = formatted
            if not default_power:
                default_power = formatted
        except Exception:
            continue
    return mapped, default_power


def _normalize_power_value(value, power_map, default_power):
    """Return a CHIRP-parseable power value or blank if unavailable."""
    text = str(value or "").strip()
    fallback = default_power or DEFAULT_EXPORT_POWER
    if not text:
        return fallback
    if text in power_map:
        return power_map[text]
    try:
        chirp_common.parse_power(text)
        return text
    except Exception:
        return fallback


def _coerce_csv_vals_for_chirp(vals):
    """Patch CSV fields CHIRP treats as required numerics."""
    out = list(vals)
    freq_idx = CSV_HEADERS.index("Frequency")
    offset_idx = CSV_HEADERS.index("Offset")
    freq_text = str(out[freq_idx] or "").strip()
    offset_text = str(out[offset_idx] or "").strip()
    if freq_text and not offset_text:
        out[offset_idx] = "0.000000"
    return out


def normalize_rows(rows, module_name="", class_name=""):
    """Round-trip rows through CHIRP CSV parser/writer to normalize formatting."""
    power_map, default_power = _power_label_map_for_radio(module_name, class_name)
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(CSV_HEADERS)
    for row in rows:
        cooked = [row.get(header, "") for header in CSV_HEADERS]
        cooked = _coerce_csv_vals_for_chirp(cooked)
        power_idx = CSV_HEADERS.index("Power")
        cooked[power_idx] = _normalize_power_value(
            cooked[power_idx], power_map, default_power
        )
        writer.writerow(cooked)

    csv_text = out.getvalue()
    radio = CSVRadio(None, max_memory=999)
    try:
        radio.load_from(csv_text)
    except errors.InvalidDataError as exc:
        # Preserve export capability when CHIRP parser decides the CSV has no channels.
        if "No channels found" in str(exc):
            return csv_text
        raise
    return radio.as_string()


def _infer_csv_error_column(error_text: str):
    """Best-effort mapping from CHIRP parse error text to CSV column name."""
    text = str(error_text or "")
    match = re.search(r"vals\[(\d+)\]", text)
    if match:
        idx = int(match.group(1))
        if 0 <= idx < len(CSV_HEADERS):
            return CSV_HEADERS[idx]

    lowered = text.lower()
    keywords = {
        "location": "Location",
        "frequency": "Frequency",
        "duplex": "Duplex",
        "offset": "Offset",
        "tone": "Tone",
        "rtonefreq": "rToneFreq",
        "ctonefreq": "cToneFreq",
        "dtcscode": "DtcsCode",
        "dtcspolarity": "DtcsPolarity",
        "rxdtcscode": "RxDtcsCode",
        "crossmode": "CrossMode",
        "mode": "Mode",
        "tstep": "TStep",
        "skip": "Skip",
        "power": "Power",
        "comment": "Comment",
        "name": "Name",
    }
    for token, column in keywords.items():
        if token in lowered:
            return column
    return ""


def validate_rows_for_upload(rows, module_name="", class_name=""):
    """Validate row values with CHIRP CSV parsing and return per-cell issues."""
    power_map, default_power = _power_label_map_for_radio(module_name, class_name)
    issues = []
    for row_index, row in enumerate(rows or []):
        vals = [str((row or {}).get(header, "") or "") for header in CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        power_idx = CSV_HEADERS.index("Power")
        vals[power_idx] = _normalize_power_value(vals[power_idx], power_map, default_power)
        try:
            mem = chirp_common.Memory()
            mem.really_from_csv(vals)
        except Exception as exc:
            error_text = str(exc)
            issues.append(
                {
                    "rowIndex": int(row_index),
                    "column": _infer_csv_error_column(error_text),
                    "message": error_text,
                }
            )
    return {"valid": len(issues) == 0, "issues": issues}


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

    def __init__(self, timeout=DEFAULT_SERIAL_PIPE_TIMEOUT):
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


def _serial_pipe_timeout_seconds():
    """Resolve serial read timeout with optional env override."""
    raw = os.environ.get("WEBCHIRP_SERIAL_TIMEOUT_S", "")
    if not raw:
        return DEFAULT_SERIAL_PIPE_TIMEOUT
    try:
        value = float(raw)
    except Exception:
        return DEFAULT_SERIAL_PIPE_TIMEOUT
    if value <= 0:
        return DEFAULT_SERIAL_PIPE_TIMEOUT
    return value


class RuntimeUnsupportedError(errors.RadioError):
    pass


def _import_radio_class(module_name: str, class_name: str):
    """Resolve a radio class object from selected module/class names."""
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def _driver_cache_key(module_name: str, class_name: str):
    """Build a stable key for cached image data by selected driver."""
    return f"{module_name}.{class_name}"


def _has_cached_image(module_name: str, class_name: str) -> bool:
    """Report whether runtime currently has a cached image for this driver."""
    driver_key = _driver_cache_key(module_name, class_name)
    return driver_key in LAST_IMAGE_BY_DRIVER


def _settings_unavailable_payload(message: str, requires_image=False, error_text=""):
    """Standard payload when radio-wide settings cannot currently be loaded."""
    return {
        "supported": False,
        "available": False,
        "requiresImage": bool(requires_image),
        "message": str(message or ""),
        "error": str(error_text or ""),
        "groups": [],
    }


def _best_effort_radio_instance(module_name: str, class_name: str, require_cached=False):
    """Instantiate a radio with cached data when available, otherwise best-effort blank state."""
    radio_cls = _import_radio_class(module_name, class_name)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)

    def _fallback_constructor():
        try:
            return radio_cls(None)
        except Exception:
            return radio_cls("")

    if base_image is not None:
        radio = radio_cls(memmap.MemoryMapBytes(base_image))
    elif issubclass(radio_cls, chirp_common.CloneModeRadio):
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize > 0:
            radio = radio_cls(memmap.MemoryMapBytes(bytes(memsize)))
        elif require_cached:
            raise RuntimeUnsupportedError(
                "No cached radio image for this model. Download from radio first."
            )
        else:
            radio = _fallback_constructor()
    else:
        radio = _fallback_constructor()

    radio.status_fn = _status_to_log
    return radio


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
    """Apply editable rows to a radio instance and fail on invalid channel writes."""
    valid_numbers = set(_iter_memory_numbers(radio))
    seen_numbers = set()
    for row in rows:
        try:
            number = int(row.get("Location", "0") or 0)
        except ValueError as exc:
            raise RuntimeUnsupportedError(
                f"Invalid Location value in row: {row.get('Location')!r}"
            ) from exc
        if number not in valid_numbers:
            raise RuntimeUnsupportedError(
                f"Channel Location {number} is outside radio memory bounds"
            )
        seen_numbers.add(number)
        freq_text = str(row.get("Frequency", "") or "").strip()
        if not freq_text:
            radio.erase_memory(number)
            continue
        vals = [str(row.get(h, "") or "") for h in CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        vals[0] = str(number)
        mem = chirp_common.Memory()
        mem.really_from_csv(vals)
        mem.number = number
        if not mem.mode:
            mem.mode = "FM"
        radio.set_memory(mem)

    for number in sorted(valid_numbers - seen_numbers):
        radio.erase_memory(number)


def _ensure_clone_mode_radio(radio_cls):
    """Enforce clone-mode driver requirement for live serial workflows."""
    if not issubclass(radio_cls, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError(
            "Selected radio is not a clone-mode driver; live serial clone is unsupported in this UI"
        )


def _create_radio_for_serial(radio_cls):
    """Instantiate selected radio with configured WebSerial pipe and status hook."""
    pipe = WebSerialPipe(timeout=_serial_pipe_timeout_seconds())
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


def _setting_path(parts):
    """Normalize a settings path list into a JSON-safe list of strings."""
    return [str(part) for part in parts]


def _serialize_setting_value(value):
    """Convert a CHIRP RadioSettingValue into UI-friendly JSON metadata."""
    current = value.get_value() if value.initialized else None
    data = {
        "mutable": bool(value.get_mutable()),
        "initialized": bool(value.initialized),
        "current": current,
    }

    if isinstance(value, chirp_settings.RadioSettingValueBoolean):
        data["type"] = "boolean"
    elif isinstance(value, chirp_settings.RadioSettingValueMap):
        data["type"] = "enum"
        data["options"] = [str(option) for option in value.get_options()]
        data["mapped"] = True
    elif isinstance(value, chirp_settings.RadioSettingValueList):
        data["type"] = "enum"
        data["options"] = [str(option) for option in value.get_options()]
    elif isinstance(value, chirp_settings.RadioSettingValueInteger):
        data["type"] = "integer"
        data["min"] = int(value.get_min())
        data["max"] = int(value.get_max())
        data["step"] = int(value.get_step())
    elif isinstance(value, chirp_settings.RadioSettingValueFloat):
        data["type"] = "float"
        data["min"] = float(value.get_min())
        data["max"] = float(value.get_max())
    elif isinstance(value, chirp_settings.RadioSettingValueString):
        data["type"] = "string"
        data["minLength"] = int(value.minlength)
        data["maxLength"] = int(value.maxlength)
        data["charset"] = str(getattr(value, "_charset", "") or "")
        data["autopad"] = bool(value.autopad)
    else:
        data["type"] = value.__class__.__name__

    return data


def _serialize_setting_node(node, path_parts):
    """Serialize a CHIRP settings tree node for browser rendering."""
    if isinstance(node, chirp_settings.RadioSetting):
        raw_values = node.value if isinstance(node.value, list) else [node.value]
        values = []
        all_mutable = True
        for value_index, value in enumerate(raw_values):
            serialized = _serialize_setting_value(value)
            serialized["index"] = int(value_index)
            values.append(serialized)
            all_mutable = all_mutable and bool(serialized["mutable"])

        current_value = values[0]["current"] if len(values) == 1 else None
        warning = node.get_warning(current_value) if len(values) == 1 else None
        return {
            "kind": "setting",
            "id": str(node.get_name()),
            "label": str(node.get_shortname()),
            "doc": getattr(node, "__doc__", None),
            "path": _setting_path(path_parts + [node.get_name()]),
            "mutable": bool(all_mutable),
            "volatile": bool(getattr(node, "volatile", False)),
            "warning": warning,
            "values": values,
        }

    children = [_serialize_setting_node(child, path_parts + [node.get_name()]) for child in node]
    return {
        "kind": "group",
        "id": str(node.get_name()),
        "label": str(node.get_shortname()),
        "doc": getattr(node, "__doc__", None),
        "path": _setting_path(path_parts + [node.get_name()]),
        "children": children,
    }


def _serialize_radio_settings(settings_tree):
    """Serialize the top-level RadioSettings collection."""
    return [_serialize_setting_node(group, []) for group in settings_tree]


def _apply_setting_value(setting, value_index, next_value):
    """Assign one serialized setting value onto the corresponding CHIRP setting."""
    target = setting[value_index] if len(setting) > 1 else setting.value
    target.set_value(next_value)


def _setting_value_is_mutable(setting, value_index):
    """Report whether the selected CHIRP setting value accepts updates."""
    try:
        target = setting[value_index] if len(setting) > 1 else setting.value
    except Exception:
        return False
    return bool(getattr(target, "get_mutable", lambda: True)())


def _apply_serialized_settings(actual_container, payload_children, issues, prefix):
    """Apply serialized UI settings onto a fresh CHIRP settings tree."""
    children = payload_children or []
    for payload in children:
        child_id = str(payload.get("id", ""))
        if not child_id:
            continue
        try:
            actual_child = actual_container[child_id]
        except Exception:
            issues.append(
                {
                    "path": _setting_path(prefix + [child_id]),
                    "valueIndex": 0,
                    "message": "Setting is not available for this radio image.",
                }
            )
            continue

        path = prefix + [child_id]
        if payload.get("kind") == "group":
            _apply_serialized_settings(actual_child, payload.get("children") or [], issues, path)
            continue

        if not isinstance(actual_child, chirp_settings.RadioSetting):
            issues.append(
                {
                    "path": _setting_path(path),
                    "valueIndex": 0,
                    "message": "Payload expected a setting but CHIRP returned a group.",
                }
            )
            continue

        payload_values = payload.get("values") or []
        for value_index, value_payload in enumerate(payload_values):
            if not _setting_value_is_mutable(actual_child, value_index):
                continue
            try:
                _apply_setting_value(actual_child, value_index, value_payload.get("current"))
            except Exception as exc:
                issues.append(
                    {
                        "path": _setting_path(path),
                        "valueIndex": int(value_index),
                        "message": str(exc),
                    }
                )


def _validate_and_apply_radio_settings(radio, serialized_groups, apply_changes=False):
    """Validate serialized settings against a fresh CHIRP settings tree."""
    rf = radio.get_features()
    if not bool(getattr(rf, "has_settings", False)):
        return {"valid": True, "issues": [], "settings": []}

    settings_tree = radio.get_settings()
    issues = []
    _apply_serialized_settings(settings_tree, serialized_groups, issues, [])
    if issues:
        return {"valid": False, "issues": issues, "settings": _serialize_radio_settings(settings_tree)}
    if apply_changes:
        radio.set_settings(settings_tree)
    return {"valid": True, "issues": [], "settings": _serialize_radio_settings(settings_tree)}


def _download_selected_radio_sync(module_name: str, class_name: str):
    """Run selected driver's sync_in and return rows + cached image state."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)

    _prepare_clone_session(radio_cls)
    radio = _create_radio_for_serial(radio_cls)
    radio.sync_in()
    driver_key = _driver_cache_key(module_name, class_name)
    LAST_IMAGE_BY_DRIVER[driver_key] = (
        radio.get_mmap().get_byte_compatible().get_packed()
    )

    rows = _radio_rows_from_instance(radio)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "rows": rows,
        "headers": CSV_HEADERS,
        "settings": settings_result["settings"],
    }


def _upload_selected_radio_sync(module_name: str, class_name: str, rows, settings_groups=None):
    """Apply rows onto cached image and run selected driver's sync_out."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not base_image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first, then upload."
        )
    radio = radio_cls(memmap.MemoryMapBytes(base_image))
    radio.status_fn = _status_to_log
    pipe = WebSerialPipe(timeout=_serial_pipe_timeout_seconds())
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio.set_pipe(pipe)
    _apply_rows_to_radio_instance(radio, rows)
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before upload")
    _prepare_clone_session(radio_cls)
    radio.sync_out()
    LAST_IMAGE_BY_DRIVER[driver_key] = (
        radio.get_mmap().get_byte_compatible().get_packed()
    )
    return {"uploaded": True, "settings": settings_result["settings"]}


async def download_selected_radio(module_name: str, class_name: str):
    """Async wrapper for selected-radio download operation."""
    return _download_selected_radio_sync(module_name, class_name)


async def upload_selected_radio(module_name: str, class_name: str, rows, settings_groups=None):
    """Async wrapper for selected-radio upload operation."""
    return _upload_selected_radio_sync(module_name, class_name, rows, settings_groups)


def get_cached_image_base64(module_name: str, class_name: str):
    """Return cached clone image bytes for a driver as base64 text."""
    driver_key = _driver_cache_key(module_name, class_name)
    image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first."
        )
    return {
        "imageBase64": base64.b64encode(bytes(image)).decode("ascii"),
        "size": len(image),
    }


def upload_image_base64(module_name: str, class_name: str, image_b64: str):
    """Upload an explicit full-image payload through the selected clone driver."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    try:
        raw_image = base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise RuntimeUnsupportedError("Invalid image base64 payload") from exc

    radio = radio_cls(memmap.MemoryMapBytes(raw_image))
    radio.status_fn = _status_to_log
    pipe = WebSerialPipe(timeout=_serial_pipe_timeout_seconds())
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio.set_pipe(pipe)
    _prepare_clone_session(radio_cls)
    radio.sync_out()

    driver_key = _driver_cache_key(module_name, class_name)
    LAST_IMAGE_BY_DRIVER[driver_key] = (
        radio.get_mmap().get_byte_compatible().get_packed()
    )
    return {"uploaded": True, "size": len(raw_image)}


def export_image_base64(module_name: str, class_name: str, rows, settings_groups=None):
    """Build a CHIRP .img payload from rows for selected clone-mode driver."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not base_image:
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize <= 0:
            raise RuntimeUnsupportedError(
                "Driver does not expose memory size for offline image export"
            )
        base_image = bytes(memsize)

    radio = radio_cls(memmap.MemoryMapBytes(base_image))
    _apply_rows_to_radio_instance(radio, rows or [])
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before export")
    packed = radio.get_mmap().get_byte_compatible().get_packed()
    LAST_IMAGE_BY_DRIVER[driver_key] = bytes(packed)
    metadata_blob = radio._make_metadata()
    image_data = bytes(packed) + chirp_common.CloneModeRadio.MAGIC + bytes(metadata_blob)
    return {
        "imageBase64": base64.b64encode(image_data).decode("ascii"),
        "size": len(image_data),
        "vendor": str(getattr(radio_cls, "VENDOR", "")),
        "model": str(getattr(radio_cls, "MODEL", "")),
        "variant": str(getattr(radio_cls, "VARIANT", "")),
        "settings": settings_result["settings"],
    }


def load_image_base64(image_b64: str):
    """Load a CHIRP .img payload, detect driver, and return rows + radio identity."""
    try:
        raw_image = base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise RuntimeUnsupportedError("Invalid image base64 payload") from exc

    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".img", prefix="webchirp-", delete=False
    ) as f:
        image_path = f.name
        f.write(raw_image)

    try:
        radio = directory.get_radio_by_image(image_path)
    except Exception as exc:
        raise RuntimeUnsupportedError(f"Unable to detect radio from image: {exc}") from exc
    finally:
        try:
            os.unlink(image_path)
        except Exception:
            pass

    if not isinstance(radio, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError("Loaded image is not a clone-mode CHIRP image")

    base_cls = getattr(radio.__class__, "_orig_rclass", radio.__class__)
    module_short = str(base_cls.__module__).rsplit(".", 1)[-1]
    class_name = str(base_cls.__name__)
    driver_key = _driver_cache_key(module_short, class_name)
    LAST_IMAGE_BY_DRIVER[driver_key] = radio.get_mmap().get_byte_compatible().get_packed()
    rows = _radio_rows_from_instance(radio)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "module": module_short,
        "className": class_name,
        "vendor": str(getattr(radio.__class__, "VENDOR", "")),
        "model": str(getattr(radio.__class__, "MODEL", "")),
        "variant": str(getattr(radio.__class__, "VARIANT", "")),
        "rows": rows,
        "headers": CSV_HEADERS,
        "settings": settings_result["settings"],
    }


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


def get_radio_settings(module_name: str, class_name: str):
    """Build CHIRP settings-group metadata for the UI when supported."""
    radio_cls = _import_radio_class(module_name, class_name)
    if issubclass(radio_cls, chirp_common.CloneModeRadio) and not _has_cached_image(
        module_name, class_name
    ):
        return _settings_unavailable_payload(
            "Download from radio or load a codeplug image to edit radio-wide settings.",
            requires_image=True,
        )

    radio = _best_effort_radio_instance(module_name, class_name)
    rf = radio.get_features()
    if not bool(getattr(rf, "has_settings", False)):
        return _settings_unavailable_payload(
            "This radio does not expose radio-wide settings."
        )
    try:
        settings_tree = radio.get_settings()
    except Exception as exc:
        return _settings_unavailable_payload(
            "Radio-wide settings are unavailable until this driver's backing state is loaded.",
            error_text=str(exc),
        )
    return {
        "supported": True,
        "available": True,
        "requiresImage": False,
        "message": "",
        "error": "",
        "groups": _serialize_radio_settings(settings_tree),
    }


def validate_radio_settings(module_name: str, class_name: str, settings_groups):
    """Validate serialized radio settings using CHIRP's typed value objects."""
    radio_cls = _import_radio_class(module_name, class_name)
    if issubclass(radio_cls, chirp_common.CloneModeRadio) and not _has_cached_image(
        module_name, class_name
    ):
        return {
            "valid": True,
            "issues": [],
            "settings": [],
            "available": False,
            "requiresImage": True,
            "message": "Download from radio or load a codeplug image to edit radio-wide settings.",
            "error": "",
        }
    radio = _best_effort_radio_instance(module_name, class_name, require_cached=False)
    try:
        result = _validate_and_apply_radio_settings(radio, settings_groups or [], apply_changes=False)
    except Exception as exc:
        return {
            "valid": True,
            "issues": [],
            "settings": [],
            "available": False,
            "requiresImage": False,
            "message": "Radio-wide settings are unavailable until this driver's backing state is loaded.",
            "error": str(exc),
        }
    return {
        "valid": bool(result["valid"]),
        "issues": result["issues"],
        "settings": result["settings"],
        "available": True,
        "requiresImage": False,
        "message": "",
        "error": "",
    }

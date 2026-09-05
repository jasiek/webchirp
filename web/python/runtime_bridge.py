from __future__ import annotations

import asyncio
import base64
import builtins
import importlib
import importlib.abc
import json
import os
import re
import sys
import tempfile
import types
from typing import Any, Literal, Optional, Sequence

sys.path.insert(0, "/webchirp_runtime")


def _install_gettext_builtins() -> None:
    """Provide the translation builtins CHIRP expects from its wx frontend.

    CHIRP modules call ``_()``/``ngettext()`` as builtins, which upstream only
    installs when ``chirp.wxui`` boots. We never translate, so pass the source
    strings straight through instead of pulling in a locale machinery.
    """
    # A REPL leaves ``builtins._`` bound to the last result, so only a callable
    # counts as an already-installed translator.
    if not callable(getattr(builtins, "_", None)):
        builtins._ = lambda message: message
    if not callable(getattr(builtins, "ngettext", None)):
        builtins.ngettext = (
            lambda singular, plural, n: singular if n == 1 else plural
        )


_install_gettext_builtins()


def _install_pyserial_shim() -> None:
    """Provide a stand-in ``serial`` module so pyserial-importing drivers load.

    Pyodide has no pyserial, so drivers that ``import serial`` at module scope
    (tg_uv2p, idrp) would fail to import and never register with CHIRP's
    directory. They only need the module's constants — radio I/O always goes
    through :class:`WebSerialPipe` — so the shim carries pyserial's public
    constants and a ``Serial`` class that refuses construction with a clear
    error instead of failing with ``ModuleNotFoundError`` at import time.
    """
    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass

    shim = types.ModuleType("serial")
    shim.__doc__ = "Minimal pyserial stand-in for the webchirp Pyodide runtime."

    shim.FIVEBITS = 5
    shim.SIXBITS = 6
    shim.SEVENBITS = 7
    shim.EIGHTBITS = 8
    shim.PARITY_NONE = "N"
    shim.PARITY_EVEN = "E"
    shim.PARITY_ODD = "O"
    shim.PARITY_MARK = "M"
    shim.PARITY_SPACE = "S"
    shim.STOPBITS_ONE = 1
    shim.STOPBITS_ONE_POINT_FIVE = 1.5
    shim.STOPBITS_TWO = 2

    class SerialException(OSError):
        """Matches pyserial's base exception type."""

    class SerialTimeoutException(SerialException):
        """Matches pyserial's write-timeout exception type."""

    class Serial:
        """Unusable port stand-in: this runtime drives radios via WebSerialPipe."""

        def __init__(self, *args, **kwargs):
            raise SerialException(
                "pyserial is unavailable in the browser runtime; "
                "radio I/O goes through the Web Serial bridge"
            )

    shim.SerialException = SerialException
    shim.SerialTimeoutException = SerialTimeoutException
    shim.Serial = Serial
    sys.modules["serial"] = shim


_install_pyserial_shim()

from chirp import (
    chirp_common,
    directory,
    errors,
    import_logic,
    memmap,
    settings as chirp_settings,
)
from chirp.drivers.generic_csv import CSVRadio
from js import (
    fetch_chirp_source,
    serial_close,
    serial_prepare_clone,
    serial_progress,
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

# A channel as it crosses the JS/Python boundary: one JSON object per channel,
# keyed by CSV header name (``CSV_HEADERS`` below, from
# ``chirp_common.Memory.CSV_FORMAT``) with text values — "Location": "25",
# "Frequency": "443.000000", "Duplex": "+". It is the grid's row, serialized by
# ``setRowsJsonGlobal()`` in ``web/js/runtime-rpc.js`` and parsed here with
# ``json.loads``, so every value a header names is a string.
#
# The value type is ``Any`` rather than ``str`` because a row may also carry
# non-header keys the editor rides along on it — currently the ``__geo``
# sidecar (``web/js/row-geo.js``), an object, which is why the type cannot
# promise ``str`` for arbitrary keys. Nothing here reads those: every consumer
# below projects a row through ``CSV_HEADERS`` and ignores the rest, which is
# what keeps the sidecar out of a codeplug.
Row = dict[str, Any]
Rows = list[Row]

# One invalid cell reported by the upload preflight: which row, which column,
# and CHIRP's own message for it.
ValidationIssue = dict[str, Any]
ValidationMessage = str | Exception
RowChangeAction = Literal["skip", "erase", "set"]

CSV_HEADERS = list(chirp_common.Memory.CSV_FORMAT)
DV_ONLY_HEADERS = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]
LAST_IMAGE_BY_DRIVER = {}
DEFAULT_EXPORT_POWER = "50W"
# Duplex values CHIRP drivers actually emit. chirp_common has no single
# constant for these: RadioFeatures defaults valid_duplexes to ["", "+", "-"],
# and drivers extend it with "split" and "off".
DUPLEX_VALUES = ("", "+", "-", "split", "off")
DEFAULT_SERIAL_PIPE_TIMEOUT = 1.2


def _log_debug(message) -> None:
    """Send a diagnostic line to the browser debug panel without ever raising."""
    try:
        serial_log(str(message))
    except Exception:
        pass  # Diagnostics must never break the operation being diagnosed.


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


def import_all_driver_modules(module_short_names, progress_cb=None):
    """Import every driver so CHIRP can detect images that carry no metadata.

    Detection walks ``directory.DRV_TO_RADIO`` and calls each driver's
    ``match_model``, so a driver that was never imported can never match. Images
    with a metadata trailer name their own driver, but older ones do not, and for
    those the only way to identify the radio is to have every driver registered.

    ``progress_cb(done, total, module_short)`` is optional and reports after each
    module. This loop is synchronous, but every import suspends the interpreter
    on a CDN fetch (``ChirpCdnFinder``), so the browser event loop runs in
    between and the reported progress actually paints — the same reason CHIRP's
    synchronous clone loops can drive a progress bar through ``serial_progress``.
    """
    names = [str(name or "").strip() for name in module_short_names or []]
    names = [name for name in names if name]
    total = len(names)
    imported = []
    failed = {}
    for index, module_short in enumerate(names):
        try:
            ensure_radio_module(module_short)
            imported.append(module_short)
        except Exception as exc:
            failed[module_short] = f"{type(exc).__name__}: {exc}"
        if progress_cb is not None:
            try:
                progress_cb(index + 1, total, module_short)
            except Exception:
                pass  # Progress reporting must never abort the sweep.
    return {
        "imported": len(imported),
        "failed": failed,
        "registered": len(directory.DRV_TO_RADIO),
    }


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

        # directory.get_radio_by_image() matches image metadata against
        # VENDOR/MODEL/VARIANT over ``rclass.ALIASES + [rclass]``. Catalog
        # matching runs before any driver is imported, so it needs the same
        # identities recorded up front or it cannot be as precise as the
        # detection it front-runs.
        aliases = []
        for alias_cls in list(getattr(radio_cls, "ALIASES", []) or []) + [radio_cls]:
            alias_vendor = getattr(alias_cls, "VENDOR", None)
            alias_model = getattr(alias_cls, "MODEL", None)
            if alias_vendor is None or alias_model is None:
                continue
            identity = {
                "vendor": str(alias_vendor),
                "model": str(alias_model),
                "variant": str(getattr(alias_cls, "VARIANT", "") or ""),
            }
            if identity not in aliases:
                aliases.append(identity)

        entry = {
            "key": key,
            "module": module_short,
            "className": radio_cls.__name__,
            "vendor": str(vendor),
            "model": str(model),
            "baudRate": baud_rate,
            "isLiveRadio": bool(issubclass(radio_cls, chirp_common.LiveRadio)),
        }
        # Both fields are omitted at their default — an empty variant, and an
        # alias list holding nothing but the class's own identity — because the
        # catalog ships to every visitor and these would otherwise add ~50 kB
        # of "" and duplicated vendor/model to 551 entries. Consumers treat a
        # missing variant as empty and a missing alias list as the class's own
        # identity, which is exactly what those defaults mean.
        variant = str(getattr(radio_cls, "VARIANT", "") or "")
        if variant:
            entry["variant"] = variant
        if len(aliases) > 1:
            entry["aliases"] = aliases
        radios.append(entry)

    radios.sort(key=lambda r: (r["vendor"], r["model"], r["className"]))
    return radios


def _blank_csv_radio(max_memory: int = 999):
    """Return an empty generic CSV radio.

    ``CSVRadio(None)`` seeds a default channel 0 at 146.010000/50W, and
    ``CSVRadio._load()`` — unlike ``load()`` — never calls ``_blank()``, so that
    channel survives ``load_from()`` and lands in whatever we parse or export.
    CHIRP's own CSV export erases it explicitly for the same reason
    (``chirp/wxui/memedit.py``).
    """
    radio = CSVRadio(None, max_memory=max(0, int(max_memory)))
    radio.erase_memory(0)
    return radio


def _row_values_for_csv(mem) -> list[Any]:
    """Return ``CSV_FORMAT``-aligned values for a memory.

    ``DVMemory.to_csv()`` upstream still emits a pre-RxDtcsCode/CrossMode/Power
    layout of 18 fields, so zipping it against ``Memory.CSV_FORMAT`` shifts
    every column from RxDtcsCode on — the D-STAR mode string lands in
    RxDtcsCode and the row no longer parses. CHIRP never hits this because its
    CSV export forces a plain ``Memory`` (``import_mem(..., mem_cls=Memory)``);
    do the same here. D-STAR call signs are dropped, exactly as CHIRP drops
    them when exporting CSV.
    """
    if isinstance(mem, chirp_common.DVMemory):
        plain = chirp_common.Memory()
        plain.clone(mem)
        mem = plain
    return mem.to_csv()


def get_default_headers():
    """Channel columns to show before a radio or codeplug decides them.

    The editor starts with no channels, and CHIRP's CSV driver refuses to
    parse a header-only file ("No channels found"), so the startup schema is
    read straight from ``chirp_common`` rather than round-tripped through it.
    """
    return {"headers": CSV_HEADERS}


def parse_csv(csv_text: str) -> dict[str, Any]:
    """Parse CSV content with CHIRP's CSV driver and return row dictionaries."""
    radio = _blank_csv_radio()
    radio.load_from(csv_text)
    rows: Rows = []

    for mem in radio.memories:
        if mem.empty:
            continue
        row: Row = {}
        for header, value in zip(CSV_HEADERS, _row_values_for_csv(mem)):
            row[header] = str(value)
        rows.append(row)

    return {
        "headers": CSV_HEADERS,
        "rows": rows,
        "errors": list(radio.errors),
    }


def _driver_features(module_name: str, class_name: str):
    """Return a driver's RadioFeatures, preferring the cached image.

    Some drivers read their capabilities out of the codeplug: ``Rt98Radio``
    advertises the PMR power levels (Low = 0.5W) on a blank instance and the
    full Low/Mid/High set once an image is parsed, so a blank instance reports
    levels the loaded radio does not have. CHIRP always takes features from the
    open image, so use the cached one when there is one.
    """
    if not module_name or not class_name:
        return None
    try:
        radio_cls = _import_radio_class(module_name, class_name)
    except Exception:
        return None

    image = LAST_IMAGE_BY_DRIVER.get(_driver_cache_key(module_name, class_name))
    factories = [lambda: radio_cls(None), lambda: radio_cls("")]
    if image:
        factories.insert(0, lambda: _radio_from_image_bytes(radio_cls, image))
    for factory in factories:
        try:
            return factory().get_features()
        except Exception:
            continue
    return None


def _watts_label(level):
    """Format a power level's wattage the way CHIRP writes power into a CSV.

    ``float()``, not ``int()``: ``PowerLevel.__int__`` truncates the dBm, so a
    50W level (46.99 dBm) formats as 39W and a 5W level as 4.0W.
    """
    return str(
        chirp_common.AutoNamedPowerLevel(chirp_common.dBm_to_watts(float(level)))
    )


def _power_label_map_from_features(rf):
    """Map radio power labels (e.g., High) to CSV power specs (e.g., 50W)."""
    levels = (getattr(rf, "valid_power_levels", None) or []) if rf else []

    mapped = {}
    default_power = ""
    for level in levels:
        try:
            formatted = _watts_label(level)
            mapped[str(level)] = formatted
            mapped[formatted] = formatted
            if not default_power:
                default_power = formatted
        except Exception:
            continue
    return mapped, default_power


def _valid_power_levels_for_driver(module_name: str, class_name: str):
    """Return a driver's own PowerLevel objects, or an empty list if unavailable."""
    rf = _driver_features(module_name, class_name)
    return list(getattr(rf, "valid_power_levels", None) or []) if rf else []


def _power_levels_by_label(levels):
    """Index a driver's PowerLevel objects by every label they round-trip as.

    Rows carry power as text: `Memory.to_csv()` writes the driver's own label
    ("High"), while CSV exported from this app writes the watt form ("50W").
    Both must resolve back to the *driver's* object, because PowerLevel equality
    compares dBm as a float and a rebuilt level almost never compares equal.
    """
    mapped = {}
    for level in levels or []:
        keys = [str(level)]
        try:
            keys.append(_watts_label(level))
        except Exception:
            pass
        for key in keys:
            key = key.strip()
            if key:
                mapped.setdefault(key, level)
    return mapped


def _resolve_power_level(power_text, level_map):
    """Resolve row power text to the driver's own PowerLevel object."""
    text = str(power_text or "").strip()
    # Memory.to_csv() renders an unset power as "%s" % None, so a channel that
    # carries no power level round-trips as the literal string "None". Treat it
    # as unset; the previous code fell through to a default and silently wrote
    # the radio's first power level onto such channels.
    if not text or text == "None":
        return None
    level = level_map.get(text)
    if level is not None:
        return level
    if not level_map:
        # Driver publishes no power levels; hand CHIRP the parsed value.
        try:
            return chirp_common.parse_power(text)
        except Exception:
            return None
    valid = ", ".join(sorted({str(value) for value in level_map.values()}))
    raise RuntimeUnsupportedError(
        f"Power {text!r} is not supported by this radio; valid values: {valid}"
    )


def _power_label_map_for_radio(module_name: str, class_name: str):
    """Map a selected driver's power labels to CSV power specs."""
    return _power_label_map_from_features(_driver_features(module_name, class_name))


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


def _row_float(text, fallback, label):
    """Parse an optional float row field, keeping the Memory default if blank."""
    value = str(text or "").strip()
    if not value:
        return fallback
    try:
        return float(value)
    except Exception:
        raise RuntimeUnsupportedError(f"{label} is not a valid number")


def _row_int(text, fallback, label):
    """Parse an optional integer row field, keeping the Memory default if blank."""
    value = str(text or "").strip()
    if not value:
        return fallback
    try:
        return int(value, 10)
    except Exception:
        raise RuntimeUnsupportedError(f"{label} is not a valid number")


def _memory_from_row_values(vals, level_map=None):
    """Build a Memory from row values, inverting chirp_common.Memory.to_csv().

    chirp_common.Memory.really_from_csv() looks like the natural inverse, but it
    is a legacy parser that rejects values CHIRP itself emits: it allows only
    "+", "-" and "" for duplex, so a channel read back as "split" or "off"
    cannot be written again. It also insists every tone and DTCS code appear in
    the standard tables. CHIRP's own generic_csv driver does not use it either.

    Parse the fields here instead and leave the final say to the driver's
    set_memory(), which is the component that actually knows what it supports.
    """
    mem = chirp_common.Memory()
    try:
        mem.number = int(str(vals[0]).strip())
    except Exception:
        raise RuntimeUnsupportedError(f"Location {vals[0]!r} is not a valid integer")

    mem.name = str(vals[1] or "")

    # parse_freq(), not to_MHz(float(...)): the latter is what really_from_csv
    # used and it truncates, turning an 8.219000 MHz offset into 8218999 Hz.
    try:
        mem.freq = chirp_common.parse_freq(str(vals[2]).strip())
    except Exception:
        raise RuntimeUnsupportedError("Frequency is not a valid number")

    duplex = str(vals[3] or "").strip()
    if duplex not in DUPLEX_VALUES:
        raise RuntimeUnsupportedError(f"Duplex {duplex!r} is not valid")
    mem.duplex = duplex

    try:
        mem.offset = chirp_common.parse_freq(str(vals[4]).strip())
    except Exception:
        raise RuntimeUnsupportedError("Offset is not a valid number")

    tmode = str(vals[5] or "").strip()
    if tmode and tmode not in chirp_common.TONE_MODES:
        raise RuntimeUnsupportedError(f"Tone mode {tmode!r} is not valid")
    mem.tmode = tmode

    mem.rtone = _row_float(vals[6], mem.rtone, "rTone")
    mem.ctone = _row_float(vals[7], mem.ctone, "cTone")
    mem.dtcs = _row_int(vals[8], mem.dtcs, "DTCS code")

    polarity = str(vals[9] or "").strip()
    if polarity:
        if polarity not in ("NN", "NR", "RN", "RR"):
            raise RuntimeUnsupportedError("DtcsPolarity is not valid")
        mem.dtcs_polarity = polarity

    mem.rx_dtcs = _row_int(vals[10], mem.rx_dtcs, "DTCS Rx code")

    cross_mode = str(vals[11] or "").strip()
    if cross_mode:
        mem.cross_mode = cross_mode

    mode = str(vals[12] or "").strip()
    if mode:
        if mode not in chirp_common.MODES:
            raise RuntimeUnsupportedError(f"Mode {mode!r} is not valid")
        mem.mode = mode

    mem.tuning_step = _row_float(vals[13], mem.tuning_step, "TStep")
    mem.skip = str(vals[14] or "")
    mem.power = _resolve_power_level(vals[15], level_map or {})
    mem.comment = str(vals[16] or "")
    return mem


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


def _csv_export_power_text(value, power_map):
    """Return the Power text CHIRP's CSV export would write for a row value.

    CHIRP's CSV driver stores every level in watts, and its parser reads only
    that form — ``chirp_common.parse_power`` cannot read a driver label like
    "High", so labels have to be converted before the parser sees them.
    Anything unusable (blank, or the literal "None" that ``"%s" % None`` yields
    for a channel carrying no power) becomes the CSV driver's own 50W default,
    which is what ``import_logic`` assigns to a memory without power.
    """
    text = str(value or "").strip()
    if text in power_map:
        return power_map[text]
    try:
        chirp_common.parse_power(text)
    except Exception:
        return DEFAULT_EXPORT_POWER
    return text


def _csv_text_for_memories(memories, src_features):
    """Render memories as CSV exactly the way CHIRP's own export does.

    CHIRP exports by pushing each memory through ``import_logic.import_mem()``
    into a ``generic_csv.CSVRadio`` and saving that (``chirp/wxui/memedit.py``).
    That step fills in columns the CSV format carries but the source radio may
    not track separately — it copies rtone into ctone for radios with a single
    tone, and dtcs into rx_dtcs for radios without separate codes — so skipping
    it produces CSV that differs from CHIRP's in exactly those columns. A memory
    the CSV driver rejects is logged and written unconverted, as CHIRP does.
    """
    highest = max((int(mem.number) for mem in memories), default=0)
    radio = _blank_csv_radio(max_memory=highest)
    for mem in memories:
        try:
            mem = import_logic.import_mem(
                radio, src_features, mem, mem_cls=chirp_common.Memory
            )
        except import_logic.ImportError as exc:
            _log_debug(f"Channel {mem.number} exported unconverted: {exc}")
        radio.set_memory(mem)
    return radio.as_string()


def _memories_from_rows(rows: Rows, power_map: dict[str, Any]) -> list[Any]:
    """Turn row text into memories with CHIRP's own CSV column converters.

    Calls ``CSVRadio._parse_csv_data_line()`` per row instead of feeding a CSV
    document to ``load_from()``: ``CSVRadio._load()`` discards every row whose
    frequency parses to 0, but drivers do report non-empty memories with no
    frequency (uninitialised locations in ``Icom_IC-W32A``, ``Jetstream_JT220M``)
    and CHIRP exports those, because its export never round-trips through its own
    parser. Everything else about the conversion stays CHIRP's, including the
    ATTR_MAP converters and the 50W default for a channel with no power.
    """
    parser = _blank_csv_radio(0)
    # _clean_tmode() mirrors one tone onto the other when the file carries only
    # one of the two columns; rows always carry both.
    parser.file_has_rTone = True
    parser.file_has_cTone = True
    power_idx = CSV_HEADERS.index("Power")

    memories = []
    for index, row in enumerate(rows or []):
        vals = [str(row.get(header, "") or "") for header in CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        vals[power_idx] = _csv_export_power_text(vals[power_idx], power_map)
        try:
            mem = parser._parse_csv_data_line(list(CSV_HEADERS), vals)
        except Exception as exc:
            raise RuntimeUnsupportedError(f"Channel row {index + 1}: {exc}") from exc
        if mem is None or mem.number is None:
            raise RuntimeUnsupportedError(
                f"Channel row {index + 1}: Location {vals[0]!r} is not a valid integer"
            )
        memories.append(mem)
    return memories


def normalize_rows(rows: Rows, module_name: str = "", class_name: str = "") -> str:
    """Render rows as CSV the way CHIRP's CSV export renders the same channels."""
    # import_mem() needs the *source* radio's features to decide which columns it
    # has to fill in, so resolve them once and reuse them for the power labels.
    src_features = _driver_features(module_name, class_name)
    power_map, _default_power = _power_label_map_from_features(src_features)
    memories = _memories_from_rows(rows, power_map)
    if src_features is None:
        # No radio selected: rows came from a CSV, so treat CSV as the source.
        src_features = _blank_csv_radio(0).get_features()
    return _csv_text_for_memories(memories, src_features)


def _infer_csv_error_column(error_text: str) -> str:
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
        "tuning step": "TStep",
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


def _memory_bounds_for_driver(
    module_name: str, class_name: str
) -> Optional[tuple[int, int]]:
    """Return a driver's (lo, hi) memory bounds, or None if unavailable."""
    rf = _driver_features(module_name, class_name)
    bounds = getattr(rf, "memory_bounds", None) if rf else None
    if not bounds:
        return None
    try:
        lo, hi = bounds
        return int(lo), int(hi)
    except Exception:
        return None


def _radio_instance_for_row_validation(
    module_name: str, class_name: str
) -> chirp_common.Radio:
    """Build the same image-backed radio that a later upload/export will use."""
    return _best_effort_radio_instance(
        module_name, class_name, require_cached=False
    )


def _preserve_unedited_immutable_fields(
    row: Row, existing: chirp_common.Memory, mem: chirp_common.Memory
) -> None:
    """Keep immutable values whose grid representation was not edited.

    A few drivers expose an immutable value that their feature list cannot
    reconstruct (notably fixed power levels). Comparing the source row avoids
    turning an edit to another column into an accidental immutable-field edit.
    """
    field_headers: dict[str, str] = {
        "name": "Name",
        "freq": "Frequency",
        "duplex": "Duplex",
        "offset": "Offset",
        "tmode": "Tone",
        "rtone": "rToneFreq",
        "ctone": "cToneFreq",
        "dtcs": "DtcsCode",
        "dtcs_polarity": "DtcsPolarity",
        "rx_dtcs": "RxDtcsCode",
        "cross_mode": "CrossMode",
        "mode": "Mode",
        "tuning_step": "TStep",
        "skip": "Skip",
        "power": "Power",
        "comment": "Comment",
    }
    existing_row: dict[str, str] = {
        header: str(value)
        for header, value in zip(CSV_HEADERS, _row_values_for_csv(existing))
    }
    for field in list(getattr(existing, "immutable", None) or []):
        header = field_headers.get(field)
        if header and str(row.get(header, "") or "") == existing_row[header]:
            setattr(mem, field, getattr(existing, field))


def _prepare_and_validate_memory(
    radio: chirp_common.Radio,
    existing: chirp_common.Memory,
    mem: chirp_common.Memory,
    row: Optional[Row] = None,
) -> tuple[chirp_common.Memory, list[str], list[ValidationMessage]]:
    """Apply CHIRP's name filter and return driver warnings and errors."""
    mem.name = radio.filter_name(mem.name)
    if row is not None:
        _preserve_unedited_immutable_fields(row, existing, mem)

    validation_errors = _immutable_policy_errors(radio, existing, mem)

    try:
        messages = radio.validate_memory(chirp_common.FrozenMemory(mem))
    except Exception as exc:
        validation_errors.append(exc)
        messages = []
    warnings, driver_errors = chirp_common.split_validation_msgs(messages)
    validation_errors.extend(driver_errors)
    return mem, list(warnings), validation_errors


def _immutable_policy_errors(
    radio: chirp_common.Radio,
    existing: chirp_common.Memory,
    new: chirp_common.Memory,
) -> list[ValidationMessage]:
    """Return errors from the driver's immutable-memory policy."""
    validation_errors: list[ValidationMessage] = []
    try:
        radio.check_set_memory_immutable_policy(existing, new)
    except Exception as exc:
        if str(exc) not in {str(error) for error in validation_errors}:
            validation_errors.append(exc)
    return validation_errors


def _memory_row_changed(
    existing: chirp_common.Memory, new: chirp_common.Memory
) -> bool:
    """Return whether any field represented by the channel grid changed."""
    fields = (
        "name",
        "freq",
        "duplex",
        "offset",
        "tmode",
        "rtone",
        "ctone",
        "dtcs",
        "dtcs_polarity",
        "rx_dtcs",
        "cross_mode",
        "mode",
        "tuning_step",
        "skip",
        "power",
        "comment",
        "empty",
    )
    for field in fields:
        existing_value = getattr(existing, field)
        new_value = getattr(new, field)
        if field == "power":
            # Rows carry only the driver's display label. Some drivers use the
            # same label for multiple wattages or return an unadvertised level,
            # so object equality would turn a lossless row round-trip into an
            # apparent edit of an immutable field.
            if str(existing_value) != str(new_value):
                return True
        elif existing_value != new_value:
            return True
    return False


def _row_matches_memory(row: Row, memory: chirp_common.Memory) -> bool:
    """Compare a grid row at exactly the fidelity exposed by the grid."""
    row_values = [str(row.get(header, "") or "") for header in CSV_HEADERS]
    memory_values = [str(value) for value in _row_values_for_csv(memory)]
    return row_values == memory_values


def _prepare_row_change(
    radio: chirp_common.Radio,
    row: Row,
    existing: chirp_common.Memory,
    mem: chirp_common.Memory,
) -> tuple[
    RowChangeAction,
    chirp_common.Memory,
    list[str],
    list[ValidationMessage],
]:
    """Prepare one grid row for validation and writing.

    Validation must compare against the driver's current memory so immutable
    policies see the original values. Exact grid round trips are skipped:
    legacy images may contain values rejected by today's driver, and writing
    an untouched row should neither reject nor normalize them. Empty frequency
    means erase, which is itself checked against the immutable policy.
    """
    if _row_matches_memory(row, existing):
        return "skip", existing, [], []
    if not str(row.get("Frequency", "") or "").strip():
        if existing.empty:
            return "skip", existing, [], []
        erased = existing.dupe()
        erased.empty = True
        return "erase", erased, [], _immutable_policy_errors(
            radio, existing, erased
        )

    if not mem.mode:
        mem.mode = "FM"
    mem, warnings, validation_errors = _prepare_and_validate_memory(
        radio, existing, mem, row
    )
    if not _memory_row_changed(existing, mem):
        return "skip", existing, [], []
    return "set", mem, warnings, validation_errors


def _validation_column(message: ValidationMessage) -> str:
    """Map a CHIRP validation or immutable-field message to a grid column."""
    text = str(message or "")
    match = re.search(r"Field ([A-Za-z_]+) is not mutable", text)
    if match:
        return {
            "number": "Location",
            "name": "Name",
            "freq": "Frequency",
            "duplex": "Duplex",
            "offset": "Offset",
            "tmode": "Tone",
            "rtone": "rToneFreq",
            "ctone": "cToneFreq",
            "dtcs": "DtcsCode",
            "dtcs_polarity": "DtcsPolarity",
            "rx_dtcs": "RxDtcsCode",
            "cross_mode": "CrossMode",
            "mode": "Mode",
            "tuning_step": "TStep",
            "skip": "Skip",
            "power": "Power",
            "comment": "Comment",
            "empty": "Frequency",
        }.get(match.group(1), "")
    return _infer_csv_error_column(text)


def validate_rows_for_upload(
    rows: Rows, module_name: str = "", class_name: str = ""
) -> dict[str, Any]:
    """Validate rows with the selected driver and return errors and warnings."""
    radio = (
        _radio_instance_for_row_validation(module_name, class_name)
        if module_name and class_name
        else None
    )
    levels = list(radio.get_features().valid_power_levels or []) if radio else []
    level_map = _power_levels_by_label(
        levels or _valid_power_levels_for_driver(module_name, class_name)
    )
    # Location is checked here as well as in _apply_rows_to_radio_instance,
    # because that one raises partway through a clone: the radio is already
    # open and some memories written. Preflight is the only place a bad
    # Location can be reported while it is still just a highlighted cell.
    bounds = _memory_bounds_for_driver(module_name, class_name)
    seen_locations: dict[int, int] = {}
    issues: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []
    for row_index, row in enumerate(rows or []):
        vals = [str((row or {}).get(header, "") or "") for header in CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        # A non-integer Location already raises out of _memory_from_row_values
        # below, so only range and uniqueness are checked here.
        try:
            location = int(str((row or {}).get("Location", "") or "").strip())
        except (TypeError, ValueError):
            location = None
        if location is not None:
            if bounds and not (bounds[0] <= location <= bounds[1]):
                issues.append(
                    {
                        "rowIndex": int(row_index),
                        "column": "Location",
                        "message": (
                            f"Channel Location {location} is outside radio "
                            f"memory bounds {bounds[0]}-{bounds[1]}"
                        ),
                    }
                )
            elif location in seen_locations:
                issues.append(
                    {
                        "rowIndex": int(row_index),
                        "column": "Location",
                        "message": (
                            f"Channel Location {location} is already used by "
                            f"row {seen_locations[location] + 1}"
                        ),
                    }
                )
            else:
                seen_locations[location] = row_index
        try:
            mem = _memory_from_row_values(vals, level_map)
        except Exception as exc:
            error_text = str(exc)
            issues.append(
                {
                    "rowIndex": int(row_index),
                    "column": _infer_csv_error_column(error_text),
                    "message": error_text,
                }
            )
            continue

        if (
            radio is None
            or location is None
            or (bounds and not (bounds[0] <= location <= bounds[1]))
        ):
            continue
        try:
            existing = radio.get_memory(location)
            action, mem, row_warnings, row_errors = _prepare_row_change(
                radio, row, existing, mem
            )
            if action == "skip":
                continue
        except Exception as exc:
            row_warnings: list[str] = []
            row_errors: list[ValidationMessage] = [exc]
        for message in row_errors:
            issues.append(
                {
                    "rowIndex": int(row_index),
                    "column": _validation_column(message),
                    "message": str(message),
                }
            )
        for message in row_warnings:
            warnings.append(
                {
                    "rowIndex": int(row_index),
                    "column": _validation_column(message),
                    "message": str(message),
                }
            )
    return {"valid": len(issues) == 0, "issues": issues, "warnings": warnings}


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


class ImageDetectionError(RuntimeUnsupportedError):
    """No imported driver claims this image.

    Split out from the generic error because it is the *only* image failure the
    all-drivers sweep can fix, and the browser gates its retry on this class
    name (`isImageDetectionFailure`, `web/js/image-metadata.mjs`). Renaming it
    without updating that predicate silently disables the backstop, so
    `scripts/test-metadataless-image-load.mjs` pins the two together.
    """


def _import_radio_class(
    module_name: str, class_name: str
) -> type[chirp_common.Radio]:
    """Resolve a radio class object from selected module/class names."""
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def _driver_cache_key(module_name: str, class_name: str) -> str:
    """Build a stable key for cached image data by selected driver."""
    return f"{module_name}.{class_name}"


def _radio_from_image_bytes(
    radio_cls: type[chirp_common.Radio], image_bytes: bytes
) -> chirp_common.Radio:
    """Load stored image bytes through CHIRP's driver file-loading path.

    This keeps reconstruction paired with ``_image_bytes_from_radio`` and lets
    each driver apply its normal file parsing and metadata handling.
    """
    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".img", prefix="webchirp-cache-", delete=False
    ) as image_file:
        image_path = image_file.name
        image_file.write(bytes(image_bytes))
    try:
        return radio_cls(image_path)
    finally:
        try:
            os.unlink(image_path)
        except Exception:
            pass


def _image_bytes_from_radio(radio: chirp_common.Radio) -> bytes:
    """Serialize through CHIRP without confusing a transport map for a file.

    Icom's ``get_mmap`` may flip high bits for clone transport, while
    ``save_mmap`` writes the internal file representation expected on reload.
    """
    with tempfile.NamedTemporaryFile(
        suffix=".img", prefix="webchirp-cache-", delete=False
    ) as image_file:
        image_path = image_file.name
    try:
        radio.save_mmap(image_path)
        with open(image_path, "rb") as image_file:
            return image_file.read()
    finally:
        try:
            os.unlink(image_path)
        except Exception:
            pass


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
        radio = _radio_from_image_bytes(radio_cls, base_image)
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

    radio.status_fn = _make_status_logger()
    return radio


def _make_status_logger():
    """Build a status callback that forwards CHIRP reports to the UI progress display.

    Drivers report one status per transferred block; forwarding each report to
    the progress bar keeps it live, while the debug log only records message
    changes (phase transitions) instead of one line per block. The dedup state
    lives in this closure so it is scoped to one radio instance/operation: a
    driver that repeats the same message through a whole transfer must not
    suppress that message from the next transfer's log.
    """
    last_msg = None

    def _status_to_log(status):
        nonlocal last_msg
        msg = str(getattr(status, "msg", "") or "")
        cur = getattr(status, "cur", None)
        maxv = getattr(status, "max", None)
        try:
            if cur is None or maxv is None:
                serial_progress(-1, -1, msg)
            else:
                serial_progress(int(cur), int(maxv), msg)
        except Exception:
            pass  # A progress display failure must never break a clone.
        if msg and msg != last_msg:
            last_msg = msg
            serial_log(msg)

    return _status_to_log


def _iter_memory_numbers(radio):
    """Return numeric memory range for the active radio model."""
    rf = radio.get_features()
    if not hasattr(rf, "memory_bounds") or not rf.memory_bounds:
        raise RuntimeUnsupportedError("Driver has no numeric memory bounds")
    lo, hi = rf.memory_bounds
    return range(int(lo), int(hi) + 1)


def _radio_rows_from_instance(radio) -> Rows:
    """Extract channel rows from a radio instance using CHIRP memory API."""
    rows: Rows = []
    for number in _iter_memory_numbers(radio):
        try:
            mem = radio.get_memory(number)
        except Exception:
            continue
        if getattr(mem, "empty", False):
            continue
        row: Row = {}
        for header, value in zip(CSV_HEADERS, _row_values_for_csv(mem)):
            row[header] = str(value)
        rows.append(row)
    return rows


def _apply_rows_to_radio_instance(
    radio, rows: Rows, module_name: str = "", class_name: str = ""
) -> None:
    """Validate editable rows, then apply them to a radio instance."""
    if radio and (not module_name or not class_name):
        radio_cls = radio.__class__
        module_name = module_name or str(getattr(radio_cls, "__module__", "")).split(".")[-1]
        class_name = class_name or str(getattr(radio_cls, "__name__", ""))
    level_map = _power_levels_by_label(
        list(radio.get_features().valid_power_levels or [])
        or _valid_power_levels_for_driver(module_name, class_name)
    )
    valid_numbers = set(_iter_memory_numbers(radio))
    seen_numbers = set()
    unreadable_erase_slots: dict[str, list[int]] = {}
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
        # CHIRP's immutable policy needs the current driver memory, not merely
        # the flattened grid row, before deciding whether a write is allowed.
        existing = radio.get_memory(number)
        vals = [str(row.get(h, "") or "") for h in CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        vals[0] = str(number)
        mem = _memory_from_row_values(vals, level_map)
        mem.number = number
        action, mem, warnings, validation_errors = _prepare_row_change(
            radio, row, existing, mem
        )
        if action == "skip":
            continue
        if validation_errors:
            raise RuntimeUnsupportedError(
                f"Channel {number}: {'; '.join(str(error) for error in validation_errors)}"
            )
        for warning in warnings:
            _log_debug(f"Channel {number} validation warning: {warning}")
        if action == "erase":
            radio.erase_memory(number)
        else:
            radio.set_memory(mem)

    for number in sorted(valid_numbers - seen_numbers):
        # Omitted rows mean erase. Read first so immutable special channels are
        # protected and already-empty slots do not trigger needless writes.
        try:
            existing = radio.get_memory(number)
        except Exception as exc:
            reason = str(exc) or exc.__class__.__name__
            unreadable_erase_slots.setdefault(reason, []).append(number)
            continue
        if existing.empty:
            continue
        erased = existing.dupe()
        erased.empty = True
        validation_errors = _immutable_policy_errors(radio, existing, erased)
        if validation_errors:
            raise RuntimeUnsupportedError(
                f"Channel {number}: {'; '.join(str(error) for error in validation_errors)}"
            )
        radio.erase_memory(number)

    for reason, numbers in unreadable_erase_slots.items():
        slots = ", ".join(str(number) for number in numbers[:8])
        remainder = len(numbers) - 8
        suffix = f" and {remainder} more" if remainder > 0 else ""
        _log_debug(
            f"Channels {slots}{suffix} were not erased because their current "
            f"values could not be checked: {reason}"
        )


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
    radio.status_fn = _make_status_logger()
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

    def _serialize_numeric_bound(getter_name: str, attr_name: str) -> Optional[float]:
        getter = getattr(value, getter_name, None)
        # CHIRP's settings objects are untyped and expose these bounds either as
        # a getter or as a bare attribute depending on the value class, so what
        # comes back is genuinely unknown until the float() call.
        bound: Any = getter() if callable(getter) else None
        if bound is None:
            bound = getattr(value, attr_name, None)
        return float(bound) if bound is not None else None

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
        minimum = _serialize_numeric_bound("get_min", "_min")
        maximum = _serialize_numeric_bound("get_max", "_max")
        if minimum is not None:
            data["min"] = minimum
        if maximum is not None:
            data["max"] = maximum
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
    LAST_IMAGE_BY_DRIVER[driver_key] = _image_bytes_from_radio(radio)

    rows = _radio_rows_from_instance(radio)
    csv_text = normalize_rows(rows, module_name, class_name)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "rows": rows,
        "headers": CSV_HEADERS,
        "csvText": csv_text,
        "settings": settings_result["settings"],
    }


def _upload_selected_radio_sync(
    module_name: str,
    class_name: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Apply rows onto cached image and run selected driver's sync_out."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not base_image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first, then upload."
        )
    radio = _radio_from_image_bytes(radio_cls, base_image)
    radio.status_fn = _make_status_logger()
    pipe = WebSerialPipe(timeout=_serial_pipe_timeout_seconds())
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio.set_pipe(pipe)
    _apply_rows_to_radio_instance(radio, rows, module_name, class_name)
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before upload")
    _prepare_clone_session(radio_cls)
    radio.sync_out()
    LAST_IMAGE_BY_DRIVER[driver_key] = _image_bytes_from_radio(radio)
    return {"uploaded": True, "settings": settings_result["settings"]}


async def download_selected_radio(module_name: str, class_name: str) -> dict[str, Any]:
    """Async wrapper for selected-radio download operation."""
    return _download_selected_radio_sync(module_name, class_name)


async def upload_selected_radio(
    module_name: str,
    class_name: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
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

    radio = _radio_from_image_bytes(radio_cls, raw_image)
    radio.status_fn = _make_status_logger()
    pipe = WebSerialPipe(timeout=_serial_pipe_timeout_seconds())
    pipe.baudrate = getattr(radio_cls, "BAUD_RATE", None)
    pipe.setDTR(getattr(radio_cls, "WANTS_DTR", True))
    pipe.setRTS(getattr(radio_cls, "WANTS_RTS", True))
    radio.set_pipe(pipe)
    _prepare_clone_session(radio_cls)
    radio.sync_out()

    driver_key = _driver_cache_key(module_name, class_name)
    LAST_IMAGE_BY_DRIVER[driver_key] = _image_bytes_from_radio(radio)
    return {"uploaded": True, "size": len(raw_image)}


def export_image_base64(
    module_name: str,
    class_name: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
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

    radio = _radio_from_image_bytes(radio_cls, base_image)
    _apply_rows_to_radio_instance(radio, rows or [], module_name, class_name)
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before export")
    image_data = _image_bytes_from_radio(radio)
    LAST_IMAGE_BY_DRIVER[driver_key] = image_data
    return {
        "imageBase64": base64.b64encode(image_data).decode("ascii"),
        "size": len(image_data),
        "vendor": str(getattr(radio_cls, "VENDOR", "")),
        "model": str(getattr(radio_cls, "MODEL", "")),
        "variant": str(getattr(radio_cls, "VARIANT", "")),
        "settings": settings_result["settings"],
    }


def read_image_metadata_base64(image_b64: str):
    """Parse the CHIRP metadata trailer from a .img payload without importing drivers."""
    try:
        raw_image = base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise RuntimeUnsupportedError("Invalid image base64 payload") from exc

    _, metadata = chirp_common.CloneModeRadio._strip_metadata(raw_image)
    if not metadata:
        return {"hasMetadata": False}

    vendor = str(metadata.get("vendor", "") or "")
    model = str(metadata.get("model", "") or "")
    vendor, model = directory.MODEL_COMPAT.get((vendor, model), (vendor, model))
    variant = metadata.get("variant")
    return {
        "hasMetadata": True,
        "rclass": str(metadata.get("rclass", "") or ""),
        "vendor": vendor,
        "model": model,
        # None (no variant recorded) and "" (an explicitly empty variant) are
        # different to CHIRP: get_radio_by_image skips the variant comparison
        # for the former and demands VARIANT == "" for the latter. Collapsing
        # them here would make catalog matching disagree with detection.
        "variant": None if variant is None else str(variant),
    }


def load_image_base64(image_b64: str) -> dict[str, Any]:
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
        raise ImageDetectionError(f"Unable to detect radio from image: {exc}") from exc
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
    LAST_IMAGE_BY_DRIVER[driver_key] = _image_bytes_from_radio(radio)
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


def _power_level_watts(levels):
    """Map each advertised power level's label to its wattage.

    Driver labels carry no wattage — "L3" and "Mid1" say nothing on their own —
    so the UI shows this alongside them, in the same form an exported CSV uses
    (see `_watts_label`) so the grid and the file agree.

    A label maps to one wattage here, which is all `valid_power_levels` can tell
    us; drivers that reuse a label across bands (`vx6.POWER_LEVELS_220`) advertise
    only one of the two, so treat this as what the driver publishes rather than
    what a given channel transmits.
    """
    watts = {}
    for level in levels or []:
        label = str(level)
        try:
            formatted = _watts_label(level)
        except Exception:
            continue
        if formatted != label:
            watts[label] = formatted
    return watts


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
        "optionWatts": _power_level_watts(rf.valid_power_levels),
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

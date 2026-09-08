"""CSV channel conversion and driver-aware power normalization."""

from __future__ import annotations

from typing import Any

from chirp import chirp_common
from chirp import import_logic
from chirp.drivers.generic_csv import CSVRadio
import runtime_drivers
import runtime_support


def _blank_csv_radio(max_memory: int = 999) -> Any:
    """Return an empty generic CSV radio.

    ``CSVRadio(None)`` seeds a default channel 0 at 146.010000/50W, and
    ``CSVRadio._load()`` — unlike ``load()`` — never calls ``_blank()``, so that
    channel survives ``load_from()`` and lands in whatever we parse or export.
    CHIRP's own CSV export erases it explicitly for the same reason
    (``chirp/chirp/wxui/memedit.py``).
    """
    radio = CSVRadio(None, max_memory=max(0, int(max_memory)))
    radio.erase_memory(0)
    return radio


def _row_values_for_csv(mem: Any) -> list[Any]:
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


def get_default_headers() -> Any:
    """Channel columns to show before a radio or codeplug decides them.

    The editor starts with no channels, and CHIRP's CSV driver refuses to
    parse a header-only file ("No channels found"), so the startup schema is
    read straight from ``chirp_common`` rather than round-tripped through it.
    """
    return {"headers": runtime_support.CSV_HEADERS}


def parse_csv(csv_text: str) -> dict[str, Any]:
    """Parse CSV content with CHIRP's CSV driver and return row dictionaries."""
    radio = _blank_csv_radio()
    radio.load_from(csv_text)
    rows: runtime_support.Rows = []

    for mem in radio.memories:
        if mem.empty:
            continue
        row: runtime_support.Row = {}
        for header, value in zip(runtime_support.CSV_HEADERS, _row_values_for_csv(mem)):
            row[header] = str(value)
        rows.append(row)

    return {
        "headers": runtime_support.CSV_HEADERS,
        "rows": rows,
        "errors": list(radio.errors),
    }


def _watts_label(level: Any) -> Any:
    """Format a power level's wattage the way CHIRP writes power into a CSV.

    ``float()``, not ``int()``: ``PowerLevel.__int__`` truncates the dBm, so a
    50W level (46.99 dBm) formats as 39W and a 5W level as 4.0W.
    """
    return str(
        chirp_common.AutoNamedPowerLevel(chirp_common.dBm_to_watts(float(level)))
    )


def _power_label_map_from_features(rf: Any) -> Any:
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


def _valid_power_levels_for_driver(module_name: str, class_name: str) -> Any:
    """Return a driver's own PowerLevel objects, or an empty list if unavailable."""
    rf = runtime_drivers._driver_features(module_name, class_name)
    return list(getattr(rf, "valid_power_levels", None) or []) if rf else []


def _power_levels_by_label(levels: Any) -> Any:
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


def _resolve_power_level(power_text: Any, level_map: Any) -> Any:
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
    raise runtime_support.RuntimeUnsupportedError(
        f"Power {text!r} is not supported by this radio; valid values: {valid}"
    )


def _power_label_map_for_radio(module_name: str, class_name: str) -> Any:
    """Map a selected driver's power labels to CSV power specs."""
    return _power_label_map_from_features(runtime_drivers._driver_features(module_name, class_name))


def _normalize_power_value(value: Any, power_map: Any, default_power: Any) -> Any:
    """Return a CHIRP-parseable power value or blank if unavailable."""
    text = str(value or "").strip()
    fallback = default_power or runtime_support.DEFAULT_EXPORT_POWER
    if not text:
        return fallback
    if text in power_map:
        return power_map[text]
    try:
        chirp_common.parse_power(text)
        return text
    except Exception:
        return fallback


def _row_float(text: Any, fallback: Any, label: Any) -> Any:
    """Parse an optional float row field, keeping the Memory default if blank."""
    value = str(text or "").strip()
    if not value:
        return fallback
    try:
        return float(value)
    except Exception:
        raise runtime_support.RuntimeUnsupportedError(f"{label} is not a valid number")


def _row_int(text: Any, fallback: Any, label: Any) -> Any:
    """Parse an optional integer row field, keeping the Memory default if blank."""
    value = str(text or "").strip()
    if not value:
        return fallback
    try:
        return int(value, 10)
    except Exception:
        raise runtime_support.RuntimeUnsupportedError(f"{label} is not a valid number")


def _memory_from_row_values(vals: Any, level_map: Any=None) -> Any:
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
        raise runtime_support.RuntimeUnsupportedError(f"Location {vals[0]!r} is not a valid integer")

    mem.name = str(vals[1] or "")

    # parse_freq(), not to_MHz(float(...)): the latter is what really_from_csv
    # used and it truncates, turning an 8.219000 MHz offset into 8218999 Hz.
    try:
        mem.freq = chirp_common.parse_freq(str(vals[2]).strip())
    except Exception:
        raise runtime_support.RuntimeUnsupportedError("Frequency is not a valid number")

    duplex = str(vals[3] or "").strip()
    if duplex not in runtime_support.DUPLEX_VALUES:
        raise runtime_support.RuntimeUnsupportedError(f"Duplex {duplex!r} is not valid")
    mem.duplex = duplex

    try:
        mem.offset = chirp_common.parse_freq(str(vals[4]).strip())
    except Exception:
        raise runtime_support.RuntimeUnsupportedError("Offset is not a valid number")

    tmode = str(vals[5] or "").strip()
    if tmode and tmode not in chirp_common.TONE_MODES:
        raise runtime_support.RuntimeUnsupportedError(f"Tone mode {tmode!r} is not valid")
    mem.tmode = tmode

    mem.rtone = _row_float(vals[6], mem.rtone, "rTone")
    mem.ctone = _row_float(vals[7], mem.ctone, "cTone")
    mem.dtcs = _row_int(vals[8], mem.dtcs, "DTCS code")

    polarity = str(vals[9] or "").strip()
    if polarity:
        if polarity not in ("NN", "NR", "RN", "RR"):
            raise runtime_support.RuntimeUnsupportedError("DtcsPolarity is not valid")
        mem.dtcs_polarity = polarity

    mem.rx_dtcs = _row_int(vals[10], mem.rx_dtcs, "DTCS Rx code")

    cross_mode = str(vals[11] or "").strip()
    if cross_mode:
        mem.cross_mode = cross_mode

    mode = str(vals[12] or "").strip()
    if mode:
        if mode not in chirp_common.MODES:
            raise runtime_support.RuntimeUnsupportedError(f"Mode {mode!r} is not valid")
        mem.mode = mode

    mem.tuning_step = _row_float(vals[13], mem.tuning_step, "TStep")
    mem.skip = str(vals[14] or "")
    mem.power = _resolve_power_level(vals[15], level_map or {})
    mem.comment = str(vals[16] or "")
    return mem


def _coerce_csv_vals_for_chirp(vals: Any) -> Any:
    """Patch CSV fields CHIRP treats as required numerics."""
    out = list(vals)
    freq_idx = runtime_support.CSV_HEADERS.index("Frequency")
    offset_idx = runtime_support.CSV_HEADERS.index("Offset")
    freq_text = str(out[freq_idx] or "").strip()
    offset_text = str(out[offset_idx] or "").strip()
    if freq_text and not offset_text:
        out[offset_idx] = "0.000000"
    return out


def _csv_export_power_text(value: Any, power_map: Any) -> Any:
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
        return runtime_support.DEFAULT_EXPORT_POWER
    return text


def _csv_text_for_memories(memories: Any, src_features: Any) -> Any:
    """Render memories as CSV exactly the way CHIRP's own export does.

    CHIRP exports by pushing each memory through ``import_logic.import_mem()``
    into a ``generic_csv.CSVRadio`` and saving that (``chirp/chirp/wxui/memedit.py``).
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
            runtime_support._log_debug(f"Channel {mem.number} exported unconverted: {exc}")
        radio.set_memory(mem)
    return radio.as_string()


def _memories_from_rows(rows: runtime_support.Rows, power_map: dict[str, Any]) -> list[Any]:
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
    power_idx = runtime_support.CSV_HEADERS.index("Power")

    memories = []
    for index, row in enumerate(rows or []):
        vals = [str(row.get(header, "") or "") for header in runtime_support.CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        vals[power_idx] = _csv_export_power_text(vals[power_idx], power_map)
        try:
            mem = parser._parse_csv_data_line(list(runtime_support.CSV_HEADERS), vals)
        except Exception as exc:
            raise runtime_support.RuntimeUnsupportedError(f"Channel row {index + 1}: {exc}") from exc
        if mem is None or mem.number is None:
            raise runtime_support.RuntimeUnsupportedError(
                f"Channel row {index + 1}: Location {vals[0]!r} is not a valid integer"
            )
        memories.append(mem)
    return memories


def normalize_rows(rows: runtime_support.Rows, module_name: str = "", class_name: str = "") -> str:
    """Render rows as CSV the way CHIRP's CSV export renders the same channels."""
    # import_mem() needs the *source* radio's features to decide which columns it
    # has to fill in, so resolve them once and reuse them for the power labels.
    src_features = runtime_drivers._driver_features(module_name, class_name)
    power_map, _default_power = _power_label_map_from_features(src_features)
    memories = _memories_from_rows(rows, power_map)
    if src_features is None:
        # No radio selected: rows came from a CSV, so treat CSV as the source.
        src_features = _blank_csv_radio(0).get_features()
    return _csv_text_for_memories(memories, src_features)

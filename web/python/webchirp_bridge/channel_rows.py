"""Channel rows: the grid's representation of a memory, and CSV in and out.

A row is one JSON object per channel keyed by CHIRP's CSV header names
(``Row`` below). This module converts between rows, CSV text and
``chirp_common.Memory`` objects, always going through CHIRP's own CSV driver
and import logic so the app parses and emits exactly what desktop CHIRP
would. Driver-specific extras that have no CSV column ride along on the row
under a sidecar key of their own; that is
``web/python/webchirp_bridge/channel_extra.py``'s concern, not this module's.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from chirp import (
    chirp_common,
    import_logic,
)
from chirp.drivers.generic_csv import CSVRadio

from webchirp_bridge.jsbridge import _log_debug
from webchirp_bridge.power_levels import (
    _closest_power_label,
    _csv_export_power_text,
    _power_label_map_from_features,
    _power_levels_by_label,
    _resolve_power_level,
    _valid_power_levels_for_driver,
)
from webchirp_bridge.runtime_errors import RuntimeUnsupportedError
from webchirp_bridge.session import resolve_optional_session

if TYPE_CHECKING:
    from typing import Any, Optional, Sequence
    from webchirp_bridge.session import RadioSession

    # A channel as it crosses the JS/Python boundary: one JSON object per channel,
    # keyed by CSV header name (``CSV_HEADERS`` below, from
    # ``chirp_common.Memory.CSV_FORMAT``) with text values — "Location": "25",
    # "Frequency": "443.000000", "Duplex": "+". It is the grid's row, serialized by
    # ``setRowsJsonGlobal()`` in ``web/js/runtime-rpc.ts`` and parsed here with
    # ``json.loads``, so every value a header names is a string.
    #
    # The value type is ``Any`` rather than ``str`` because a row may also carry
    # non-header keys the editor rides along on it — currently the ``__extra``
    # sidecar (``web/js/row-extra.ts``), an object, which is why the type cannot
    # promise ``str`` for arbitrary keys. Every consumer projects a row through
    # ``CSV_HEADERS`` and ignores the rest, which is what keeps the sidecar out
    # of a codeplug.
    Row = dict[str, Any]
    Rows = list[Row]

CSV_HEADERS = list(chirp_common.Memory.CSV_FORMAT)


# Duplex values CHIRP drivers actually emit. chirp_common has no single
# constant for these: RadioFeatures defaults valid_duplexes to ["", "+", "-"],
# and drivers extend it with "split" and "off".
DUPLEX_VALUES = ("", "+", "-", "split", "off")


def _blank_csv_radio(max_memory: int = 999) -> CSVRadio:
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


# DVMemory attribute -> the grid column that shows it. A D-STAR channel is a
# chirp_common.DVMemory, and these four Memory.CSV_FORMAT columns are the only
# place a row holds its routing, so they carry it both ways: read off the
# driver's memory, and written back on the DVMemory the row becomes.
DV_FIELD_HEADERS: dict[str, str] = {
    "dv_urcall": "URCALL",
    "dv_rpt1call": "RPT1CALL",
    "dv_rpt2call": "RPT2CALL",
    "dv_code": "DVCODE",
}


def _row_values_for_csv(mem: chirp_common.Memory) -> list[Any]:
    """Return ``CSV_FORMAT``-aligned values for a memory.

    ``DVMemory.to_csv()`` upstream still emits a pre-RxDtcsCode/CrossMode/Power
    layout of 18 fields, so zipping it against ``Memory.CSV_FORMAT`` shifts
    every column from RxDtcsCode on — the D-STAR mode string lands in
    RxDtcsCode and the row no longer parses. CHIRP never hits this because its
    CSV export forces a plain ``Memory`` (``import_mem(..., mem_cls=Memory)``);
    do the same for the shared columns, then fill the D-STAR ones from the
    memory itself. ``Memory.to_csv()`` leaves those blank, and a row that
    dropped them was written back with the driver's default routing (issue
    #317). The CSV export still blanks them, as CHIRP's does: it renders
    through ``_csv_text_for_memories``, not this projection.
    """
    if not isinstance(mem, chirp_common.DVMemory):
        return mem.to_csv()
    values = _without_dv_routing(mem).to_csv()
    for field, header in DV_FIELD_HEADERS.items():
        value = getattr(mem, field)
        values[CSV_HEADERS.index(header)] = "%i" % value if field == "dv_code" else value
    return values


def _without_dv_routing(mem: chirp_common.Memory) -> chirp_common.Memory:
    """``mem`` as a plain Memory, for a DVMemory whose routing nobody chose.

    CHIRP's CSV parser makes every DV-mode line a DVMemory but never reads the
    D-STAR columns (``CSVRadio.ATTR_MAP`` has none), so its routing is only
    DVMemory's class defaults. Carried into the row, those would be written
    as routing the file never held -- and a driver that looks calls up in its
    call lists refuses a call it does not hold. Without them the row is a
    DV-mode channel the driver converts its own way, as before.
    """
    if not isinstance(mem, chirp_common.DVMemory):
        return mem
    plain = chirp_common.Memory()
    plain.clone(mem)
    return plain


def _row_text_values(mem: chirp_common.Memory) -> list[str]:
    """A memory's CSV fields as the text the grid shows, in ``CSV_HEADERS`` order."""
    return [str(value) for value in _row_values_for_csv(mem)]


def _row_from_memory(mem: chirp_common.Memory) -> Row:
    """Project a memory onto a grid row: CSV header names to text values."""
    return dict(zip(CSV_HEADERS, _row_text_values(mem)))


def parse_csv(csv_text: str, session_id: str = "") -> dict[str, Any]:
    """RPC: parse CSV content with CHIRP's CSV driver and return row dictionaries.

    With a session, the rows are being imported into that radio, so each
    channel's power becomes one of its levels, as desktop CHIRP's import makes
    it (``_closest_power_label``); ``powerAdjusted`` counts the channels moved
    to a different level, each logged to the debug panel. An empty
    ``session_id`` means no radio is selected, and the rows keep the CSV
    driver's own watt values.
    """
    levels = _valid_power_levels_for_driver(resolve_optional_session(session_id))
    # What the radio already calls one of its levels, by label or by watts:
    # relabelled without counting as an adjustment.
    own_levels = _power_levels_by_label(levels)
    radio = _blank_csv_radio()
    radio.load_from(csv_text)
    rows: Rows = []
    errors = [str(error) for error in radio.errors]
    power_adjusted = 0

    for mem in radio.memories:
        if mem.empty:
            continue
        if mem.offset < 0:
            # A signed Offset that CHIRP's CSV driver read wrongly (see
            # _row_frequency); the row keeps it so the preflight marks it.
            warning = (
                f"Channel {mem.number}: Offset cannot be negative; "
                "enter its size and set the direction in Duplex"
            )
            errors.append(warning)
            _log_debug(f"CSV IMPORT {warning}")
        row = _row_from_memory(_without_dv_routing(mem))
        label = _closest_power_label(row["Power"], levels)
        if label is not None:
            if row["Power"] not in own_levels:
                power_adjusted += 1
                _log_debug(
                    f"CSV IMPORT channel={row['Location']} Power {row['Power']} -> {label}: "
                    "the closest level this radio has"
                )
            row["Power"] = label
        rows.append(row)

    return {
        "headers": CSV_HEADERS,
        "rows": rows,
        "errors": errors,
        "powerAdjusted": power_adjusted,
    }


def _row_float(text: Any, fallback: float, label: str) -> float:
    """Parse an optional float row field, keeping the Memory default if blank."""
    value = str(text or "").strip()
    if not value:
        return fallback
    try:
        return float(value)
    except Exception:
        raise RuntimeUnsupportedError(f"{label} is not a valid number")


def _row_int(text: Any, fallback: int, label: str) -> int:
    """Parse an optional integer row field, keeping the Memory default if blank."""
    value = str(text or "").strip()
    if not value:
        return fallback
    try:
        return int(value, 10)
    except Exception:
        raise RuntimeUnsupportedError(f"{label} is not a valid number")


def _row_frequency(text: Any, label: str) -> int:
    """Parse a row's MHz text to Hz, refusing a negative value.

    parse_freq(), not to_MHz(float(...)): the latter is what really_from_csv
    used and it truncates, turning an 8.219000 MHz offset into 8218999 Hz. But
    parse_freq() adds the fraction to a negative whole part, so "-5.600000"
    would reach the driver as -4.4 MHz (FINDINGS parse-freq-negative-defect,
    CHIRP d99bb227). A sign means nothing here anyway -- Duplex carries the
    offset's direction -- so it is refused like the grid refuses it, and the
    preflight marks the cell.
    """
    value = str(text if text is not None else "").strip()
    if value.startswith("-"):
        raise RuntimeUnsupportedError(f"{label} cannot be negative")
    try:
        return chirp_common.parse_freq(value)
    except Exception:
        raise RuntimeUnsupportedError(f"{label} is not a valid number")


def _memory_from_row_values(
    vals: Sequence[Any], level_map: Optional[dict[str, chirp_common.PowerLevel]] = None
) -> chirp_common.Memory:
    """Build a Memory from row values, inverting chirp_common.Memory.to_csv().

    chirp_common.Memory.really_from_csv() looks like the natural inverse, but it
    is a legacy parser that rejects values CHIRP itself emits: it allows only
    "+", "-" and "" for duplex, so a channel read back as "split" or "off"
    cannot be written again. It also insists every tone and DTCS code appear in
    the standard tables. CHIRP's own generic_csv driver does not use it either.

    Parse the fields here instead and leave the final say to the driver's
    set_memory(), which is the component that actually knows what it supports.
    """
    mem = _memory_for_row_values(vals)
    try:
        mem.number = int(str(vals[0]).strip())
    except Exception:
        raise RuntimeUnsupportedError(f"Location {vals[0]!r} is not a valid integer")

    mem.name = str(vals[1] or "")

    mem.freq = _row_frequency(vals[2], "Frequency")

    duplex = str(vals[3] or "").strip()
    if duplex not in DUPLEX_VALUES:
        raise RuntimeUnsupportedError(f"Duplex {duplex!r} is not valid")
    mem.duplex = duplex

    mem.offset = _row_frequency(vals[4], "Offset")

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
    if isinstance(mem, chirp_common.DVMemory):
        _apply_row_dv_fields(mem, vals)
    return mem


def _row_dv_values(vals: Sequence[Any]) -> dict[str, str]:
    """A row's D-STAR cells by DVMemory attribute, blank where the row has none."""
    out: dict[str, str] = {}
    for field, header in DV_FIELD_HEADERS.items():
        index = CSV_HEADERS.index(header)
        out[field] = str(vals[index] or "") if index < len(vals) else ""
    return out


def _memory_for_row_values(vals: Sequence[Any]) -> chirp_common.Memory:
    """The Memory class the driver gave this row: a DVMemory if it has routing.

    A row carries D-STAR routing only when it was read off a DVMemory, whose
    DVCODE ``_row_values_for_csv`` always fills, so the row goes back to
    ``set_memory()`` as the class it came from. Handing a DVMemory back as a
    plain Memory is not neutral: a driver resets its routing to defaults
    (issue #317) or refuses a DV-mode plain Memory outright.

    A row with no routing stays a plain Memory even when its Mode is DV -- a
    channel the user just switched to DV, whose routing columns the grid does
    not let them fill. That is what desktop CHIRP's grid hands the driver for
    the same edit, and each driver converts it its own way: one with call
    lists cannot take a DVMemory whose calls it does not hold.
    """
    if any(value.strip() for value in _row_dv_values(vals).values()):
        return chirp_common.DVMemory()
    return chirp_common.Memory()


def _apply_row_dv_fields(mem: chirp_common.DVMemory, vals: Sequence[Any]) -> None:
    """Set a DVMemory's routing from the row's D-STAR cells.

    Every cell is taken exactly as the driver gave it, blank and padding
    included: drivers that look a call up in their call lists need their own
    spelling back, and one that pads with NULs would turn a trailing space it
    read into a NUL if the space were stripped here.
    """
    values = _row_dv_values(vals)
    mem.dv_urcall = values["dv_urcall"]
    mem.dv_rpt1call = values["dv_rpt1call"]
    mem.dv_rpt2call = values["dv_rpt2call"]
    code = _row_int(values["dv_code"], 0, "DVCODE")
    try:
        mem.dv_code = code
    except ValueError:
        raise RuntimeUnsupportedError(f"DVCODE {code} is not valid")


def _coerce_csv_vals_for_chirp(vals: Sequence[Any]) -> list[Any]:
    """Patch CSV fields CHIRP treats as required numerics."""
    out = list(vals)
    freq_idx = CSV_HEADERS.index("Frequency")
    offset_idx = CSV_HEADERS.index("Offset")
    freq_text = str(out[freq_idx] or "").strip()
    offset_text = str(out[offset_idx] or "").strip()
    if freq_text and not offset_text:
        out[offset_idx] = "0.000000"
    return out


def _csv_text_for_memories(memories: Sequence[chirp_common.Memory], src_features: Any) -> str:
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


def normalize_rows(rows: Rows, session_id: str = "") -> str:
    """RPC: render rows as CSV the way CHIRP's CSV export renders the same channels.

    An empty ``session_id`` means no radio is selected, in which case the rows
    are treated as CHIRP's generic CSV driver's own.
    """
    return _csv_text_for_rows(rows, resolve_optional_session(session_id))


def _csv_text_for_rows(rows: Rows, session: Optional[RadioSession]) -> str:
    """Render rows as CSV against a session's driver, or the CSV driver without one."""
    # import_mem() needs the *source* radio's features to decide which columns it
    # has to fill in, so resolve them once and reuse them for the power labels.
    src_features = session.features() if session else None
    power_map, _default_power = _power_label_map_from_features(src_features)
    memories = _memories_from_rows(rows, power_map)
    if src_features is None:
        # No radio selected: rows came from a CSV, so treat CSV as the source.
        src_features = _blank_csv_radio(0).get_features()
    return _csv_text_for_memories(memories, src_features)

"""What the channel grid needs to know about the selected radio's columns.

Derived from the driver's ``RadioFeatures``: which columns apply, the valid
choices for each enumerated one, the memory bounds and the power levels with
their wattages, so the grid can constrain edits before the upload preflight
ever runs.
"""

from __future__ import annotations

from typing import TYPE_CHECKING


from chirp import chirp_common

from webchirp_bridge.channel_rows import CSV_HEADERS, _blank_csv_radio, _row_from_memory
from webchirp_bridge.driver_cache import _blank_radio_instance, _import_radio_class
from webchirp_bridge.power_levels import _power_level_watts

if TYPE_CHECKING:
    from typing import Any, Callable, Iterable, Optional

DV_ONLY_HEADERS = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]


def _memory_defaults() -> dict[str, str]:
    """CHIRP's own starting value for each column, as the grid spells it.

    ``chirp_common.Memory()`` is what a new channel is in CHIRP, and projecting
    it through ``_row_from_memory`` gives Mode "FM", rToneFreq/cToneFreq 88.5,
    CrossMode "Tone->Tone" and so on in exactly the text the grid stores. The
    grid used to start a blank row on each enum column's *first option*, which
    is a poor stand-in for a default: the full CHIRP mode list starts at WFM
    and the tone table at 67.0 -- the very value that made a rejected tone
    write look plausible (issue #104). Power is excluded because a default
    Memory has none and the field stringifies to "None".
    """
    defaults = _row_from_memory(chirp_common.Memory())
    return {column: value for column, value in defaults.items() if column != "Power"}


def _mk_enum(values: Optional[Iterable[Any]]) -> list[str]:
    """Normalize CHIRP value lists into string enums for UI metadata."""
    return [str(v) for v in values] if values else []


def _radio_supports_dv(rf: chirp_common.RadioFeatures) -> bool:
    """Detect whether a radio's mode capabilities include D-STAR DV mode."""
    modes = {str(mode) for mode in (rf.valid_modes or [])}
    return "DV" in modes


def _with_default(column: dict[str, Any], default: Optional[str]) -> dict[str, Any]:
    """Attach CHIRP's starting value for the column, if this driver offers it.

    A driver whose list does not carry the default -- a DMR-only set has no FM
    -- gets no ``default`` key and the grid falls back to the first option, as
    it always did.
    """
    if default is not None and default in column["options"]:
        column["default"] = default
    return column


def _enum_column(
    editable: bool, values: Optional[Iterable[Any]], default: Optional[str] = None
) -> dict[str, Any]:
    """An enumerated column: the grid offers exactly the driver's values."""
    return _with_default(
        {"kind": "enum", "editable": bool(editable), "options": _mk_enum(values)}, default
    )


def _formatted_enum_column(
    editable: bool,
    values: Optional[Iterable[Any]],
    fmt: str,
    convert: Callable[[Any], Any],
    default: Optional[str] = None,
) -> dict[str, Any]:
    """An enumerated column of numbers, spelled the way an exported CSV spells them."""
    options = [fmt.format(convert(value)) for value in (values or [])]
    return _with_default(
        {"kind": "enum", "editable": bool(editable), "options": options}, default
    )


def _freq_column(editable: bool, rf: chirp_common.RadioFeatures) -> dict[str, Any]:
    """A frequency column constrained to the radio's bands."""
    bands = [[int(low), int(high)] for (low, high) in (rf.valid_bands or [])]
    return {"kind": "freq", "editable": bool(editable), "bands": bands}


def _location_column(rf: chirp_common.RadioFeatures) -> dict[str, Any]:
    """The memory-slot column, bounded by the driver's ``memory_bounds``.

    A radio that declares ``has_infinite_number`` is not constrained in how
    many memories it holds, and CHIRP's own ``validate_memory`` skips the range
    check for exactly that reason -- so the column gets no ``max`` and the grid
    keeps numbering past the nominal end. Only ``generic_csv.CSVRadio`` sets the
    flag, which is what keeps a file-backed schema from capping an import at
    1000 rows while every real driver keeps its bounds.
    """
    lo, hi = rf.memory_bounds
    column: dict[str, Any] = {"kind": "int", "editable": False, "min": int(lo)}
    if not rf.has_infinite_number:
        column["max"] = int(hi)
    return column


def _column_metadata_for_radio(radio: chirp_common.Radio) -> dict[str, Any]:
    """Build the grid's schema from an instantiated driver's own capabilities."""
    rf = radio.get_features()
    defaults = _memory_defaults()

    col: dict[str, Any] = {
        "Location": _location_column(rf),
        "Name": {
            "kind": "text",
            "editable": bool(rf.has_name),
            "maxLength": int(rf.valid_name_length),
            "validChars": str(rf.valid_characters),
        },
        "Frequency": _freq_column(True, rf),
        "Duplex": _enum_column(True, rf.valid_duplexes, defaults.get("Duplex")),
        "Offset": _freq_column(rf.has_offset, rf),
        "Tone": _enum_column(True, rf.valid_tmodes, defaults.get("Tone")),
        "rToneFreq": _formatted_enum_column(
            True, rf.valid_tones, "{:.1f}", float, defaults.get("rToneFreq")
        ),
        "cToneFreq": _formatted_enum_column(
            rf.has_ctone, rf.valid_tones, "{:.1f}", float, defaults.get("cToneFreq")
        ),
        "DtcsCode": _formatted_enum_column(
            rf.has_dtcs, rf.valid_dtcs_codes, "{:03d}", int, defaults.get("DtcsCode")
        ),
        "RxDtcsCode": _formatted_enum_column(
            rf.has_rx_dtcs, rf.valid_dtcs_codes, "{:03d}", int, defaults.get("RxDtcsCode")
        ),
        "DtcsPolarity": _enum_column(
            rf.has_dtcs_polarity, rf.valid_dtcs_pols, defaults.get("DtcsPolarity")
        ),
        "CrossMode": _enum_column(
            rf.has_cross, rf.valid_cross_modes, defaults.get("CrossMode")
        ),
        "Mode": _enum_column(rf.has_mode, rf.valid_modes, defaults.get("Mode")),
        "TStep": _formatted_enum_column(
            rf.has_tuning_step, rf.valid_tuning_steps, "{:.2f}", float, defaults.get("TStep")
        ),
        "Skip": _enum_column(True, rf.valid_skips, defaults.get("Skip")),
        "Power": {
            **_enum_column(True, rf.valid_power_levels),
            "optionWatts": _power_level_watts(rf.valid_power_levels),
        },
        "Comment": {
            "kind": "text",
            # Clone-mode radios without native comments use CHIRP's image
            # metadata hooks, so their comments are just as editable as
            # driver-backed ones.
            "editable": bool(
                rf.has_comment
                or isinstance(radio, chirp_common.ExternalMemoryProperties)
            ),
        },
    }
    for header in DV_ONLY_HEADERS:
        col[header] = {"kind": "text", "editable": False}

    headers = list(CSV_HEADERS)
    if not _radio_supports_dv(rf):
        headers = [h for h in headers if h not in DV_ONLY_HEADERS]

    return {
        "headers": headers,
        "columns": col,
    }


def get_radio_column_metadata(module_name: str, class_name: str) -> dict[str, Any]:
    """Build CHIRP-derived column editability/options metadata for the UI."""
    radio_cls = _import_radio_class(module_name, class_name)
    return _column_metadata_for_radio(_blank_radio_instance(radio_cls))


def get_default_schema() -> dict[str, Any]:
    """The grid's schema before a radio or a codeplug decides one.

    There is no "no radio" state in CHIRP: an editor with nothing loaded is
    ``generic_csv.CSVRadio``, a real driver whose ``RadioFeatures`` are
    deliberately permissive -- every mode, every tone mode, every CTCSS tone,
    1 Hz to 10 GHz, and an unbounded memory count. Reporting *that* rather than
    an empty schema is what lets the grid offer real pickers, validate a
    hand-typed cell and import repeaters before a radio is picked, all against
    the same code path a selected radio uses.
    """
    return _column_metadata_for_radio(_blank_csv_radio())

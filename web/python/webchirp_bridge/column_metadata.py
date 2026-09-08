"""What the channel grid needs to know about the selected radio's columns.

Derived from the driver's ``RadioFeatures``: which columns apply, the valid
choices for each enumerated one, the memory bounds and the power levels with
their wattages, so the grid can constrain edits before the upload preflight
ever runs.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable, Optional

from chirp import chirp_common

from webchirp_bridge.channel_rows import CSV_HEADERS
from webchirp_bridge.driver_cache import _blank_radio_instance, _import_radio_class
from webchirp_bridge.power_levels import _power_level_watts


DV_ONLY_HEADERS = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]


def _mk_enum(values: Optional[Iterable[Any]]) -> list[str]:
    """Normalize CHIRP value lists into string enums for UI metadata."""
    return [str(v) for v in values] if values else []


def _radio_supports_dv(rf: Any) -> bool:
    """Detect whether a radio's mode capabilities include D-STAR DV mode."""
    modes = {str(mode) for mode in (rf.valid_modes or [])}
    return "DV" in modes


def _enum_column(editable: Any, values: Optional[Iterable[Any]]) -> dict[str, Any]:
    """An enumerated column: the grid offers exactly the driver's values."""
    return {"kind": "enum", "editable": bool(editable), "options": _mk_enum(values)}


def _formatted_enum_column(
    editable: Any, values: Optional[Iterable[Any]], fmt: str, convert: Callable[[Any], Any]
) -> dict[str, Any]:
    """An enumerated column of numbers, spelled the way an exported CSV spells them."""
    options = [fmt.format(convert(value)) for value in (values or [])]
    return {"kind": "enum", "editable": bool(editable), "options": options}


def _freq_column(editable: Any, rf: Any) -> dict[str, Any]:
    """A frequency column constrained to the radio's bands."""
    bands = [[int(low), int(high)] for (low, high) in (rf.valid_bands or [])]
    return {"kind": "freq", "editable": bool(editable), "bands": bands}


def get_radio_column_metadata(module_name: str, class_name: str) -> dict[str, Any]:
    """Build CHIRP-derived column editability/options metadata for the UI."""
    radio_cls = _import_radio_class(module_name, class_name)
    radio = _blank_radio_instance(radio_cls)
    rf = radio.get_features()
    lo, hi = rf.memory_bounds

    col: dict[str, Any] = {
        "Location": {"kind": "int", "editable": False, "min": int(lo), "max": int(hi)},
        "Name": {
            "kind": "text",
            "editable": bool(rf.has_name),
            "maxLength": int(rf.valid_name_length),
            "validChars": str(rf.valid_characters),
        },
        "Frequency": _freq_column(True, rf),
        "Duplex": _enum_column(True, rf.valid_duplexes),
        "Offset": _freq_column(rf.has_offset, rf),
        "Tone": _enum_column(True, rf.valid_tmodes),
        "rToneFreq": _formatted_enum_column(True, rf.valid_tones, "{:.1f}", float),
        "cToneFreq": _formatted_enum_column(rf.has_ctone, rf.valid_tones, "{:.1f}", float),
        "DtcsCode": _formatted_enum_column(rf.has_dtcs, rf.valid_dtcs_codes, "{:03d}", int),
        "RxDtcsCode": _formatted_enum_column(
            rf.has_rx_dtcs, rf.valid_dtcs_codes, "{:03d}", int
        ),
        "DtcsPolarity": _enum_column(rf.has_dtcs_polarity, rf.valid_dtcs_pols),
        "CrossMode": _enum_column(rf.has_cross, rf.valid_cross_modes),
        "Mode": _enum_column(rf.has_mode, rf.valid_modes),
        "TStep": _formatted_enum_column(
            rf.has_tuning_step, rf.valid_tuning_steps, "{:.2f}", float
        ),
        "Skip": _enum_column(True, rf.valid_skips),
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

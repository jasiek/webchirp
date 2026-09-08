"""What the channel grid needs to know about the selected radio's columns.

Derived from the driver's ``RadioFeatures``: which columns apply, the valid
choices for each enumerated one, the memory bounds and the power levels with
their wattages, so the grid can constrain edits before the upload preflight
ever runs.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from chirp import chirp_common

from webchirp_bridge.channel_rows import CSV_HEADERS
from webchirp_bridge.driver_cache import _import_radio_class
from webchirp_bridge.power_levels import _power_level_watts


DV_ONLY_HEADERS = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]


def _mk_enum(values: Optional[Iterable[Any]]) -> list[str]:
    """Normalize CHIRP value lists into string enums for UI metadata."""
    return [str(v) for v in values] if values else []


def _radio_supports_dv(rf: Any) -> bool:
    """Detect whether a radio's mode capabilities include D-STAR DV mode."""
    modes = {str(mode) for mode in (rf.valid_modes or [])}
    return "DV" in modes


def get_radio_column_metadata(module_name: str, class_name: str) -> dict[str, Any]:
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
        # Clone-mode radios without native comments use CHIRP's image metadata
        # hooks, so their comments are just as editable as driver-backed ones.
        "editable": bool(
            rf.has_comment
            or isinstance(radio, chirp_common.ExternalMemoryProperties)
        ),
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

"""Power levels as text, watts and ``chirp_common.PowerLevel`` objects.

Drivers advertise power as ``PowerLevel`` objects whose labels and wattages
vary per radio, the grid and CSV carry a string, and the two have to be
reconciled in both directions without guessing: a label the radio does not
have must fail validation rather than silently pick a neighbour. Everything
that maps between those representations is collected here so the CSV
import/export path, the upload preflight and the column metadata agree on
the mapping.
"""

from __future__ import annotations

from typing import TYPE_CHECKING


from chirp import chirp_common

from webchirp_bridge.driver_cache import _driver_features
from webchirp_bridge.runtime_errors import RuntimeUnsupportedError

if TYPE_CHECKING:
    from typing import Any, Iterable, Optional

DEFAULT_EXPORT_POWER = "50W"


def _watts_label(level: chirp_common.PowerLevel) -> str:
    """Format a power level's wattage the way CHIRP writes power into a CSV.

    ``float()``, not ``int()``: ``PowerLevel.__int__`` truncates the dBm, so a
    50W level (46.99 dBm) formats as 39W and a 5W level as 4.0W.
    """
    return str(
        chirp_common.AutoNamedPowerLevel(chirp_common.dBm_to_watts(float(level)))
    )


def _power_label_map_from_features(
    rf: Optional[chirp_common.RadioFeatures],
) -> tuple[dict[str, str], str]:
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


def _valid_power_levels_for_driver(module_name: str, class_name: str) -> list[chirp_common.PowerLevel]:
    """Return a driver's own PowerLevel objects, or an empty list if unavailable."""
    rf = _driver_features(module_name, class_name)
    return list(getattr(rf, "valid_power_levels", None) or []) if rf else []


def _power_levels_by_label(levels: Iterable[chirp_common.PowerLevel]) -> dict[str, chirp_common.PowerLevel]:
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


def _level_map_for_radio(
    radio: Optional[chirp_common.Radio], module_name: str, class_name: str
) -> dict[str, chirp_common.PowerLevel]:
    """Index the power levels a radio instance advertises, or its driver's if none.

    A parsed image can advertise levels a blank instance does not (Rt98Radio),
    so the instance wins; the driver lookup only fills in for a radio that
    reports nothing, or for a preflight that runs before any instance exists.
    """
    levels = list(radio.get_features().valid_power_levels or []) if radio else []
    return _power_levels_by_label(
        levels or _valid_power_levels_for_driver(module_name, class_name)
    )


def _resolve_power_level(
    power_text: Any, level_map: dict[str, chirp_common.PowerLevel]
) -> Optional[chirp_common.PowerLevel]:
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


def _power_label_map_for_radio(module_name: str, class_name: str) -> tuple[dict[str, str], str]:
    """Map a selected driver's power labels to CSV power specs."""
    return _power_label_map_from_features(_driver_features(module_name, class_name))


def _csv_export_power_text(value: Any, power_map: dict[str, str]) -> str:
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


def _power_level_watts(levels: Optional[Iterable[chirp_common.PowerLevel]]) -> dict[str, str]:
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

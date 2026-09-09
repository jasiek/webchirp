"""Driver-specific per-channel settings: the row sidecar, and its schema.

``Memory.extra`` is a ``RadioSettingGroup`` a driver hangs off a channel for
everything the CSV columns have no room for -- Busy Channel Lockout, PTT-ID,
signalling code, scramble, compander. CHIRP's own grid can show those as
optional columns; here they ride on the row under ``ROW_EXTRA_KEY`` as a plain
name-to-value mapping, so a channel keeps them wherever the row is moved to,
and are replayed onto the destination memory on the way back out.

Values alone are not enough to *edit* them: "on", "3" and "Tone" say nothing
about what else the driver would accept. ``get_channel_extra`` answers that by
reading the memory the row occupies and serializing the setting objects the
driver built, reusing the same value serializer the radio-wide settings panel
runs on. The editor overlays the row's stored values on that schema and writes
the result back into the sidecar, which is the only thing the upload path
reads.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from chirp import (
    chirp_common,
    settings as chirp_settings,
)

from webchirp_bridge.driver_cache import _best_effort_radio_instance
from webchirp_bridge.jsbridge import _log_debug
from webchirp_bridge.radio_settings import _serialize_setting_value

if TYPE_CHECKING:
    from typing import Any, Optional
    from webchirp_bridge.channel_rows import Row

# Driver extras ride on channel rows under a key that is not a CSV header, the
# same way repeater coordinates do in web/js/row-geo.js (the browser side of
# this key is web/js/row-extra.js). Everything that serializes rows reads
# header keys only, so the sidecar never reaches a CSV or a codeplug; it
# travels with the row object while the grid is open.
ROW_EXTRA_KEY = "__extra"


def _is_primitive(value: Any) -> bool:
    """Whether a driver value survives the JSON trip to the editor and back.

    The sidecar and the schema both cross the Pyodide boundary as JSON, and a
    driver value that will not survive that is better dropped than turned into
    a string that ``set_value()`` would misread on the way back.
    """
    return isinstance(value, (bool, int, float, str))


def _row_extras_from_memory(memory: chirp_common.Memory) -> dict[str, Any]:
    """Read a driver's per-channel extra settings into a JSON-safe mapping.

    They ride back to the editor on the row itself so that a channel keeps them
    wherever the row is moved to, which a value read from the destination
    memory cannot express.
    """
    extra = getattr(memory, "extra", None)
    if not extra:
        return {}
    values: dict[str, Any] = {}
    for setting in extra:
        try:
            value = setting.value.get_value()
        except Exception:
            continue
        if _is_primitive(value):
            values[str(setting.get_name())] = value
    return values


def _apply_row_extras_to_memory(
    memory: chirp_common.Memory, row: Row
) -> bool:
    """Replay a row's stored extras onto a memory the driver just handed back.

    Returns whether any value actually moved, so the caller can skip a write
    that would change nothing. The memory has to come from the driver rather
    than be rebuilt from the row: it carries the driver's own setting objects,
    with this slot's option lists and value types, so no type has to be
    reconstructed from the row.

    A row with no sidecar is left alone. That is the channel the user created,
    imported from CSV, or pasted over this slot, and it is entitled to the
    driver's defaults rather than to whatever the previous occupant had.
    """
    stored = row.get(ROW_EXTRA_KEY)
    if not isinstance(stored, dict) or not stored:
        return False
    extra = getattr(memory, "extra", None)
    if not extra:
        return False
    changed = False
    for setting in extra:
        name = str(setting.get_name())
        if name not in stored:
            continue
        wanted = stored[name]
        try:
            if setting.value.get_value() == wanted:
                continue
            setting.value = wanted
        except Exception as exc:
            _log_debug(
                f"Channel {memory.number} extra setting {name} "
                f"could not be restored: {exc}"
            )
            continue
        changed = True
    return changed


def _apply_row_extras(radio: chirp_common.Radio, number: int, row: Row) -> None:
    """Replay a row's own extra settings onto the memory just written.

    set_memory() is what consumes ``Memory.extra``, and the 69 driver modules
    that clear the channel record before replaying it reset every hidden
    setting when handed a row-built Memory with an empty ``extra``. Re-reading
    the memory afterwards is what makes this safe to do generically.

    Writing again only pays for itself when a value actually moved.
    """
    memory = radio.get_memory(number)
    if _apply_row_extras_to_memory(memory, row):
        radio.set_memory(memory)


def _extra_setting_field(
    setting: chirp_settings.RadioSetting,
) -> Optional[dict[str, Any]]:
    """Serialize one ``Memory.extra`` setting into an editor field.

    ``None`` for anything the editor cannot represent: a multi-value setting
    (``RadioSetting.value`` is a list only when a driver appended more than one
    value, which no extra upstream does) and a value whose current reading is
    not a primitive, because the sidecar the editor writes back holds only
    those -- a field the user could change but the row could not carry would be
    worse than an absent one.
    """
    value = setting.value
    if isinstance(value, list):
        return None
    field = _serialize_setting_value(value)
    if field.get("current") is not None and not _is_primitive(field["current"]):
        return None
    field["name"] = str(setting.get_name())
    field["label"] = str(setting.get_shortname())
    # The driver's own explanation of the setting, where it wrote one
    # (h777.py's Busy Channel Lockout is the model case), shown under the
    # field's label exactly as the radio-wide settings panel shows it.
    field["doc"] = getattr(setting, "__doc__", None)
    return field


def _channel_extra_payload(
    available: bool, message: str, fields: Optional[list[dict[str, Any]]] = None
) -> dict[str, Any]:
    """The get_channel_extra reply: the fields, or why there are none."""
    return {
        "available": bool(available),
        "message": str(message or ""),
        "fields": fields or [],
    }


def get_channel_extra(
    module_name: str, class_name: str, location: Any
) -> dict[str, Any]:
    """Describe the extra settings the selected driver gives one memory slot.

    Read from the driver rather than from the row, because only the driver
    knows each setting's type, option list and bounds -- the row carries bare
    values. The values reported here are the ones the backing image holds; the
    editor overlays whatever the row already carries on top, so a channel the
    user has moved or edited shows its own settings rather than the slot's.

    Extras are per-memory in principle (a driver is free to expose different
    settings for different slots), so this resolves the memory the row names
    rather than a representative one.
    """
    try:
        number = int(str(location).strip())
    except (TypeError, ValueError):
        return _channel_extra_payload(
            False, "This channel has no memory slot to read extra settings from."
        )
    try:
        radio = _best_effort_radio_instance(module_name, class_name)
        memory = radio.get_memory(number)
    except Exception as exc:
        _log_debug(f"Channel {number} extra settings unavailable: {exc}")
        # Two causes reach here and cannot be told apart from outside the
        # driver: a slot it refuses to decode, and a driver with no backing
        # state to decode from. The reason itself is in the debug panel.
        return _channel_extra_payload(
            False,
            "This channel's extra settings could not be read. Download from the "
            "radio or load a codeplug image first.",
        )
    extra = getattr(memory, "extra", None)
    if not extra:
        return _channel_extra_payload(
            False, "This radio has no extra settings for its channels."
        )
    fields = []
    for setting in extra:
        try:
            field = _extra_setting_field(setting)
        except Exception as exc:
            _log_debug(
                f"Channel {number} extra setting "
                f"{setting.get_name()} could not be described: {exc}"
            )
            continue
        if field is not None:
            fields.append(field)
    if not fields:
        return _channel_extra_payload(
            False, "This radio has no editable extra settings for this channel."
        )
    return _channel_extra_payload(True, "", fields)

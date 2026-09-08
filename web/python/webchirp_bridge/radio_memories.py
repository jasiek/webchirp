"""Moving channel rows in and out of a radio instance.

The download side reads every memory the driver exposes into rows, the
upload side writes rows back and erases what the grid no longer has. The two
loops are coupled through absence -- a memory missing from the rows is a
deletion -- which is why the read side records what it could not decode and
the write side protects those slots (see ``UNREADABLE_BY_DRIVER``). Both
report per-channel failures to the debug panel grouped by reason, since a
driver that fails on hundreds of channels would otherwise bury it.
"""

from __future__ import annotations

import traceback
from typing import Any, Optional, Sequence

from chirp import chirp_common

from webchirp_bridge.channel_rows import (
    CSV_HEADERS,
    ROW_EXTRA_KEY,
    Rows,
    _apply_row_extras,
    _coerce_csv_vals_for_chirp,
    _memory_from_row_values,
    _row_extras_from_memory,
    _row_from_memory,
)
from webchirp_bridge.driver_cache import (
    _cache_driver_image,
    _protected_channels,
    _record_unreadable_channels,
)
from webchirp_bridge.jsbridge import _log_debug
from webchirp_bridge.power_levels import _level_map_for_radio
from webchirp_bridge.radio_settings import _validate_and_apply_radio_settings
from webchirp_bridge.row_validation import _immutable_policy_errors, _prepare_row_change
from webchirp_bridge.runtime_errors import RuntimeUnsupportedError


def _iter_memory_numbers(radio: chirp_common.Radio) -> range:
    """Return numeric memory range for the active radio model."""
    rf = radio.get_features()
    if not hasattr(rf, "memory_bounds") or not rf.memory_bounds:
        raise RuntimeUnsupportedError("Driver has no numeric memory bounds")
    lo, hi = rf.memory_bounds
    return range(int(lo), int(hi) + 1)


# Cap on distinct failure groups reported for one operation. Groups are keyed by
# the driver's own exception text, which a driver is free to make unique per
# memory by naming the number or the offending value in the message -- so
# capping the numbers listed per line is not on its own enough to keep a
# whole-radio failure from burying the debug panel.
MAX_LOGGED_FAILURE_GROUPS = 5


def _format_channel_numbers(numbers: Sequence[int], limit: int = 8) -> str:
    """Render channel numbers for a single debug line.

    Capped because a driver that fails on every slot would otherwise emit a
    line naming hundreds of channels and bury the rest of the debug panel.
    """
    shown = ", ".join(str(number) for number in numbers[:limit])
    remainder = len(numbers) - limit
    return f"{shown} and {remainder} more" if remainder > 0 else shown


def _log_grouped_channel_failures(
    numbers_by_reason: dict[str, list[int]],
    summary: str,
    traces_by_reason: Optional[dict[str, str]] = None,
) -> None:
    """Report per-channel driver failures to the debug panel, bounded both ways.

    Widest groups are reported first so that truncation drops the long tail of
    one-off messages rather than the failure that explains the most channels.
    """
    ordered = sorted(numbers_by_reason.items(), key=lambda item: (-len(item[1]), item[0]))
    for reason, numbers in ordered[:MAX_LOGGED_FAILURE_GROUPS]:
        trace = (traces_by_reason or {}).get(reason, "")
        _log_debug(
            f"Channels {_format_channel_numbers(numbers)} {summary}: {reason}"
            + (f"\n{trace}" if trace else "")
        )
    remainder = ordered[MAX_LOGGED_FAILURE_GROUPS:]
    if remainder:
        affected = sorted(number for _, numbers in remainder for number in numbers)
        _log_debug(
            f"{len(remainder)} further distinct failures are not shown, "
            f"affecting channels {_format_channel_numbers(affected)}"
        )


def _read_memory(radio: chirp_common.Radio, number: int) -> chirp_common.Memory:
    """Read one memory as CHIRP's editor sees it, external properties included.

    Clone-mode radios keep comments outside driver memory, in the image
    metadata; get_memory_extra is the post-read hook desktop CHIRP applies
    so they appear on the memory like any other field. Raises whatever the
    driver raises, so callers decide how a decode failure is recorded.
    """
    mem = radio.get_memory(number)
    if isinstance(radio, chirp_common.ExternalMemoryProperties):
        mem = radio.get_memory_extra(mem)
    return mem


def _erase_memory(radio: chirp_common.Radio, number: int) -> None:
    """Erase one memory together with the external properties stored beside it."""
    radio.erase_memory(number)
    if isinstance(radio, chirp_common.ExternalMemoryProperties):
        radio.erase_memory_extra(number)


def _radio_rows_from_instance(radio: chirp_common.Radio) -> tuple[Rows, list[int]]:
    """Extract channel rows from a radio instance using CHIRP memory API.

    Returns the decoded rows and the numbers the driver refused to decode. A
    memory that raises is skipped rather than failing the whole download, but
    it must not vanish without trace: the traceback goes to the debug panel and
    the number is handed back so callers can mark the slot. Those same numbers
    are the ones `_apply_rows_to_radio_instance` must never erase, since their
    absence from the grid reflects a decode failure, not a user deletion.
    """
    rows: Rows = []
    unreadable: list[int] = []
    numbers_by_reason: dict[str, list[int]] = {}
    trace_by_reason: dict[str, str] = {}
    for number in _iter_memory_numbers(radio):
        try:
            mem = _read_memory(radio, number)
        except Exception as exc:
            reason = str(exc) or exc.__class__.__name__
            unreadable.append(number)
            numbers_by_reason.setdefault(reason, []).append(number)
            # One traceback per distinct failure is enough to diagnose it, and
            # keeps a driver that raises on every slot from flooding the panel.
            trace_by_reason.setdefault(reason, traceback.format_exc())
            continue
        if getattr(mem, "empty", False):
            continue
        row = _row_from_memory(mem)
        extras = _row_extras_from_memory(mem)
        if extras:
            row[ROW_EXTRA_KEY] = extras
        rows.append(row)

    _log_grouped_channel_failures(
        numbers_by_reason,
        "could not be decoded by the driver and are missing from the channel list",
        trace_by_reason,
    )
    return rows, unreadable


def _read_radio_payload(
    module_name: str, class_name: str, radio: chirp_common.Radio
) -> dict[str, Any]:
    """Everything a freshly read radio hands the grid, plus the state it leaves.

    The serial download and the image load differ only in how they obtained the
    radio; from here on both cache its image under the driver key, extract the
    rows, record the slots that would not decode so a later upload leaves them
    alone, and serialize the radio-wide settings read-only.
    """
    _cache_driver_image(module_name, class_name, radio)
    rows, unreadable = _radio_rows_from_instance(radio)
    _record_unreadable_channels(module_name, class_name, unreadable)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "rows": rows,
        "headers": CSV_HEADERS,
        "settings": settings_result["settings"],
        "unreadableChannels": unreadable,
    }


def _apply_rows_to_radio_instance(
    radio: chirp_common.Radio, rows: Rows, module_name: str = "", class_name: str = ""
) -> None:
    """Validate editable rows, then apply them to a radio instance."""
    if radio and (not module_name or not class_name):
        radio_cls = radio.__class__
        module_name = module_name or str(getattr(radio_cls, "__module__", "")).split(".")[-1]
        class_name = class_name or str(getattr(radio_cls, "__name__", ""))
    level_map = _level_map_for_radio(radio, module_name, class_name)
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
        # External properties participate in row equality and immutable-field
        # validation even though the driver memory itself does not contain them.
        existing = _read_memory(radio, number)
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
            _erase_memory(radio, number)
        else:
            radio.set_memory(mem)
            _apply_row_extras(radio, number, row)
            if isinstance(radio, chirp_common.ExternalMemoryProperties):
                radio.set_memory_extra(mem)

    # A slot that failed to decode on download was never offered to the user, so
    # its absence from the rows is not a deletion and must not be treated as one.
    # A row the user did supply for that number still writes normally: explicit
    # intent is in seen_numbers and never reaches this loop.
    protected = _protected_channels(module_name, class_name) - seen_numbers
    for number in sorted(valid_numbers - seen_numbers - protected):
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
        _erase_memory(radio, number)

    if protected:
        _log_debug(
            f"Channels {_format_channel_numbers(sorted(protected))} were left "
            f"untouched because the driver could not decode them when this "
            f"image was read"
        )
    _log_grouped_channel_failures(
        unreadable_erase_slots,
        "were not erased because their current values could not be checked",
    )

"""Moving channel rows in and out of a radio instance.

The download side reads every memory the driver exposes into rows, the
upload side writes rows back and erases what the grid no longer has. The two
loops are coupled through absence -- a memory missing from the rows is a
deletion -- which is why the read side records what it could not decode on
the session (``RadioSession.unreadable_channels`` in
web/python/webchirp_bridge/session.py) and the write side protects those
slots. Both report per-channel failures to the debug panel grouped by
reason, since a driver that fails on hundreds of channels would otherwise
bury it.
"""

from __future__ import annotations

import traceback
from typing import TYPE_CHECKING

from chirp import chirp_common

from webchirp_bridge.channel_extra import (
    ROW_EXTRA_KEY,
    _apply_row_extras,
    _apply_row_extras_to_memory,
    _row_extras_from_memory,
)
from webchirp_bridge.channel_rows import (
    CSV_HEADERS,
    _coerce_csv_vals_for_chirp,
    _memory_from_row_values,
    _row_from_memory,
)
from webchirp_bridge.jsbridge import _log_debug
from webchirp_bridge.power_levels import _level_map_for_radio
from webchirp_bridge.radio_settings import _validate_and_apply_radio_settings
from webchirp_bridge.row_validation import (
    _erased_copy,
    _immutable_policy_errors,
    _memory_slot_key,
    _prepare_row_change,
    _row_location,
)
from webchirp_bridge.runtime_errors import RuntimeUnsupportedError

if TYPE_CHECKING:
    from typing import Any, Optional, Sequence
    from webchirp_bridge.channel_rows import Rows
    from webchirp_bridge.session import ImageOrigin, RadioSession

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


def _radio_rows_from_instance(
    radio: chirp_common.Radio,
) -> tuple[Rows, list[int], list[int]]:
    """Extract channel rows from a radio instance using CHIRP memory API.

    Returns the decoded rows, the numbers the driver refused to decode and the
    numbers of decoded channels it will not erase. A memory that raises is
    skipped rather than failing the whole download, but it must not vanish
    without trace: the traceback goes to the debug panel and the number is
    handed back so callers can mark the slot. Those same numbers are the ones
    `_apply_rows_to_radio_instance` must never erase, since their absence from
    the grid reflects a decode failure, not a user deletion.

    A channel whose memory lists ``empty`` in ``immutable`` always exists on
    the radio (fixed GMRS/FRS/MURS or call channels): desktop CHIRP refuses to
    delete it, and an upload that omits it keeps it. Its number is handed back
    so the grid can refuse the delete up front rather than let it silently not
    happen. An empty slot is not listed, since there is no row to delete.
    """
    rows: Rows = []
    unreadable: list[int] = []
    undeletable: list[int] = []
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
        if "empty" in mem.immutable:
            undeletable.append(number)
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
    return rows, unreadable, undeletable


def _read_radio_payload(
    session: RadioSession, radio: chirp_common.Radio, origin: ImageOrigin
) -> dict[str, Any]:
    """Everything a freshly read radio hands the grid, plus the state it leaves.

    The serial download and the image load differ only in how they obtained the
    radio -- ``origin`` says which; from here on both record its image on the
    session, extract the rows, record the slots that would not decode so a
    later upload leaves them alone and the channels the driver will not erase
    so the grid refuses to delete them, and serialize the radio-wide settings
    read-only.

    A driver whose ``get_settings()`` raises must not cost the user the
    channels that decoded fine: the settings helper logs it and answers with
    none, which the UI reads as "no Settings tab".
    """
    session.record_radio(radio, origin)
    rows, unreadable, undeletable = _radio_rows_from_instance(radio)
    session.record_unreadable_channels(unreadable)
    session.record_undeletable_channels(undeletable)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "rows": rows,
        "headers": CSV_HEADERS,
        "settings": settings_result["settings"],
        "unreadableChannels": unreadable,
    }


def _apply_rows_to_radio_instance(
    radio: chirp_common.Radio, rows: Rows, session: Optional[RadioSession] = None
) -> None:
    """Validate editable rows, then apply them to a radio instance.

    ``session`` is the one the radio was rebuilt from, when there is one: it
    supplies the memory numbers that must not be erased and the driver's
    power levels for a radio that reports none. Without it the instance's own
    features are all there is, which is what an offline test radio gets.

    Every row must name its own slot. A blank Location is refused rather
    than read as 0, which on a radio numbered from 0 is a real memory the row
    would silently replace, and a slot two rows share is refused rather than
    left to the last of them. The preflight the UI runs before an upload or a
    binary export reports these, and every value the driver refuses, as
    cells; this is the check that still holds for a caller that ran none, such
    as the agent CLI, or rows that changed after their preflight.
    """
    level_map = _level_map_for_radio(radio, session)
    valid_numbers = set(_iter_memory_numbers(radio))
    seen_numbers = set()
    seen_slots: dict[int, int] = {}
    unreadable_erase_slots: dict[str, list[int]] = {}
    for row_index, row in enumerate(rows):
        number = _row_location(row)
        if number is None:
            location = row.get("Location")
            if location is None or not str(location).strip():
                raise RuntimeUnsupportedError(
                    f"Row {row_index + 1} has no channel Location"
                )
            raise RuntimeUnsupportedError(
                f"Invalid Location value in row {row_index + 1}: {location!r}"
            )
        if number not in valid_numbers:
            raise RuntimeUnsupportedError(
                f"Channel Location {number} is outside radio memory bounds"
            )
        slot = _memory_slot_key(row, number)
        if slot in seen_slots:
            raise RuntimeUnsupportedError(
                f"Row {row_index + 1}: channel Location {number} is already "
                f"used by row {seen_slots[slot] + 1}"
            )
        seen_slots[slot] = row_index
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
            # The grid columns say nothing changed, but the extras editor
            # (web/js/ui/channel-extra.ts) writes only to the row's sidecar, so
            # a channel whose Busy Channel Lockout was just switched off looks
            # exactly like an untouched one here. Replay the sidecar against
            # the memory that was read a moment ago: it only writes when a
            # value actually differs, so an untouched row still costs nothing.
            extras_changed, _rejected = _apply_row_extras_to_memory(existing, row)
            if extras_changed:
                radio.set_memory(existing)
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
    protected = (session.unreadable_channels if session else set()) - seen_numbers
    undeletable_slots: dict[str, list[int]] = {}
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
        # A slot the driver will not let go of (empty is immutable on fixed
        # GMRS channels, for one) stays as it is, as it would in desktop
        # CHIRP, which refuses to delete it. Refusing the upload instead would
        # be an error no preflight can foresee, since an omitted channel has
        # no row to highlight, and would leave the user re-adding every fixed
        # channel by hand. A row that clears its Frequency is explicit, so
        # _prepare_row_change still refuses that one.
        validation_errors = _immutable_policy_errors(
            radio, existing, _erased_copy(existing)
        )
        if validation_errors:
            reason = "; ".join(str(error) for error in validation_errors)
            undeletable_slots.setdefault(reason, []).append(number)
            continue
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
    _log_grouped_channel_failures(
        undeletable_slots,
        "are missing from the channel list but were kept, because the driver "
        "does not allow erasing them",
    )

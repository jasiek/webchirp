"""Channel validation and lossless application to radio memories."""

from __future__ import annotations

from typing import Any, Optional, Sequence

from chirp import chirp_common
import re
import traceback
import runtime_channels
import runtime_drivers
import runtime_images
import runtime_support


def _infer_csv_error_column(error_text: str) -> str:
    """Best-effort mapping from CHIRP parse error text to CSV column name."""
    text = str(error_text or "")
    match = re.search(r"vals\[(\d+)\]", text)
    if match:
        idx = int(match.group(1))
        if 0 <= idx < len(runtime_support.CSV_HEADERS):
            return runtime_support.CSV_HEADERS[idx]

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
    rf = runtime_drivers._driver_features(module_name, class_name)
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
    return runtime_images._best_effort_radio_instance(
        module_name, class_name, require_cached=False
    )


def _immutable_field_errors(
    existing: chirp_common.Memory, new: chirp_common.Memory
) -> list[runtime_support.ValidationMessage]:
    """Return errors for driver-declared fields changed by a row.

    CHIRP's grid prevents edits to ``Memory.immutable`` fields before its
    driver policy hook is involved. Some drivers deliberately relax that hook
    for bulk import, so the browser must retain this explicit check to match
    the grid and avoid writing fields the driver presented as read-only.
    """
    immutable_errors: list[runtime_support.ValidationMessage] = []
    for field in list(getattr(existing, "immutable", None) or []):
        if getattr(existing, field) != getattr(new, field):
            immutable_errors.append(
                chirp_common.ImmutableValueError(
                    f"Field {field} is not mutable on this memory"
                )
            )
    return immutable_errors


def _preserve_unedited_immutable_fields(
    row: runtime_support.Row, existing: chirp_common.Memory, mem: chirp_common.Memory
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
        for header, value in zip(runtime_support.CSV_HEADERS, runtime_channels._row_values_for_csv(existing))
    }
    for field in list(getattr(existing, "immutable", None) or []):
        header = field_headers.get(field)
        if header and str(row.get(header, "") or "") == existing_row[header]:
            setattr(mem, field, getattr(existing, field))


def _row_extras_from_memory(memory: chirp_common.Memory) -> dict[str, Any]:
    """Read a driver's per-channel extra settings into a JSON-safe mapping.

    ``Memory.extra`` holds settings the channel grid has no column for (Busy
    Channel Lockout, PTT-ID, signalling code, scramble). They ride back to the
    editor on the row itself so that a channel keeps them wherever the row is
    moved to, which a value read from the destination memory cannot express.

    Only primitives are kept: the mapping crosses the Pyodide boundary as JSON,
    and a driver value that will not survive that is better dropped here than
    turned into a string that ``set_value()`` would misread on the way back.
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
        if isinstance(value, (bool, int, float, str)):
            values[str(setting.get_name())] = value
    return values


def _apply_row_extras(radio: chirp_common.Radio, number: int, row: runtime_support.Row) -> None:
    """Replay a row's own extra settings onto the memory just written.

    set_memory() is what consumes ``Memory.extra``, and the 69 driver modules
    that clear the channel record before replaying it reset every hidden
    setting when handed a row-built Memory with an empty ``extra``. Re-reading
    the memory afterwards is what makes this safe to do generically: the driver
    hands back its own setting objects, with this slot's option lists and value
    types, so no type has to be reconstructed from the row.

    A row with no sidecar is left alone. That is the channel the user created,
    imported from CSV, or pasted over this slot, and it is entitled to the
    driver's defaults rather than to whatever the previous occupant had.
    """
    stored = row.get(runtime_support.ROW_EXTRA_KEY)
    if not isinstance(stored, dict) or not stored:
        return
    memory = radio.get_memory(number)
    extra = getattr(memory, "extra", None)
    if not extra:
        return
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
            runtime_support._log_debug(
                f"Channel {number} extra setting {name} could not be restored: {exc}"
            )
            continue
        changed = True
    # Writing again only pays for itself when a value actually moved, and an
    # unchanged row never reaches here because _prepare_row_change skips it.
    if changed:
        radio.set_memory(memory)


def _prepare_and_validate_memory(
    radio: chirp_common.Radio,
    existing: chirp_common.Memory,
    mem: chirp_common.Memory,
    row: Optional[runtime_support.Row] = None,
) -> tuple[chirp_common.Memory, list[str], list[runtime_support.ValidationMessage]]:
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
) -> list[runtime_support.ValidationMessage]:
    """Run both the declared-field and driver-specific immutable policies."""
    validation_errors = _immutable_field_errors(existing, new)
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


def _row_matches_memory(row: runtime_support.Row, memory: chirp_common.Memory) -> bool:
    """Compare a grid row at exactly the fidelity exposed by the grid."""
    row_values = [str(row.get(header, "") or "") for header in runtime_support.CSV_HEADERS]
    memory_values = [str(value) for value in runtime_channels._row_values_for_csv(memory)]
    return row_values == memory_values


def _prepare_row_change(
    radio: chirp_common.Radio,
    row: runtime_support.Row,
    existing: chirp_common.Memory,
    mem: chirp_common.Memory,
) -> tuple[
    runtime_support.RowChangeAction,
    chirp_common.Memory,
    list[str],
    list[runtime_support.ValidationMessage],
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


def _validation_column(message: runtime_support.ValidationMessage) -> str:
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
    rows: runtime_support.Rows, module_name: str = "", class_name: str = ""
) -> dict[str, Any]:
    """Validate rows with the selected driver and return errors and warnings."""
    radio = (
        _radio_instance_for_row_validation(module_name, class_name)
        if module_name and class_name
        else None
    )
    levels = list(radio.get_features().valid_power_levels or []) if radio else []
    level_map = runtime_channels._power_levels_by_label(
        levels or runtime_channels._valid_power_levels_for_driver(module_name, class_name)
    )
    # Location is checked here as well as in _apply_rows_to_radio_instance,
    # because that one raises partway through a clone: the radio is already
    # open and some memories written. Preflight is the only place a bad
    # Location can be reported while it is still just a highlighted cell.
    bounds = _memory_bounds_for_driver(module_name, class_name)
    seen_locations: dict[int, int] = {}
    issues: list[runtime_support.ValidationIssue] = []
    warnings: list[runtime_support.ValidationIssue] = []
    for row_index, row in enumerate(rows or []):
        vals = [str((row or {}).get(header, "") or "") for header in runtime_support.CSV_HEADERS]
        vals = runtime_channels._coerce_csv_vals_for_chirp(vals)
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
            mem = runtime_channels._memory_from_row_values(vals, level_map)
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
            row_errors: list[runtime_support.ValidationMessage] = [exc]
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


def _iter_memory_numbers(radio: Any) -> Any:
    """Return numeric memory range for the active radio model."""
    rf = radio.get_features()
    if not hasattr(rf, "memory_bounds") or not rf.memory_bounds:
        raise runtime_support.RuntimeUnsupportedError("Driver has no numeric memory bounds")
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
        runtime_support._log_debug(
            f"Channels {_format_channel_numbers(numbers)} {summary}: {reason}"
            + (f"\n{trace}" if trace else "")
        )
    remainder = ordered[MAX_LOGGED_FAILURE_GROUPS:]
    if remainder:
        affected = sorted(number for _, numbers in remainder for number in numbers)
        runtime_support._log_debug(
            f"{len(remainder)} further distinct failures are not shown, "
            f"affecting channels {_format_channel_numbers(affected)}"
        )


def _radio_rows_from_instance(radio: Any) -> tuple[runtime_support.Rows, list[int]]:
    """Extract channel rows from a radio instance using CHIRP memory API.

    Returns the decoded rows and the numbers the driver refused to decode. A
    memory that raises is skipped rather than failing the whole download, but
    it must not vanish without trace: the traceback goes to the debug panel and
    the number is handed back so callers can mark the slot. Those same numbers
    are the ones `_apply_rows_to_radio_instance` must never erase, since their
    absence from the grid reflects a decode failure, not a user deletion.
    """
    rows: runtime_support.Rows = []
    unreadable: list[int] = []
    numbers_by_reason: dict[str, list[int]] = {}
    trace_by_reason: dict[str, str] = {}
    for number in _iter_memory_numbers(radio):
        try:
            mem = radio.get_memory(number)
            # CloneModeRadio stores comments outside driver memory in its image
            # metadata, so mirror desktop CHIRP's post-read augmentation hook.
            if isinstance(radio, chirp_common.ExternalMemoryProperties):
                mem = radio.get_memory_extra(mem)
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
        row: runtime_support.Row = {}
        for header, value in zip(runtime_support.CSV_HEADERS, runtime_channels._row_values_for_csv(mem)):
            row[header] = str(value)
        extras = _row_extras_from_memory(mem)
        if extras:
            row[runtime_support.ROW_EXTRA_KEY] = extras
        rows.append(row)

    _log_grouped_channel_failures(
        numbers_by_reason,
        "could not be decoded by the driver and are missing from the channel list",
        trace_by_reason,
    )
    return rows, unreadable


def _apply_rows_to_radio_instance(
    radio: Any, rows: runtime_support.Rows, module_name: str = "", class_name: str = ""
) -> None:
    """Validate editable rows, then apply them to a radio instance."""
    if radio and (not module_name or not class_name):
        radio_cls = radio.__class__
        module_name = module_name or str(getattr(radio_cls, "__module__", "")).split(".")[-1]
        class_name = class_name or str(getattr(radio_cls, "__name__", ""))
    level_map = runtime_channels._power_levels_by_label(
        list(radio.get_features().valid_power_levels or [])
        or runtime_channels._valid_power_levels_for_driver(module_name, class_name)
    )
    valid_numbers = set(_iter_memory_numbers(radio))
    seen_numbers = set()
    unreadable_erase_slots: dict[str, list[int]] = {}
    for row in rows:
        try:
            number = int(row.get("Location", "0") or 0)
        except ValueError as exc:
            raise runtime_support.RuntimeUnsupportedError(
                f"Invalid Location value in row: {row.get('Location')!r}"
            ) from exc
        if number not in valid_numbers:
            raise runtime_support.RuntimeUnsupportedError(
                f"Channel Location {number} is outside radio memory bounds"
            )
        seen_numbers.add(number)
        # CHIRP's immutable policy needs the current driver memory, not merely
        # the flattened grid row, before deciding whether a write is allowed.
        existing = radio.get_memory(number)
        # External properties participate in row equality and immutable-field
        # validation even though the driver memory itself does not contain them.
        if isinstance(radio, chirp_common.ExternalMemoryProperties):
            existing = radio.get_memory_extra(existing)
        vals = [str(row.get(h, "") or "") for h in runtime_support.CSV_HEADERS]
        vals = runtime_channels._coerce_csv_vals_for_chirp(vals)
        vals[0] = str(number)
        mem = runtime_channels._memory_from_row_values(vals, level_map)
        mem.number = number
        action, mem, warnings, validation_errors = _prepare_row_change(
            radio, row, existing, mem
        )
        if action == "skip":
            continue
        if validation_errors:
            raise runtime_support.RuntimeUnsupportedError(
                f"Channel {number}: {'; '.join(str(error) for error in validation_errors)}"
            )
        for warning in warnings:
            runtime_support._log_debug(f"Channel {number} validation warning: {warning}")
        if action == "erase":
            radio.erase_memory(number)
            if isinstance(radio, chirp_common.ExternalMemoryProperties):
                radio.erase_memory_extra(number)
        else:
            radio.set_memory(mem)
            _apply_row_extras(radio, number, row)
            if isinstance(radio, chirp_common.ExternalMemoryProperties):
                radio.set_memory_extra(mem)

    # A slot that failed to decode on download was never offered to the user, so
    # its absence from the rows is not a deletion and must not be treated as one.
    # A row the user did supply for that number still writes normally: explicit
    # intent is in seen_numbers and never reaches this loop.
    protected = runtime_images._protected_channels(module_name, class_name) - seen_numbers
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
            raise runtime_support.RuntimeUnsupportedError(
                f"Channel {number}: {'; '.join(str(error) for error in validation_errors)}"
            )
        radio.erase_memory(number)
        if isinstance(radio, chirp_common.ExternalMemoryProperties):
            radio.erase_memory_extra(number)

    if protected:
        runtime_support._log_debug(
            f"Channels {_format_channel_numbers(sorted(protected))} were left "
            f"untouched because the driver could not decode them when this "
            f"image was read"
        )
    _log_grouped_channel_failures(
        unreadable_erase_slots,
        "were not erased because their current values could not be checked",
    )

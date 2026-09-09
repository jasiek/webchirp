"""The upload preflight: which rows the selected radio will refuse, and why.

``validate_rows_for_upload`` runs every row through the driver's own
``validate_memory`` and the runtime's immutable-field policy before a byte
goes to the radio, reporting one issue per offending cell so the grid can
mark it. The row-change classification (skip, erase or set) is shared with
the write path in ``web/python/webchirp_bridge/radio_memories.py`` so the
preflight and the upload can never disagree about what a row means.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from chirp import chirp_common

from webchirp_bridge.channel_extra import _apply_row_extras_to_memory
from webchirp_bridge.channel_rows import (
    CSV_HEADERS,
    _coerce_csv_vals_for_chirp,
    _memory_from_row_values,
    _row_from_memory,
    _row_text_values,
)
from webchirp_bridge.driver_cache import _best_effort_radio_instance, _driver_features
from webchirp_bridge.power_levels import _level_map_for_radio

if TYPE_CHECKING:
    from typing import Any, Literal, Optional
    from webchirp_bridge.channel_rows import Row, Rows

    # One invalid cell reported by the upload preflight: which row, which column,
    # and CHIRP's own message for it.
    ValidationIssue = dict[str, Any]
    ValidationMessage = str | Exception
    RowChangeAction = Literal["skip", "erase", "set"]

# CHIRP Memory attribute -> the grid column (CSV header) that shows it, in
# Memory.CSV_FORMAT order. Every translation between the driver's field
# names and the grid's columns reads this one table, so a field listed here is
# detected as a change, kept when immutable and reported in the right cell all
# at once; the three copies this replaced could each drift on their own.
MEMORY_FIELD_HEADERS: dict[str, str] = {
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
# The grid's synthetic column for driver extras, which every findings message
# about them is reported against so the cell the button sits in is the one that
# highlights. Spelled the same way web/js/ui/channel-table.js spells it.
EXTRA_COLUMN = "Extra"

# Fields an immutable-field error can name that are not grid fields: number
# is the row's Location, and empty has no column, so it lands on Frequency,
# the cell that defines whether a channel exists.
_ERROR_FIELD_COLUMNS: dict[str, str] = {
    **MEMORY_FIELD_HEADERS,
    "number": "Location",
    "empty": "Frequency",
}


def _infer_csv_error_column(error_text: str) -> str:
    """Best-effort mapping from CHIRP parse error text to CSV column name."""
    text = str(error_text or "")
    match = re.search(r"vals\[(\d+)\]", text)
    if match:
        idx = int(match.group(1))
        if 0 <= idx < len(CSV_HEADERS):
            return CSV_HEADERS[idx]

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
    rf = _driver_features(module_name, class_name)
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
    return _best_effort_radio_instance(
        module_name, class_name, require_cached=False
    )


def _immutable_field_errors(
    existing: chirp_common.Memory, new: chirp_common.Memory
) -> list[ValidationMessage]:
    """Return errors for driver-declared fields changed by a row.

    CHIRP's grid prevents edits to ``Memory.immutable`` fields before its
    driver policy hook is involved. Some drivers deliberately relax that hook
    for bulk import, so the browser must retain this explicit check to match
    the grid and avoid writing fields the driver presented as read-only.
    """
    immutable_errors: list[ValidationMessage] = []
    for field in list(getattr(existing, "immutable", None) or []):
        if getattr(existing, field) != getattr(new, field):
            immutable_errors.append(
                chirp_common.ImmutableValueError(
                    f"Field {field} is not mutable on this memory"
                )
            )
    return immutable_errors


def _preserve_unedited_immutable_fields(
    row: Row, existing: chirp_common.Memory, mem: chirp_common.Memory
) -> None:
    """Keep immutable values whose grid representation was not edited.

    A few drivers expose an immutable value that their feature list cannot
    reconstruct (notably fixed power levels). Comparing the source row avoids
    turning an edit to another column into an accidental immutable-field edit.
    """
    existing_row = _row_from_memory(existing)
    for field in list(getattr(existing, "immutable", None) or []):
        header = MEMORY_FIELD_HEADERS.get(field)
        if header and str(row.get(header, "") or "") == existing_row[header]:
            setattr(mem, field, getattr(existing, field))


def _prepare_and_validate_memory(
    radio: chirp_common.Radio,
    existing: chirp_common.Memory,
    mem: chirp_common.Memory,
    row: Optional[Row] = None,
) -> tuple[chirp_common.Memory, list[str], list[ValidationMessage]]:
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
) -> list[ValidationMessage]:
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
    fields = (*MEMORY_FIELD_HEADERS, "empty")
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


def _row_matches_memory(row: Row, memory: chirp_common.Memory) -> bool:
    """Compare a grid row at exactly the fidelity exposed by the grid."""
    row_values = [str(row.get(header, "") or "") for header in CSV_HEADERS]
    memory_values = _row_text_values(memory)
    return row_values == memory_values


def _prepare_row_change(
    radio: chirp_common.Radio,
    row: Row,
    existing: chirp_common.Memory,
    mem: chirp_common.Memory,
) -> tuple[
    RowChangeAction,
    chirp_common.Memory,
    list[str],
    list[ValidationMessage],
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


def _row_extra_findings(
    radio: chirp_common.Radio,
    row: Row,
    existing: chirp_common.Memory,
    action: RowChangeAction,
) -> tuple[list[str], list[str]]:
    """What a row's driver extras would do to the memory they land on.

    Two things nothing else in the preflight looks at. A stored value the
    driver refuses -- an option this slot does not offer, a number outside its
    range -- is a silent loss at write time: the rest of the channel is written
    and that one setting keeps the destination's value. And a row whose grid
    columns match the memory exactly is classified "skip", which returns before
    ``validate_memory`` is ever called, so a driver with an extras-dependent
    rule (``hf90`` on scan/selcall, ``ft450d`` on mode/filter, ``ar8200``) never
    gets to see the combination an extras-only edit produces.

    Applying the sidecar to ``existing`` is safe here in a way it would not be
    in the write path: the preflight builds a throwaway radio and re-reads each
    memory, so the mutated setting objects are discarded with it.

    A changed row re-validates in ``_prepare_and_validate_memory`` already, and
    re-running it here with the extras attached would report every finding
    twice; the value check still runs for those rows, which is the half that is
    genuinely missing.
    """
    if action == "erase":
        return [], []
    changed, rejected = _apply_row_extras_to_memory(existing, row)
    if not changed or action != "skip":
        return list(rejected), []
    try:
        messages = radio.validate_memory(chirp_common.FrozenMemory(existing))
    except Exception as exc:
        return [*rejected, str(exc)], []
    warnings, errors = chirp_common.split_validation_msgs(messages)
    return [*rejected, *(str(error) for error in errors)], [
        str(warning) for warning in warnings
    ]


def _validation_column(message: ValidationMessage) -> str:
    """Map a CHIRP validation or immutable-field message to a grid column."""
    text = str(message or "")
    match = re.search(r"Field ([A-Za-z_]+) is not mutable", text)
    if match:
        return _ERROR_FIELD_COLUMNS.get(match.group(1), "")
    return _infer_csv_error_column(text)


def _issue(row_index: int, column: str, message: ValidationMessage) -> ValidationIssue:
    """One preflight finding: the row, the grid column to mark, and the message."""
    return {"rowIndex": int(row_index), "column": column, "message": str(message)}


def validate_rows_for_upload(
    rows: Rows, module_name: str = "", class_name: str = ""
) -> dict[str, Any]:
    """Validate rows with the selected driver and return errors and warnings."""
    radio = (
        _radio_instance_for_row_validation(module_name, class_name)
        if module_name and class_name
        else None
    )
    level_map = _level_map_for_radio(radio, module_name, class_name)
    # Location is checked here as well as in _apply_rows_to_radio_instance,
    # because that one raises partway through a clone: the radio is already
    # open and some memories written. Preflight is the only place a bad
    # Location can be reported while it is still just a highlighted cell.
    bounds = _memory_bounds_for_driver(module_name, class_name)
    seen_locations: dict[int, int] = {}
    issues: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []
    for row_index, row in enumerate(rows or []):
        vals = [str((row or {}).get(header, "") or "") for header in CSV_HEADERS]
        vals = _coerce_csv_vals_for_chirp(vals)
        # A non-integer Location already raises out of _memory_from_row_values
        # below, so only range and uniqueness are checked here.
        try:
            location = int(str((row or {}).get("Location", "") or "").strip())
        except (TypeError, ValueError):
            location = None
        if location is not None:
            if bounds and not (bounds[0] <= location <= bounds[1]):
                issues.append(
                    _issue(
                        row_index,
                        "Location",
                        f"Channel Location {location} is outside radio "
                        f"memory bounds {bounds[0]}-{bounds[1]}",
                    )
                )
            elif location in seen_locations:
                issues.append(
                    _issue(
                        row_index,
                        "Location",
                        f"Channel Location {location} is already used by "
                        f"row {seen_locations[location] + 1}",
                    )
                )
            else:
                seen_locations[location] = row_index
        try:
            mem = _memory_from_row_values(vals, level_map)
        except Exception as exc:
            error_text = str(exc)
            issues.append(_issue(row_index, _infer_csv_error_column(error_text), error_text))
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
            # Extras ride on the row, not in a column, so they are checked
            # against the memory they will land on rather than through the
            # column machinery above -- including for a row the change
            # classification skipped, which an extras-only edit always is.
            extra_errors, extra_warnings = _row_extra_findings(
                radio, row, existing, action
            )
            for message in extra_errors:
                issues.append(_issue(row_index, EXTRA_COLUMN, message))
            for message in extra_warnings:
                warnings.append(_issue(row_index, EXTRA_COLUMN, message))
            if action == "skip":
                continue
        except Exception as exc:
            row_warnings: list[str] = []
            row_errors: list[ValidationMessage] = [exc]
        for message in row_errors:
            issues.append(_issue(row_index, _validation_column(message), message))
        for message in row_warnings:
            warnings.append(_issue(row_index, _validation_column(message), message))
    return {"valid": len(issues) == 0, "issues": issues, "warnings": warnings}

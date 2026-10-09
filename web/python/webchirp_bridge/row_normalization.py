"""What a value typed into one grid cell becomes, by the selected radio's column rules.

The grid's column metadata (``web/python/webchirp_bridge/column_metadata.py``)
says what each column accepts: a name's length and characters, the memory
bounds, the bands a frequency must fall in, the options of an enumerated
column and whether the column is editable at all. ``normalize_cell`` applies
those rules to one write and reports what was stored, whether that is what
the caller asked for, and a short note when it is not. It is the only
implementation of the rules: the grid sends every edit here through
``normalize_and_validate_rows`` (``web/python/webchirp_bridge/row_validation.py``)
rather than applying the metadata itself.

The rules are written to give exactly what the browser's own copy gave before
it moved here (``normalizeCellValue``, formerly in web/js/ui/channel-values.ts),
which is why the number parsing below follows JavaScript's ``parseInt`` and
``parseFloat`` rather than Python's: a spreadsheet's "5" or "88.50" has to land
on the same option it always did.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any, Optional

    # One column's entry in the grid schema (``_column_metadata_for_radio``).
    ColumnMeta = dict[str, Any]

# JavaScript's parseInt(text, 10): optional leading whitespace, a sign, then
# the longest run of ASCII digits. Anything after it is ignored.
_JS_INT_PREFIX = re.compile(r"\s*([+-]?[0-9]+)")
# JavaScript's parseFloat: the longest prefix that is a decimal literal, with
# an optional exponent, or Infinity.
_JS_FLOAT_PREFIX = re.compile(
    r"\s*([+-]?(?:Infinity|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?))"
)
# The only frequency spelling the grid accepts: MHz digits with an optional
# fraction. No sign, no exponent, no unit.
_FREQ_TEXT = re.compile(r"[0-9]+(\.[0-9]+)?")
# A column whose band check would be wrong: an offset is a shift, not a
# frequency, so 600 kHz is fine on a radio whose lowest band is 2 m.
_BAND_EXEMPT_COLUMNS = frozenset({"Offset"})


@dataclass(frozen=True)
class CellOutcome:
    """What one write stored.

    ``accepted`` is False on every path that kept something other than a value
    derived from the caller's: a read-only column, an unparsable or
    out-of-band frequency, a non-numeric or clamped int, an enum value the
    driver does not offer. A rejected enum write is the reason the flag exists:
    its fallback is a valid-looking option (a tone the radio lacks would read
    as 67.0 Hz), so only the flag tells a caller that writes a value and the
    mode encoding it whether to commit the mode (issue #104). ``note`` says
    what happened in a few words for the cell's tooltip, or is empty when the
    value was stored as typed.
    """

    value: str
    accepted: bool
    note: str = ""

    def as_json(self) -> dict[str, Any]:
        """The outcome as the grid reads it."""
        return {"value": self.value, "accepted": self.accepted, "note": self.note}


def js_string(value: Any) -> str:
    """Spell a JSON value the way JavaScript's ``String()`` does.

    Rows are text, but a JSON number or boolean can still arrive in one, and the
    fallback a rejected write keeps must read exactly as the grid would print
    it: 145 rather than 145.0, true rather than True.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer() and math.isfinite(value):
        return str(int(value))
    return str(value)


def js_parse_int(text: str) -> Optional[int]:
    """JavaScript's ``parseInt(text, 10)``, None where it gives NaN."""
    match = _JS_INT_PREFIX.match(text)
    return int(match.group(1)) if match else None


def js_parse_float(text: str) -> Optional[float]:
    """JavaScript's ``parseFloat(text)``, None where it gives NaN."""
    match = _JS_FLOAT_PREFIX.match(text)
    if not match:
        return None
    literal = match.group(1)
    if literal.lstrip("+-") == "Infinity":
        return -math.inf if literal.startswith("-") else math.inf
    return float(literal)


def parse_freq_to_hz(value: Any) -> Optional[int]:
    """Parse grid frequency text (MHz) to integer Hz, or None.

    Blank is not a frequency and parses to None like any other unparsable
    text; a caller that gives blank its own meaning (an empty Frequency erases
    the memory on upload) tests for it first. Rounds half up, as JavaScript's
    ``Math.round`` does, so a value on a half-hertz boundary lands where it
    always did.
    """
    text = js_string(value).strip()
    if not text or not _FREQ_TEXT.fullmatch(text):
        return None
    number = float(text)
    if not math.isfinite(number):
        return None
    return math.floor(number * 1_000_000 + 0.5)


def in_any_band(hz: int, bands: Any) -> bool:
    """Whether ``hz`` falls in one of the [low, high) ranges; no bands is no constraint."""
    if not isinstance(bands, list) or not bands:
        return True
    return any(float(low) <= hz < float(high) for (low, high) in bands)


def _rejected(fallback: Any, note: str) -> CellOutcome:
    """A write that kept ``fallback`` instead of the caller's value."""
    return CellOutcome(js_string(fallback), False, note)


def _normalize_text(value: str, meta: ColumnMeta) -> CellOutcome:
    """Drop characters the radio cannot display, then cut to its name length.

    Both keep what is left of the caller's value, so both count as accepted;
    the note says which happened.
    """
    notes: list[str] = []
    valid_chars = meta.get("validChars")
    if valid_chars:
        allowed = set(str(valid_chars))
        kept = "".join(ch for ch in value if ch in allowed)
        if kept != value:
            notes.append("removed characters the radio cannot store")
        value = kept
    max_length = meta.get("maxLength")
    if isinstance(max_length, (int, float)) and not isinstance(max_length, bool) and math.isfinite(max_length):
        limit = max(0, int(max_length))
        if len(value) > limit:
            notes.append(f"truncated to {limit} characters")
        value = value[:limit]
    return CellOutcome(value, True, "; ".join(notes).capitalize())


def _finite_number(meta: ColumnMeta, key: str) -> Optional[float]:
    """A metadata bound, or None when the column does not declare one."""
    bound = meta.get(key)
    if isinstance(bound, bool) or not isinstance(bound, (int, float)):
        return None
    return float(bound) if math.isfinite(bound) else None


def _normalize_int(value: str, meta: ColumnMeta, previous: Any) -> CellOutcome:
    """Parse an integer and clamp it into the column's range.

    A clamped value is stored, as it always was, but reported as not accepted:
    memory 300 stored as 127 is not the memory the caller asked for.
    """
    parsed = js_parse_int(value)
    if parsed is None:
        return _rejected(previous, "Not a number; kept the previous value")
    out = parsed
    low = _finite_number(meta, "min")
    high = _finite_number(meta, "max")
    if low is not None:
        out = max(out, int(low))
    if high is not None:
        out = min(out, int(high))
    if out != parsed:
        return CellOutcome(str(out), False, f"Out of range; clamped to {out}")
    return CellOutcome(str(out), True)


def _normalize_freq(column: str, value: str, meta: ColumnMeta, previous: Any) -> CellOutcome:
    """Check a frequency parses and, except for Offset, falls in a band.

    A blank frequency is a value, not a failed edit: the runtime reads an
    empty Frequency as "erase this memory" (``_prepare_row_change`` in
    web/python/webchirp_bridge/row_validation.py), and a blank Offset is no
    offset. Rejecting it snapped the old frequency back into the cell, leaving
    no way to clear a channel from the grid (issue #93). An accepted value is
    stored exactly as typed.
    """
    if value.strip() == "":
        return CellOutcome("", True)
    hz = parse_freq_to_hz(value)
    if hz is None:
        return _rejected(previous, "Not a frequency in MHz; kept the previous value")
    if column not in _BAND_EXEMPT_COLUMNS and not in_any_band(hz, meta.get("bands") or []):
        return _rejected(previous, "Outside the radio's bands; kept the previous value")
    return CellOutcome(value, True)


def _normalize_enum(value: str, meta: ColumnMeta, previous: Any) -> CellOutcome:
    """Match one of the column's options, by text or by numeric value.

    Numeric enums (TStep "5.00", rToneFreq "88.5", DtcsCode "023") may arrive
    from spreadsheets without CHIRP's zero padding ("5", "23"), so they are
    matched by value before giving up. An unmatched value keeps the previous
    one, or the first option when there was none. A column with no options
    constrains nothing.
    """
    options = [js_string(option) for option in (meta.get("options") or [])]
    if not options or value in options:
        return CellOutcome(value, True)
    numeric = js_parse_float(value)
    if numeric is not None and math.isfinite(numeric):
        for option in options:
            if js_parse_float(option) == numeric:
                return CellOutcome(option, True, f"Matched the radio's {option}")
    fallback = previous if previous is not None else options[0]
    return _rejected(fallback, "Not one of the radio's options; kept the previous value")


def normalize_cell(
    column: str,
    value: Any,
    meta: Optional[ColumnMeta],
    previous: Any = None,
    allow_read_only: bool = False,
) -> CellOutcome:
    """Coerce one write to ``column`` by its metadata; see the module docstring.

    ``meta`` is the column's schema entry; a column the schema does not
    describe is unconstrained and stores the text as is. ``previous`` is what
    the cell held, kept when the write is rejected. ``allow_read_only`` lets the
    row builders (paste, repeater imports, band plans) fill a column the grid
    renders read-only -- TStep on a radio with ``has_tuning_step`` False --
    while still checking the value against the column's kind and options.
    """
    text = js_string(value)
    meta = meta or {}
    if meta.get("editable") is False and not allow_read_only:
        return _rejected(previous if previous is not None else text, f"{column} is read-only for this radio")
    kind = meta.get("kind")
    if kind == "text":
        return _normalize_text(text, meta)
    if kind == "int":
        return _normalize_int(text, meta, previous)
    if kind == "freq":
        return _normalize_freq(column, text, meta, previous)
    if kind == "enum":
        return _normalize_enum(text, meta, previous)
    return CellOutcome(text, True)

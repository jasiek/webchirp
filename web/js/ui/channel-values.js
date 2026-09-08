// Pure coercion/validation for channel cell values, driven by the CHIRP column
// metadata the Python runtime reports for the selected radio.

// Parse CHIRP-style frequency text (MHz) to integer Hz for validation checks.
export function parseFreqToHz(value) {
  const text = String(value || "").trim();
  if (!text) {
    return 0;
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.round(n * 1_000_000);
}

// Check whether a frequency in Hz falls within any allowed CHIRP band range.
export function inAnyBand(hz, bands) {
  if (!Array.isArray(bands) || bands.length === 0) {
    return true;
  }
  return bands.some(([lo, hi]) => hz >= Number(lo) && hz < Number(hi));
}

// Coerce and constrain edited cell values according to CHIRP column metadata,
// reporting whether the write was accepted as `{ value, accepted }`.
//
// `accepted` is false on every path that falls back to `previous` (or to the
// column's first option) instead of storing something derived from the caller's
// value: a read-only column, an unparsable or out-of-band frequency, a
// non-numeric or out-of-range int, an enum value the driver's own option list
// does not carry. That last one is why this exists: a rejected enum write is
// invisible in the row, because the fallback is a perfectly valid-looking
// option — a repeater tone the radio's table lacks became 67.0 Hz under an
// already-committed Tone mode, a channel that keys nothing (issue #104).
// Callers that write a value and a mode that encodes it must commit the mode
// only once the value itself was accepted.
//
// Coercions that keep the caller's value are accepted: text trimmed to
// validChars or maxLength, and an enum matched by numeric value.
//
// allowReadOnly lets programmatic row builders (paste, repeater imports) fill
// columns the grid renders read-only (e.g. TStep on radios with
// has_tuning_step=False); kind/options validation still applies.
export function normalizeCellValue(column, value, meta, previous, { allowReadOnly = false } = {}) {
  const rejected = (fallback) => ({ value: String(fallback ?? ""), accepted: false });
  const stored = (out) => ({ value: String(out ?? ""), accepted: true });
  let v = String(value ?? "");
  if (!meta || (meta.editable === false && !allowReadOnly)) {
    return rejected(previous ?? v);
  }

  if (meta.kind === "text") {
    if (meta.validChars) {
      const allowed = new Set(String(meta.validChars).split(""));
      v = v
        .split("")
        .filter((ch) => allowed.has(ch))
        .join("");
    }
    if (Number.isFinite(meta.maxLength)) {
      v = v.slice(0, Number(meta.maxLength));
    }
    return stored(v);
  }

  if (meta.kind === "int") {
    const parsed = Number.parseInt(v, 10);
    if (Number.isNaN(parsed)) {
      return rejected(previous);
    }
    let out = parsed;
    if (Number.isFinite(meta.min)) {
      out = Math.max(out, Number(meta.min));
    }
    if (Number.isFinite(meta.max)) {
      out = Math.min(out, Number(meta.max));
    }
    // A clamped value is kept, as it always was, but reported as not accepted:
    // memory 300 stored as 127 is not the memory the caller asked for.
    return out === parsed ? stored(out) : { value: String(out), accepted: false };
  }

  if (meta.kind === "freq") {
    const hz = parseFreqToHz(v);
    if (hz === null) {
      return rejected(previous);
    }
    const shouldCheckBands = column !== "Offset";
    if (shouldCheckBands && !inAnyBand(hz, meta.bands || [])) {
      return rejected(previous);
    }
    return stored(v);
  }

  if (meta.kind === "enum") {
    const options = Array.isArray(meta.options) ? meta.options.map(String) : [];
    if (options.length > 0 && !options.includes(v)) {
      // Numeric enums (TStep "5.00", rToneFreq "88.5", DtcsCode "023") may
      // arrive from spreadsheets without CHIRP's zero padding ("5", "23");
      // match them by numeric value before giving up.
      const numeric = Number.parseFloat(v);
      const numericMatch = Number.isFinite(numeric)
        ? options.find((option) => Number.parseFloat(option) === numeric)
        : undefined;
      if (numericMatch !== undefined) {
        return stored(numericMatch);
      }
      return rejected(previous ?? options[0]);
    }
    return stored(v);
  }

  return stored(v);
}

// The value-only form, for the many call sites that only store the result.
export function normalizeValue(column, value, meta, previous, options = {}) {
  return normalizeCellValue(column, value, meta, previous, options).value;
}

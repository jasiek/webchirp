// Pure coercion/validation for channel cell values, driven by the CHIRP column
// metadata the Python runtime reports for the selected radio.

/**
 * One channel in the grid: CHIRP CSV header -> cell text. Rows read from a
 * radio or an image may also carry the driver's per-channel extras under the
 * "__extra" sidecar key (web/js/row-extra.js), which no header names.
 * @typedef {Record<string, any>} ChannelRow
 */

/**
 * What the grid knows about one column, as _column_metadata_for_radio
 * (web/python/webchirp_bridge/column_metadata.py) reports it. `kind` decides
 * which of the other fields apply.
 * @typedef {Object} ColumnMeta
 * @property {"text"|"int"|"freq"|"enum"} kind
 * @property {boolean} [editable]  False renders the cell read-only.
 * @property {number} [maxLength]  text: the driver's name length.
 * @property {string} [validChars]  text: every character the driver accepts.
 * @property {number} [min]  int: the lowest memory number.
 * @property {number} [max]  int: the highest; absent for unbounded radios.
 * @property {Array<[number, number]>} [bands]  freq: [low, high) in Hz.
 * @property {string[]} [options]  enum: the driver's values, in its order.
 * @property {string} [default]  enum: CHIRP's starting value, when listed.
 * @property {Record<string, string>} [optionWatts]  Power: option label ->
 *   its wattage, spelled as an exported CSV spells it ("5.0W").
 */

/**
 * The grid's schema for the selected radio (get_radio_column_metadata) or
 * for none (get_default_schema).
 * @typedef {Object} RadioMetadata
 * @property {string[]} headers  The CSV columns this radio has, in order.
 * @property {Record<string, ColumnMeta>} columns
 */

/**
 * What normalizeCellValue did with a write.
 * @typedef {Object} NormalizedCell
 * @property {string} value  What to store.
 * @property {boolean} accepted  False when value is a fallback, not the input.
 */

// Parse CHIRP-style frequency text (MHz) to integer Hz for validation checks.
// Blank is not a frequency, so it parses to null like any other unparsable
// text; callers that give blank its own meaning (an empty Frequency erases the
// memory on upload) must test for it before calling this.
/**
 * @param {unknown} value  Frequency text in MHz.
 * @returns {number|null}  Integer Hz, or null for blank or unparsable text.
 */
export function parseFreqToHz(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
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
/**
 * @param {number} hz
 * @param {ColumnMeta["bands"]} bands  No bands at all means no constraint.
 * @returns {boolean}
 */
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
/**
 * @param {string} column  The CSV header being written.
 * @param {unknown} value  What the caller wants stored.
 * @param {ColumnMeta|null|undefined} meta  The column's metadata.
 * @param {unknown} [previous]  The cell's current value, the fallback.
 * @param {{allowReadOnly?: boolean}} [options]
 * @returns {NormalizedCell}
 */
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
    // A blank frequency is a value, not a failed edit: the runtime reads an
    // empty Frequency as "erase this memory" (_prepare_row_change in
    // web/python/webchirp_bridge/row_validation.py), and a blank Offset is
    // simply no offset. Rejecting it here snapped the old frequency back into
    // the cell, leaving no way to clear a channel from the grid (issue #93).
    if (v.trim() === "") {
      return stored("");
    }
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
/**
 * @param {string} column
 * @param {unknown} value
 * @param {ColumnMeta|null|undefined} meta
 * @param {unknown} [previous]
 * @param {{allowReadOnly?: boolean}} [options]
 * @returns {string}
 */
export function normalizeValue(column, value, meta, previous, options = {}) {
  return normalizeCellValue(column, value, meta, previous, options).value;
}

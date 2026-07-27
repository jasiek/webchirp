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

// Coerce and constrain edited cell values according to CHIRP column metadata.
// allowReadOnly lets programmatic row builders (paste, repeater imports) fill
// columns the grid renders read-only (e.g. TStep on radios with
// has_tuning_step=False); kind/options validation still applies.
export function normalizeValue(column, value, meta, previous, { allowReadOnly = false } = {}) {
  let v = String(value ?? "");
  if (!meta || (meta.editable === false && !allowReadOnly)) {
    return String(previous ?? v);
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
    return v;
  }

  if (meta.kind === "int") {
    const parsed = Number.parseInt(v, 10);
    if (Number.isNaN(parsed)) {
      return String(previous ?? "");
    }
    let out = parsed;
    if (Number.isFinite(meta.min)) {
      out = Math.max(out, Number(meta.min));
    }
    if (Number.isFinite(meta.max)) {
      out = Math.min(out, Number(meta.max));
    }
    return String(out);
  }

  if (meta.kind === "freq") {
    const hz = parseFreqToHz(v);
    if (hz === null) {
      return String(previous ?? "");
    }
    const shouldCheckBands = column !== "Offset";
    if (shouldCheckBands && !inAnyBand(hz, meta.bands || [])) {
      return String(previous ?? "");
    }
    return v;
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
        return numericMatch;
      }
      return String(previous ?? options[0] ?? "");
    }
    return v;
  }

  return v;
}

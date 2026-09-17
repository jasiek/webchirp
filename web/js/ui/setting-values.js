// Pure coercion/validation for radio-wide setting values, driven by the value
// metadata the Python runtime reports for each CHIRP RadioSetting. Kept apart
// from web/js/ui/settings-panel.js so the rules can be exercised without a DOM
// or a loaded image.

// Parse an integer setting's text without letting a prefix parse stand in for
// validation. Number.parseInt stops at the first character it cannot use, so
// "1.5" becomes 1 and "1e2" becomes 1 -- both then pass an isInteger check and
// the range checks run on a number the user never typed, which on a small
// range like Squelch Level 0-9 is another value the radio would accept
// (issue #116). Number() either consumes the whole string or yields NaN, which
// is what makes Number.isInteger a real test of the input. Blank is rejected up
// front because Number("") is 0. The per-channel driver settings reached the
// same conclusion for their own controls -- see readSettingControl in
// web/js/ui/setting-fields.js.
function parseIntegerInput(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) {
    return Number.NaN;
  }
  return Number(text);
}

// Coerce one setting value to its declared type and check it against the
// bounds the driver published. Returns the value to store plus the message to
// show; on a rejected value the caller keeps the raw text visible so the user
// can correct it, except where falling back to the previous value is the only
// sensible result (immutable settings, unsupported enum options).
export function normalizeSettingValue(meta, rawValue, previousValue) {
  const type = String(meta?.type || "");
  if (meta?.mutable === false) {
    return { value: previousValue, error: "" };
  }

  if (type === "boolean") {
    return { value: Boolean(rawValue), error: "" };
  }

  if (type === "enum") {
    const options = Array.isArray(meta?.options) ? meta.options.map(String) : [];
    const candidate = String(rawValue ?? "");
    if (options.length > 0 && !options.includes(candidate)) {
      return { value: previousValue, error: "Select one of the supported values." };
    }
    return { value: candidate, error: "" };
  }

  if (type === "integer") {
    const parsed = parseIntegerInput(rawValue);
    if (!Number.isInteger(parsed)) {
      return { value: rawValue, error: "Enter an integer." };
    }
    if (Number.isFinite(meta.min) && parsed < Number(meta.min)) {
      return { value: parsed, error: `Value must be at least ${meta.min}.` };
    }
    if (Number.isFinite(meta.max) && parsed > Number(meta.max)) {
      return { value: parsed, error: `Value must be at most ${meta.max}.` };
    }
    if (Number.isFinite(meta.step) && Number(meta.step) > 1) {
      const base = Number.isFinite(meta.min) ? Number(meta.min) : 0;
      if ((parsed - base) % Number(meta.step) !== 0) {
        return { value: parsed, error: `Value must increment by ${meta.step}.` };
      }
    }
    return { value: parsed, error: "" };
  }

  if (type === "float") {
    // Number.parseFloat is safe here in a way it is not for integers: the
    // control is an <input type="number">, so its value is either blank or a
    // complete floating-point literal, and every such literal is a valid
    // float setting. The integer branch above has to do more work precisely
    // because "1.5" is a legal number-input value that is not an integer.
    const parsed = Number.parseFloat(String(rawValue ?? "").trim());
    if (!Number.isFinite(parsed)) {
      return { value: rawValue, error: "Enter a number." };
    }
    if (Number.isFinite(meta.min) && parsed < Number(meta.min)) {
      return { value: parsed, error: `Value must be at least ${meta.min}.` };
    }
    if (Number.isFinite(meta.max) && parsed > Number(meta.max)) {
      return { value: parsed, error: `Value must be at most ${meta.max}.` };
    }
    return { value: parsed, error: "" };
  }

  if (type === "string") {
    const text = String(rawValue ?? "");
    if (Number.isFinite(meta.minLength) && text.length < Number(meta.minLength)) {
      return { value: text, error: `Value must be at least ${meta.minLength} characters.` };
    }
    if (Number.isFinite(meta.maxLength) && text.length > Number(meta.maxLength)) {
      return { value: text, error: `Value must be at most ${meta.maxLength} characters.` };
    }
    if (meta.charset) {
      const allowed = new Set(String(meta.charset).split(""));
      const invalidChar = text.split("").find((ch) => !allowed.has(ch));
      if (invalidChar) {
        return { value: text, error: `Character ${JSON.stringify(invalidChar)} is not allowed.` };
      }
    }
    return { value: text, error: "" };
  }

  return { value: rawValue, error: "" };
}

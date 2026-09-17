// Pure coercion/validation for radio-wide setting values, driven by the value
// metadata the Python runtime reports for each CHIRP RadioSetting. Kept apart
// from web/js/ui/settings-panel.js so the rules can be exercised without a DOM
// or a loaded image. denotesInteger is exported because the per-channel extras
// read integers from their own controls (readSettingControl in
// web/js/ui/setting-fields.js) and the rule has to be one rule: it was written
// twice before, and the second copy kept the defect the first had shed.

// A decimal literal, split so the digits can be read without converting: sign,
// the digits before the point, the digits after it, and the exponent. Anything
// else (hex, "Infinity", stray characters) fails to match and is not a number
// the user could have typed into a number input anyway.
const DECIMAL_LITERAL = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

// Does this text denote a whole number exactly? Decided from the digits
// themselves, because every check that runs after a conversion is a check on
// the conversion rather than on the input -- the mistake this function exists
// to avoid, twice over. Number.parseInt stops at the first character it cannot
// use, so "1.5" and "1e2" both become 1, and an isInteger check on that result
// can never reject anything (issue #116). Number() consumes the whole string
// but rounds to the nearest double first, so ".99999999999999999" arrives as a
// genuine 1 and passes the same check. Either way the min/max/step checks then
// run on a number the user never typed, and on a small range like Squelch
// Level 0-9 the wrong value is one the radio accepts, so nothing looks amiss.
//
// Reading the digits sidesteps both. The decimal point starts after the
// leading digits and the exponent moves it; the value is whole when every
// digit left of the point's new position is all that is left, i.e. every digit
// at or beyond it is zero. That keeps "1e2" (100) and "1.50e1" (15) while
// rejecting "1.5" and ".99999999999999999".
export function denotesInteger(text) {
  const match = DECIMAL_LITERAL.exec(text);
  if (!match) {
    return false;
  }
  const [, whole = "", fraction = "", exponent = "0"] = match;
  const digits = whole + fraction;
  if (!digits) {
    return false;
  }
  const pointIndex = whole.length + Number(exponent);
  return digits
    .slice(Math.max(pointIndex, 0))
    .split("")
    .every((digit) => digit === "0");
}

// Read an integer setting's text. Blank is rejected up front because Number("")
// is 0, and the Number.isInteger check still stands behind denotesInteger to
// catch a literal that overflows to Infinity ("1e400"). The per-channel driver
// settings reached the same conclusion for their own controls -- see
// readSettingControl in web/js/ui/setting-fields.js.
function parseIntegerInput(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text || !denotesInteger(text)) {
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

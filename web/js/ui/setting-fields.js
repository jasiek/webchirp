import { denotesInteger } from "./setting-values.js";

// Controls for the driver-described settings the Python runtime reports as
// value metadata -- a type, an option list, bounds, a character set -- built by
// _serialize_setting_value in web/python/webchirp_bridge/radio_settings.py and
// reused verbatim by the per-channel extras
// (web/python/webchirp_bridge/channel_extra.py).
//
// Two editors render exactly those shapes: the per-channel extras modal
// (web/js/ui/channel-extra.js) and the bulk channel editor
// (web/js/ui/channel-bulk-edit.js). Building a control for one field and
// reading it back as the typed value the driver expects is the same work in
// both, so it lives here rather than in either of them.

// Build the control for one field. Structure and constraints only -- validation
// happens on save, through readSettingControl below, so a control here needs no
// change listener of its own.
export function createSettingControl(field, current) {
  const immutable = field.mutable === false;
  if (field.type === "boolean") {
    const control = document.createElement("input");
    control.type = "checkbox";
    control.checked = Boolean(current);
    control.disabled = immutable;
    return control;
  }
  if (field.type === "enum") {
    const control = document.createElement("select");
    for (const option of Array.isArray(field.options) ? field.options : []) {
      const optionEl = document.createElement("option");
      optionEl.value = String(option);
      optionEl.textContent = String(option);
      control.appendChild(optionEl);
    }
    const wanted = String(current ?? "");
    control.value = wanted;
    // A stored value the driver no longer offers (an image edited elsewhere,
    // a row carried over from another radio) is shown rather than silently
    // snapped to some other option, exactly as the grid's enum cells do.
    if (wanted !== "" && control.value !== wanted) {
      const optionEl = document.createElement("option");
      optionEl.value = wanted;
      optionEl.textContent = wanted;
      control.appendChild(optionEl);
      control.value = wanted;
    }
    control.disabled = immutable;
    return control;
  }
  const control = document.createElement("input");
  const numeric = field.type === "integer" || field.type === "float";
  control.type = numeric ? "number" : "text";
  if (numeric) {
    if (Number.isFinite(field.min)) {
      control.min = String(field.min);
    }
    if (Number.isFinite(field.max)) {
      control.max = String(field.max);
    }
    control.step = field.type === "float" ? "any" : String(field.step || 1);
  }
  if (Number.isFinite(field.maxLength)) {
    control.maxLength = Number(field.maxLength);
  }
  control.value = current ?? "";
  control.readOnly = immutable;
  control.disabled = immutable;
  return control;
}

// Read one control back as the typed value the driver expects, or say what is
// wrong with it. Bounds are re-checked here rather than left to the number
// input's min/max, which browsers enforce only on form submission and not at
// all for a value typed then read by script.
//
// rejectUnlistedValue is for a caller that copies the value somewhere else: see
// the enum branch.
export function readSettingControl(field, control, { rejectUnlistedValue = false } = {}) {
  if (field.type === "boolean") {
    return { value: Boolean(control.checked), error: "" };
  }
  if (field.type === "enum") {
    const value = String(control.value ?? "");
    // createSettingControl above offers a stored value the driver no longer
    // lists, so the single-channel editor shows what a channel actually
    // carries; saving it back leaves that channel as it was. A bulk edit is
    // the other case: the value would be copied onto channels that never had
    // it, and the upload preflight would be the first thing to say no. Callers
    // that copy ask for it to be refused here instead.
    const options = Array.isArray(field.options) ? field.options.map(String) : [];
    if (rejectUnlistedValue && options.length > 0 && !options.includes(value)) {
      return { value, error: "The selected radio does not offer this value." };
    }
    return { value, error: "" };
  }
  if (field.type === "integer" || field.type === "float") {
    const text = String(control.value ?? "").trim();
    // Number(), not parseInt(): a number input accepts exponential notation,
    // so 1e1 is a legitimate way to type 10, and parseInt stops at the "e"
    // and returns 1 -- a value in range on any driver whose extra spans it,
    // and therefore saved silently as the wrong setting.
    const parsed = Number(text);
    if (text === "" || !Number.isFinite(parsed)) {
      return { value: null, error: field.type === "integer" ? "Enter a whole number." : "Enter a number." };
    }
    // Whole-ness is decided from the digits rather than from `parsed`, because
    // Number() rounds to the nearest double on the way: the largest double
    // below 1 is about 0.99999999999999989, so ".99999999999999999" arrives as
    // a genuine 1 and an isInteger check on it accepts a fraction as another
    // in-range extra. Number.isInteger(parsed) is not also tested because
    // denotesInteger plus the isFinite gate above already imply it -- every
    // double at or beyond 2^52 is whole, and every whole value below it is
    // exactly representable.
    if (field.type === "integer" && !denotesInteger(text)) {
      return { value: parsed, error: "Enter a whole number." };
    }
    if (Number.isFinite(field.min) && parsed < Number(field.min)) {
      return { value: parsed, error: `Value must be at least ${field.min}.` };
    }
    if (Number.isFinite(field.max) && parsed > Number(field.max)) {
      return { value: parsed, error: `Value must be at most ${field.max}.` };
    }
    return { value: parsed, error: "" };
  }
  const text = String(control.value ?? "");
  if (Number.isFinite(field.maxLength) && text.length > Number(field.maxLength)) {
    return { value: text, error: `Value must be at most ${field.maxLength} characters.` };
  }
  if (field.charset) {
    const allowed = new Set(String(field.charset).split(""));
    const rejected = text.split("").find((character) => !allowed.has(character));
    if (rejected) {
      return { value: text, error: `Character ${JSON.stringify(rejected)} is not allowed.` };
    }
  }
  return { value: text, error: "" };
}

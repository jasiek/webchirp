// Shared control building/reading for a driver's Memory.extra settings
// (field descriptors from get_channel_extra in
// web/python/webchirp_bridge/channel_extra.py). Pulled out of
// web/js/ui/channel-extra.js so the per-channel extras modal and the
// bulk-edit modal (web/js/ui/channel-bulk-edit.js) render and validate the
// same field shapes identically rather than carrying two copies that could
// drift.

// Build the control for one field from the value metadata get_channel_extra
// reports (boolean/enum/integer/float/text, via _serialize_setting_value).
export function createExtraFieldControl(field, current) {
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
export function readExtraFieldControl(field, control) {
  if (field.type === "boolean") {
    return { value: Boolean(control.checked), error: "" };
  }
  if (field.type === "enum") {
    return { value: String(control.value ?? ""), error: "" };
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
    if (field.type === "integer" && !Number.isInteger(parsed)) {
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

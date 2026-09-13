// Controls for the setting fields a driver describes, shared by every editor
// that renders them.
//
// A field here is what web/python/webchirp_bridge/radio_settings.py's
// _serialize_setting_value produces: a type ("boolean", "enum", "integer",
// "float", anything else being text), the value it currently holds, and
// whatever bounds, options or charset the driver attached. Two editors render
// exactly that shape -- the per-channel extras modal
// (web/js/ui/channel-extra.js) and the bulk editor
// (web/js/ui/channel-bulk-edit.js) -- so building and reading a control lives
// here rather than in either of them.
//
// Pure DOM and pure validation: nothing in this module knows about rows,
// selection or the runtime.

// Build the control for one field. `current` is what it opens on, which is not
// always field.current -- a channel's own stored value wins over the one read
// from the memory it occupies.
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
export function readSettingControl(field, control) {
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

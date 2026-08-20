import { decodeMaidenheadBox, encodeMaidenhead } from "../rsgb.js";

// Field components for the shared repeater-query modal. Each factory builds
// its own DOM from a config and returns the same shape:
//
//   { key, nodes, focusTarget, value }
//
// `nodes` are appended to the modal grid in order; `focusTarget` is the
// element the modal focuses when this field is first (null when nothing here
// is focusable); `value()` reads the field's typed value. Behaviour is
// identical for every data source — only labels, options, values and defaults
// come from the config. Nothing here fetches, logs or tracks analytics; that
// belongs to the modal shell and the per-source configs.
//
// Elements get generated ids under this prefix so <label for> association
// works. They are deliberately not in dom.js: the fields exist only between
// one modal open and the next, so nothing outside this file may look them up.
const FIELD_ID_PREFIX = "repeater-query-field-";

function fieldId(key, suffix = "") {
  return `${FIELD_ID_PREFIX}${key}${suffix ? `-${suffix}` : ""}`;
}

function labelledBy(text, controlId) {
  const label = document.createElement("label");
  label.htmlFor = controlId;
  label.textContent = text;
  return label;
}

function plainLabel(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

// Number("") is 0, not NaN, so a blank field would otherwise read as zero —
// for a coordinate, a position on the equator.
function numericFieldValue(el) {
  const text = String(el.value ?? "").trim();
  if (text === "") {
    return Number.NaN;
  }
  return Number(text);
}

// Single-choice dropdown with an empty-valued placeholder option first
// ("Any country"), so the blank choice is always available and always means
// "no filter".
export function createSelectField({ key, label, placeholder, options = [] }) {
  const select = document.createElement("select");
  select.id = fieldId(key);
  select.name = key;
  select.autocomplete = "off";
  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  select.appendChild(placeholderOption);
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.title) {
      opt.title = option.title;
    }
    select.appendChild(opt);
  }
  return {
    key,
    nodes: [labelledBy(label, select.id), select],
    focusTarget: select,
    value: () => String(select.value || ""),
  };
}

// A label/value pair with no control at all, for a fact the source fixes (the
// RSGB directory is UK-only, and a picker with one entry is a control that
// cannot do anything).
export function createFixedField({ key, label, text, value = "" }) {
  const span = document.createElement("span");
  span.className = "modal-fixed-value";
  span.textContent = text;
  return {
    key,
    nodes: [plainLabel(label), span],
    focusTarget: null,
    value: () => value,
  };
}

// Multi-choice checkbox list. `value()` returns the checked values verbatim —
// case normalization is a per-source concern, not a component one. An option
// with `disabled: true` is shown but not selectable (its title says why) and
// can never reach `value()`.
export function createCheckboxGroupField({ key, label, name, options = [], defaults = [] }) {
  const preselected = new Set(defaults);
  const container = document.createElement("div");
  container.className = "modal-modes";
  const checkboxes = [];
  for (const option of options) {
    const optionLabel = document.createElement("label");
    optionLabel.className = "modal-mode-option";
    optionLabel.title = option.title || option.label || option.value;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = option.value;
    checkbox.name = name;
    checkbox.disabled = option.disabled === true;
    checkbox.checked = !checkbox.disabled && preselected.has(option.value);
    const text = document.createElement("span");
    text.textContent = option.label || option.value;
    optionLabel.appendChild(checkbox);
    optionLabel.appendChild(text);
    container.appendChild(optionLabel);
    checkboxes.push(checkbox);
  }
  return {
    key,
    nodes: [plainLabel(label), container],
    focusTarget: checkboxes.find((checkbox) => !checkbox.disabled) || null,
    value: () => checkboxes
      .filter((checkbox) => checkbox.checked && !checkbox.disabled)
      .map((checkbox) => String(checkbox.value || "").trim())
      .filter((value) => value.length > 0),
  };
}

// Single boolean flag ("Only working" / "Only operational").
export function createCheckboxField({ key, label, checked = false }) {
  const checkbox = document.createElement("input");
  checkbox.id = fieldId(key);
  checkbox.name = key;
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  return {
    key,
    nodes: [labelledBy(label, checkbox.id), checkbox],
    focusTarget: checkbox,
    value: () => checkbox.checked === true,
  };
}

// Numeric input; blank reads as NaN, never 0.
export function createNumberField({ key, label, min, max, step, value }) {
  const input = document.createElement("input");
  input.id = fieldId(key);
  input.name = key;
  input.type = "number";
  if (min !== undefined) {
    input.min = String(min);
  }
  if (max !== undefined) {
    input.max = String(max);
  }
  if (step !== undefined) {
    input.step = String(step);
  }
  if (value !== undefined) {
    input.value = String(value);
  }
  return {
    key,
    nodes: [labelledBy(label, input.id), input],
    focusTarget: input,
    value: () => numericFieldValue(input),
  };
}

// Latitude + geolocate button, longitude, and a Maidenhead locator. The
// locator is a two-way alternative way to enter the position, not a filter of
// its own — every source's query consumes only the coordinate pair. Editing
// one side rewrites the other; the rewrites are programmatic value
// assignments, which fire no input events, so the two handlers cannot feed
// back into each other.
//
// `onChange(latitudeText, longitudeText)` fires whenever the coordinate texts
// change (typing, locator edits, setPosition), so the modal shell can persist
// the position across opens — the one part of the form that does survive a
// close.
export function createPositionField({ key = "position", locatorPlaceholder, initial = {}, onChange } = {}) {
  const latitude = document.createElement("input");
  latitude.id = fieldId(key, "latitude");
  latitude.name = "latitude";
  latitude.type = "number";
  latitude.step = "any";
  latitude.value = String(initial.latitudeText ?? "");

  const longitude = document.createElement("input");
  longitude.id = fieldId(key, "longitude");
  longitude.name = "longitude";
  longitude.type = "number";
  longitude.step = "any";
  longitude.value = String(initial.longitudeText ?? "");

  const locator = document.createElement("input");
  locator.id = fieldId(key, "locator");
  locator.name = "locator";
  locator.type = "text";
  locator.maxLength = 8;
  locator.autocomplete = "off";
  locator.autocapitalize = "characters";
  locator.spellcheck = false;
  locator.placeholder = locatorPlaceholder || "e.g. JO91GG";

  const geolocateButton = document.createElement("button");
  geolocateButton.className = "modal-geo-button";
  geolocateButton.type = "button";
  geolocateButton.title = "Use current location";
  geolocateButton.setAttribute("aria-label", "Use current location");
  geolocateButton.textContent = "🛰️";

  const clearButton = document.createElement("button");
  clearButton.className = "modal-geo-button";
  clearButton.type = "button";
  clearButton.title = "Clear location";
  clearButton.setAttribute("aria-label", "Clear location");
  clearButton.textContent = "🗑️";

  // The locator shares its row with the two position actions: fill from the
  // browser's geolocation, and wipe all three fields.
  const geoRow = document.createElement("div");
  geoRow.className = "modal-geo-row";
  geoRow.appendChild(locator);
  geoRow.appendChild(geolocateButton);
  geoRow.appendChild(clearButton);

  function currentPosition() {
    const lat = numericFieldValue(latitude);
    const lon = numericFieldValue(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return null;
    }
    return { latitude: lat, longitude: lon };
  }

  function refreshLocatorFromCoords() {
    const position = currentPosition();
    locator.value = position
      ? encodeMaidenhead(position.latitude, position.longitude, 6)
      : "";
  }

  function notifyChange() {
    if (typeof onChange === "function") {
      onChange(String(latitude.value ?? ""), String(longitude.value ?? ""));
    }
  }

  latitude.addEventListener("input", () => {
    refreshLocatorFromCoords();
    notifyChange();
  });
  longitude.addEventListener("input", () => {
    refreshLocatorFromCoords();
    notifyChange();
  });
  locator.addEventListener("input", () => {
    const box = decodeMaidenheadBox(locator.value);
    if (!box) {
      // Partial or invalid text (no valid 4-character prefix yet): keep the
      // coordinates the user already has instead of wiping them mid-keystroke.
      return;
    }
    latitude.value = box.latitude.toFixed(6);
    longitude.value = box.longitude.toFixed(6);
    notifyChange();
  });
  // Clearing is field-internal: it needs no source-specific behaviour, so the
  // modal shell never sees this button.
  clearButton.addEventListener("click", () => {
    latitude.value = "";
    longitude.value = "";
    locator.value = "";
    notifyChange();
  });

  // Seed the locator from whatever coordinates the field opened with.
  refreshLocatorFromCoords();

  return {
    key,
    nodes: [
      labelledBy("Latitude", latitude.id),
      latitude,
      labelledBy("Longitude", longitude.id),
      longitude,
      labelledBy("Locator", locator.id),
      geoRow,
    ],
    focusTarget: latitude,
    value: () => currentPosition(),
    setPosition: (lat, lon) => {
      latitude.value = Number(lat).toFixed(6);
      longitude.value = Number(lon).toFixed(6);
      refreshLocatorFromCoords();
      notifyChange();
    },
    geolocateButton,
  };
}

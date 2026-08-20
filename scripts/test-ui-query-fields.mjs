import assert from "node:assert/strict";
import test from "node:test";

// The field components build every element themselves via
// document.createElement, so a fake element class is all the DOM they need —
// no index.html, no dom.js, no UI controller boot.
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.type = "";
    this.name = "";
    this.title = "";
    this.id = "";
    this.className = "";
    this.checked = false;
    this.focused = false;
    this._value = "";
    this._textContent = "";
  }

  get value() {
    return this._value;
  }

  set value(next) {
    this._value = String(next ?? "");
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(next) {
    this._textContent = String(next ?? "");
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key).push(handler);
  }

  dispatch(type, event = {}) {
    const handlers = this.listeners.get(String(type)) || [];
    return Promise.all(handlers.map((handler) => handler({ type, preventDefault() {}, ...event })));
  }

  setAttribute(name, val) {
    this.attributes.set(String(name), String(val));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  focus() {
    this.focused = true;
  }
}

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { createElement: (tagName) => new FakeElement(tagName) },
});

const {
  createSelectField,
  createFixedField,
  createCheckboxGroupField,
  createCheckboxField,
  createNumberField,
  createPositionField,
} = await import("../web/js/ui/query-fields.js");

test("select field renders a placeholder-first option list and reads the chosen value", () => {
  const field = createSelectField({
    key: "country",
    label: "Country",
    placeholder: "Any country",
    options: [
      { value: "GB", label: "🇬🇧 United Kingdom", title: "United Kingdom" },
      { value: "PL", label: "🇵🇱 Poland", title: "Poland" },
    ],
  });
  const [label, select] = field.nodes;
  assert.equal(label.tagName, "LABEL");
  assert.equal(label.textContent, "Country");
  assert.equal(label.htmlFor, select.id);
  assert.equal(select.children[0].value, "");
  assert.equal(select.children[0].textContent, "Any country");
  assert.equal(select.children[1].value, "GB");
  assert.equal(select.children[1].title, "United Kingdom");
  assert.equal(field.focusTarget, select);

  assert.equal(field.value(), "");
  select.value = "PL";
  assert.equal(field.value(), "PL");
});

test("fixed field renders the text with no control and returns its configured value", () => {
  const field = createFixedField({ key: "country", label: "Country", text: "🇬🇧 United Kingdom" });
  const [label, span] = field.nodes;
  assert.equal(label.textContent, "Country");
  assert.equal(span.className, "modal-fixed-value");
  assert.equal(span.textContent, "🇬🇧 United Kingdom");
  assert.equal(field.focusTarget, null);
  assert.equal(field.value(), "");
});

test("checkbox group ticks its defaults and reports checked values verbatim", () => {
  const field = createCheckboxGroupField({
    key: "bands",
    label: "Band",
    name: "band",
    options: [
      { value: "70CM", label: "70CM" },
      { value: "2M", label: "2M" },
      { value: "23CM", label: "23CM" },
    ],
    defaults: ["2M", "70CM"],
  });
  const [, container] = field.nodes;
  assert.equal(container.className, "modal-modes");
  const checkboxes = container.children.map((optionLabel) => optionLabel.children[0]);
  assert.deepEqual(checkboxes.map((el) => el.checked), [true, true, false]);
  assert.deepEqual(checkboxes.map((el) => el.name), ["band", "band", "band"]);
  // Values come back in option order, untouched by any case normalization.
  assert.deepEqual(field.value(), ["70CM", "2M"]);

  checkboxes[1].checked = false;
  checkboxes[2].checked = true;
  assert.deepEqual(field.value(), ["70CM", "23CM"]);
  assert.equal(field.focusTarget, checkboxes[0]);
});

test("checkbox group with no defaults starts empty", () => {
  const field = createCheckboxGroupField({
    key: "modes",
    label: "Mode",
    name: "mode",
    options: [{ value: "fm", label: "FM" }],
  });
  assert.deepEqual(field.value(), []);
});

test("boolean checkbox honours its default and toggling", () => {
  const field = createCheckboxField({ key: "only", label: "Only working", checked: true });
  const [label, checkbox] = field.nodes;
  assert.equal(label.htmlFor, checkbox.id);
  assert.equal(checkbox.type, "checkbox");
  assert.equal(field.value(), true);
  checkbox.checked = false;
  assert.equal(field.value(), false);
});

test("number field applies its constraints and reads blank as NaN, never 0", () => {
  const field = createNumberField({ key: "radius", label: "Distance (km)", min: 1, max: 500, step: 1, value: 30 });
  const [, input] = field.nodes;
  assert.equal(input.type, "number");
  assert.equal(input.min, "1");
  assert.equal(input.max, "500");
  assert.equal(input.step, "1");
  assert.equal(field.value(), 30);

  input.value = "";
  assert.ok(Number.isNaN(field.value()));
  input.value = "  ";
  assert.ok(Number.isNaN(field.value()));
  input.value = "12.5";
  assert.equal(field.value(), 12.5);
});

test("number field without min/max leaves the constraints unset", () => {
  const field = createNumberField({ key: "range", label: "Range (km)", min: 1, step: 1, value: 30 });
  const [, input] = field.nodes;
  assert.equal(input.max, undefined);
});

function buildPositionField(config = {}) {
  const changes = [];
  const field = createPositionField({
    locatorPlaceholder: "e.g. JO91GG",
    onChange: (lat, lon) => changes.push([lat, lon]),
    ...config,
  });
  const [, geoRow, , longitude, , locator] = field.nodes;
  const latitude = geoRow.children[0];
  return { field, latitude, longitude, locator, geoRow, changes };
}

test("position field renders the geo row with the geolocate button", () => {
  const { field, latitude, geoRow, locator } = buildPositionField();
  assert.equal(latitude.type, "number");
  assert.equal(latitude.step, "any");
  const button = geoRow.children[1];
  assert.equal(button, field.geolocateButton);
  assert.equal(button.type, "button");
  assert.equal(button.className, "modal-geo-button");
  assert.equal(button.getAttribute("aria-label"), "Use current location");
  assert.equal(locator.placeholder, "e.g. JO91GG");
  assert.equal(locator.maxLength, 8);
  assert.equal(field.focusTarget, latitude);
});

test("coordinate edits fill the locator field once both halves are present", async () => {
  const { latitude, longitude, locator } = buildPositionField();

  latitude.value = "52.2297";
  await latitude.dispatch("input");
  // A lone latitude is not a position; Number("") would otherwise read the
  // blank longitude as 0 and encode a locator on the prime meridian.
  assert.equal(locator.value, "");

  longitude.value = "21.0122";
  await longitude.dispatch("input");
  assert.equal(locator.value, "KO02MF");

  latitude.value = "";
  await latitude.dispatch("input");
  assert.equal(locator.value, "");
});

test("locator edits move the coordinates to the square's centre", async () => {
  const { latitude, longitude, locator } = buildPositionField();

  locator.value = "IO91WM";
  await locator.dispatch("input");
  assert.equal(latitude.value, "51.520833");
  assert.equal(longitude.value, "-0.125000");

  // Lower case and 4-character precision both decode.
  locator.value = "ko02";
  await locator.dispatch("input");
  assert.equal(latitude.value, "52.500000");
  assert.equal(longitude.value, "21.000000");
});

test("partial or invalid locator text leaves the coordinates alone", async () => {
  const { latitude, longitude, locator } = buildPositionField();

  latitude.value = "52.2297";
  longitude.value = "21.0122";
  for (const text of ["", "I", "IO9", "99AB", "ZZ11"]) {
    locator.value = text;
    await locator.dispatch("input");
    assert.equal(latitude.value, "52.2297", `coords survived "${text}"`);
    assert.equal(longitude.value, "21.0122", `coords survived "${text}"`);
  }
});

test("out-of-range coordinates are not a position and encode no locator", async () => {
  const { field, latitude, longitude, locator } = buildPositionField();
  latitude.value = "95";
  longitude.value = "10";
  await latitude.dispatch("input");
  assert.equal(field.value(), null);
  assert.equal(locator.value, "");
});

test("value() returns the validated coordinate pair", async () => {
  const { field, latitude, longitude } = buildPositionField();
  assert.equal(field.value(), null);
  latitude.value = "51.5";
  longitude.value = "-0.12";
  await longitude.dispatch("input");
  assert.deepEqual(field.value(), { latitude: 51.5, longitude: -0.12 });
});

test("initial texts seed the coordinates and the locator", () => {
  const { field, latitude, longitude, locator } = buildPositionField({
    initial: { latitudeText: "51.520833", longitudeText: "-0.125000" },
  });
  assert.equal(latitude.value, "51.520833");
  assert.equal(longitude.value, "-0.125000");
  assert.equal(locator.value, "IO91WM");
  assert.deepEqual(field.value(), { latitude: 51.520833, longitude: -0.125 });
});

test("setPosition fills all three fields and notifies onChange", () => {
  const { field, latitude, longitude, locator, changes } = buildPositionField();
  field.setPosition(51.520833, -0.125);
  assert.equal(latitude.value, "51.520833");
  assert.equal(longitude.value, "-0.125000");
  assert.equal(locator.value, "IO91WM");
  assert.deepEqual(changes, [["51.520833", "-0.125000"]]);
});

test("typing coordinates or a locator notifies onChange with the coordinate texts", async () => {
  const { latitude, longitude, locator, changes } = buildPositionField();
  latitude.value = "52.2297";
  await latitude.dispatch("input");
  longitude.value = "21.0122";
  await longitude.dispatch("input");
  locator.value = "IO91WM";
  await locator.dispatch("input");
  // Partial locator text changes nothing, so it must notify nothing.
  locator.value = "IO9";
  await locator.dispatch("input");
  assert.deepEqual(changes, [
    ["52.2297", ""],
    ["52.2297", "21.0122"],
    ["51.520833", "-0.125000"],
  ]);
});

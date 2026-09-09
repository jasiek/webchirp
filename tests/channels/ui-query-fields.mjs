import assert from "node:assert/strict";
import test from "node:test";

import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL, metresPerPixel } from "../../web/js/staticmap.js";
import { installFakeDom } from "../support/fake-dom.mjs";

// The field components build every element themselves via
// document.createElement, so the shared fake DOM's element class is all they
// need — no index.html, no dom.js, no UI controller boot.
installFakeDom();

const {
  createSelectField,
  createFixedField,
  createCheckboxGroupField,
  createCheckboxField,
  createNumberField,
  createPositionField,
} = await import("../../web/js/ui/query-fields.js");

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

test("disabled checkbox-group options are unselectable and never reach value()", () => {
  const field = createCheckboxGroupField({
    key: "modes",
    label: "Mode",
    name: "mode",
    options: [
      { value: "M", label: "dmr", disabled: true, title: "Only analogue modes and dstar are supported fully" },
      { value: "A", label: "fm" },
    ],
    // A disabled option in the defaults must still not come up ticked.
    defaults: ["A", "M"],
  });
  const [, container] = field.nodes;
  const [disabledOption, enabledOption] = container.children;
  const disabledBox = disabledOption.children[0];
  assert.equal(disabledBox.disabled, true);
  assert.equal(disabledBox.checked, false);
  assert.equal(disabledOption.title, "Only analogue modes and dstar are supported fully");
  assert.deepEqual(field.value(), ["A"]);

  // Even a programmatically forced tick on a disabled box stays out.
  disabledBox.checked = true;
  assert.deepEqual(field.value(), ["A"]);
  // Focus lands on the first *enabled* checkbox.
  assert.equal(field.focusTarget, enabledOption.children[0]);
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
  const [, latitude, , longitude, , geoRow, preview] = field.nodes;
  const locator = geoRow.children[0];
  const [previewCanvas, previewEmpty, previewAttribution] = preview.children;
  return {
    field,
    latitude,
    longitude,
    locator,
    geoRow,
    changes,
    preview,
    previewCanvas,
    previewEmpty,
    previewAttribution,
  };
}

// The field debounces preview redraws so a typist does not fetch a tile set
// per keystroke; tests that want the redraw wait past that window.
const PREVIEW_DEBOUNCE_MS = 300;

function afterPreviewDebounce() {
  return new Promise((resolve) => setTimeout(resolve, PREVIEW_DEBOUNCE_MS + 50));
}

function tilesIn(canvas) {
  return canvas.children.filter((child) => child.className === "repeater-map-tile");
}

test("position field renders the locator row with the geolocate and clear buttons", () => {
  const { field, latitude, geoRow, locator } = buildPositionField();
  assert.equal(latitude.type, "number");
  assert.equal(latitude.step, "any");
  const [, geolocate, clear] = geoRow.children;
  assert.equal(geolocate, field.geolocateButton);
  assert.equal(geolocate.type, "button");
  assert.equal(geolocate.className, "modal-geo-button");
  assert.equal(geolocate.getAttribute("aria-label"), "Use current location");
  assert.equal(clear.type, "button");
  assert.equal(clear.textContent, "🗑️");
  assert.equal(clear.getAttribute("aria-label"), "Clear location");
  assert.equal(locator.placeholder, "e.g. JO91GG");
  assert.equal(locator.maxLength, 8);
  assert.equal(field.focusTarget, latitude);
});

test("the clear button wipes all three fields and notifies onChange", async () => {
  const { field, latitude, longitude, locator, geoRow, changes } = buildPositionField();
  field.setPosition(51.520833, -0.125);
  await geoRow.children[2].dispatch("click");
  assert.equal(latitude.value, "");
  assert.equal(longitude.value, "");
  assert.equal(locator.value, "");
  assert.equal(field.value(), null);
  assert.deepEqual(changes.at(-1), ["", ""]);
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

test("the map preview starts empty and stays empty without a full position", async () => {
  const { previewCanvas, previewEmpty, previewAttribution, latitude, field } = buildPositionField();
  assert.equal(previewCanvas.className, "repeater-map-canvas");
  assert.equal(previewCanvas.hidden, true);
  assert.equal(previewAttribution.hidden, true);
  assert.equal(previewEmpty.hidden, false);
  assert.equal(tilesIn(previewCanvas).length, 0);

  // A lone latitude is not a position, exactly as value() reads it, so there
  // is still nothing to draw.
  latitude.value = "52.2297";
  await latitude.dispatch("input");
  await afterPreviewDebounce();
  assert.equal(field.value(), null);
  assert.equal(previewCanvas.hidden, true);
  assert.equal(tilesIn(previewCanvas).length, 0);
});

test("refreshPreview draws OSM tiles and a marker for the current position", () => {
  const { field, previewCanvas, previewEmpty, previewAttribution } = buildPositionField({
    initial: { latitudeText: "51.520833", longitudeText: "-0.125000" },
  });
  // Construction leaves the preview blank on purpose: the modal is still
  // hidden, so there is no width to measure yet.
  assert.equal(tilesIn(previewCanvas).length, 0);

  field.refreshPreview();
  assert.equal(previewCanvas.hidden, false);
  assert.equal(previewAttribution.hidden, false);
  assert.equal(previewEmpty.hidden, true);
  const tiles = tilesIn(previewCanvas);
  assert.ok(tiles.length >= 1);
  for (const tile of tiles) {
    assert.match(tile.src, /^https:\/\/tile\.openstreetmap\.org\/11\/\d+\/\d+\.png$/);
    assert.equal(tile.crossOrigin, "anonymous");
  }
  // The marker sits last so it paints over the tiles it is centred on.
  assert.equal(previewCanvas.children.at(-1).className, "repeater-map-marker");
});

test("the preview renders at the container's measured width once the modal has laid out", () => {
  const { field, preview, previewCanvas } = buildPositionField({
    initial: { latitudeText: "51.520833", longitudeText: "-0.125000" },
  });
  preview.clientWidth = 360;
  field.refreshPreview();
  // Square: one measurement is both sides, so the range circle has the same
  // room in each direction.
  assert.equal(previewCanvas.style.width, "360px");
  assert.equal(previewCanvas.style.height, "360px");

  // A narrower card redraws to the new width: the canvas's own width is the
  // previous render's, so only the container can report the change.
  preview.clientWidth = 300;
  field.refreshPreview();
  assert.equal(previewCanvas.style.width, "300px");
});

test("typing a position redraws the preview, but only after the debounce", async () => {
  const { latitude, longitude, previewCanvas } = buildPositionField();
  latitude.value = "52.2297";
  await latitude.dispatch("input");
  longitude.value = "21.0122";
  await longitude.dispatch("input");
  // Nothing yet: a redraw per keystroke is a tile fetch per keystroke.
  assert.equal(tilesIn(previewCanvas).length, 0);

  await afterPreviewDebounce();
  assert.ok(tilesIn(previewCanvas).length >= 1);
});

test("a locator edit previews the square it decodes to", async () => {
  const { locator, previewCanvas } = buildPositionField();
  locator.value = "IO91WM";
  await locator.dispatch("input");
  await afterPreviewDebounce();
  assert.ok(tilesIn(previewCanvas).length >= 1);
});

test("clearing the location returns the preview to its empty state", async () => {
  const { field, geoRow, previewCanvas, previewEmpty, previewAttribution } = buildPositionField();
  field.setPosition(51.520833, -0.125);
  field.refreshPreview();
  assert.ok(tilesIn(previewCanvas).length >= 1);

  await geoRow.children[2].dispatch("click");
  await afterPreviewDebounce();
  assert.equal(previewCanvas.hidden, true);
  assert.equal(previewAttribution.hidden, true);
  assert.equal(previewEmpty.hidden, false);
  assert.equal(tilesIn(previewCanvas).length, 0);
});

test("an out-of-range pair previews nothing, matching what value() would refuse", () => {
  const { field, latitude, longitude, previewCanvas } = buildPositionField();
  latitude.value = "95";
  longitude.value = "10";
  field.refreshPreview();
  assert.equal(previewCanvas.hidden, true);
  assert.equal(tilesIn(previewCanvas).length, 0);
});

test("the preview carries the OSM attribution the tile policy requires", () => {
  const { previewAttribution } = buildPositionField();
  assert.equal(previewAttribution.className, "repeater-map-attribution");
  const [link] = previewAttribution.children;
  assert.equal(link.tagName, "A");
  assert.equal(link.href, OSM_COPYRIGHT_URL);
  assert.equal(link.textContent, OSM_ATTRIBUTION);
  assert.equal(link.rel, "noopener noreferrer");
});

function rangeRingIn(canvas) {
  return canvas.children.find((child) => child.className === "repeater-map-range") || null;
}

test("without a range the preview draws no circle", () => {
  const { field, previewCanvas } = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
  });
  field.refreshPreview();
  assert.equal(rangeRingIn(previewCanvas), null);
});

test("the range circle fits the square with map left visible around it", () => {
  const { field, preview, previewCanvas } = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
  });
  preview.clientWidth = 320;
  field.setRangeKm(30);
  field.refreshPreview();

  const ring = rangeRingIn(previewCanvas);
  assert.ok(ring, "the range circle is drawn");
  // 90% of the square: the whole 30 km radius is on screen, with a margin that
  // shows it as a radius rather than as the edge of the widget.
  const diameter = Number.parseFloat(ring.style.width);
  assert.equal(ring.style.height, ring.style.width);
  assert.ok(Math.abs(diameter - 320 * 0.9) < 0.5, `diameter ${diameter}`);
  assert.ok(diameter < 320);

  // The marker paints over the ring, so it has to come after it.
  assert.equal(previewCanvas.children.at(-1).className, "repeater-map-marker");
});

test("a wider range zooms the preview out instead of overflowing the square", async () => {
  const { field, preview, previewCanvas } = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
  });
  preview.clientWidth = 320;
  field.setRangeKm(30);
  field.refreshPreview();
  const tightZoom = Number(previewCanvas.children[0].src.split("/")[3]);
  const tightDiameter = Number.parseFloat(rangeRingIn(previewCanvas).style.width);

  field.setRangeKm(200);
  await afterPreviewDebounce();
  const wideZoom = Number(previewCanvas.children[0].src.split("/")[3]);
  const wideDiameter = Number.parseFloat(rangeRingIn(previewCanvas).style.width);

  // Six times the radius, but the circle stays the same size on screen: the
  // map zoomed out under it.
  assert.ok(wideZoom <= tightZoom);
  assert.ok(Math.abs(wideDiameter - tightDiameter) < 0.5);
});

test("setRangeKm redraws only when the range actually changes", async () => {
  const { field, previewCanvas } = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
  });
  field.setRangeKm(30);
  field.refreshPreview();
  const first = previewCanvas.children[0];

  // The shell re-applies the range on every build; an unchanged value must not
  // cost a second tile fetch.
  field.setRangeKm(30);
  await afterPreviewDebounce();
  assert.equal(previewCanvas.children[0], first);

  field.setRangeKm(60);
  await afterPreviewDebounce();
  assert.notEqual(previewCanvas.children[0], first);
});

test("a blank range field previews the position with no circle at the fallback zoom", () => {
  const { field, preview, previewCanvas } = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
  });
  preview.clientWidth = 320;
  // numericFieldValue reads a cleared "Range (km)" box as NaN, which is not a
  // radius to frame.
  field.setRangeKm(Number.NaN);
  field.refreshPreview();
  assert.equal(rangeRingIn(previewCanvas), null);
  assert.equal(Number(previewCanvas.children[0].src.split("/")[3]), 11);
});

test("tiles are drawn at the scaled size a fractional zoom needs", () => {
  const { field, preview, previewCanvas } = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
  });
  preview.clientWidth = 320;
  field.setRangeKm(30);
  field.refreshPreview();

  const tiles = tilesIn(previewCanvas);
  assert.ok(tiles.length >= 1);
  const tileSize = Number.parseFloat(tiles[0].style.width);
  // Tiles exist only at whole zooms, so the grid is planned one zoom in and
  // drawn shrunk to the fraction: never bigger than a tile, never below half.
  assert.ok(tileSize > 128 && tileSize <= 256, `tile size ${tileSize}`);
  for (const tile of tiles) {
    assert.equal(tile.style.height, tile.style.width);
  }
  // The scaled grid still resolves to the ground resolution asked for.
  const zoom = Number(tiles[0].src.split("/")[3]);
  const scale = tileSize / 256;
  assert.ok(Math.abs(metresPerPixel(52, zoom) / scale - (2 * 30000) / (320 * 0.9)) < 1e-6);
});

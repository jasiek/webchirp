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
  createCityField,
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
  const pans = [];
  const field = createPositionField({
    locatorPlaceholder: "e.g. JO91GG",
    onChange: (lat, lon) => changes.push([lat, lon]),
    onPan: () => pans.push(true),
    ...config,
  });
  const [, coordRow, , geoRow] = field.nodes;
  const [preview] = field.tailNodes;
  const [latitude, longitude] = coordRow.children;
  const locator = geoRow.children[0];
  const [previewCanvas, previewEmpty, previewCount, previewAttribution] = preview.children;
  return {
    field,
    coordRow,
    latitude,
    longitude,
    locator,
    geoRow,
    changes,
    preview,
    previewCanvas,
    previewEmpty,
    previewCount,
    previewAttribution,
    pans,
  };
}

// A field whose preview has been rendered once, which is the state a drag
// needs: a position on screen and a zoom the pointer arithmetic can use.
function buildDraggableField(config = {}) {
  const built = buildPositionField({
    initial: { latitudeText: "52.000000", longitudeText: "-2.000000" },
    ...config,
  });
  built.preview.clientWidth = 320;
  built.field.setRangeKm(30);
  built.field.refreshPreview();
  return built;
}

function dragMap(previewCanvas, moves, { pointerId = 1 } = {}) {
  return (async () => {
    await previewCanvas.dispatch("pointerdown", { pointerId, button: 0, clientX: 100, clientY: 100 });
    for (const [x, y] of moves) {
      await previewCanvas.dispatch("pointermove", { pointerId, clientX: x, clientY: y });
    }
    await previewCanvas.dispatch("pointerup", { pointerId });
  })();
}

function tileTransforms(canvas) {
  return tilesIn(canvas).map((tile) => tile.style.transform || "");
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

test("latitude and longitude share one labelled row and name themselves", () => {
  const { field, coordRow, latitude, longitude } = buildPositionField();
  const [coordLabel] = field.nodes;
  assert.equal(coordLabel.tagName, "LABEL");
  assert.equal(coordLabel.textContent, "Coordinates");
  assert.equal(coordLabel.htmlFor, latitude.id);
  // One row holding both boxes and nothing else: the row is what keeps the
  // pair on a single grid line under the single label above.
  assert.equal(coordRow.className, "modal-coord-row");
  assert.deepEqual(coordRow.children, [latitude, longitude]);
  // With no per-box label left, the placeholder is the only thing that says
  // which half is which, so it has to carry the word and not just an example.
  assert.match(latitude.placeholder, /^Latitude /);
  assert.match(longitude.placeholder, /^Longitude /);
  assert.equal(latitude.getAttribute("aria-label"), "Latitude");
  assert.equal(longitude.getAttribute("aria-label"), "Longitude");
  // The examples have to be a position the field would accept, or the hint
  // teaches a format value() refuses.
  const latitudeExample = Number(latitude.placeholder.replace("Latitude ", ""));
  const longitudeExample = Number(longitude.placeholder.replace("Longitude ", ""));
  assert.ok(Number.isFinite(latitudeExample) && Math.abs(latitudeExample) <= 90);
  assert.ok(Number.isFinite(longitudeExample) && Math.abs(longitudeExample) <= 180);
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
  assert.equal(previewEmpty.hidden, false);
  // The stand-in and the attribution hold the block's size while there is no
  // map, so entering a position does not resize the modal.
  assert.equal(previewAttribution.hidden, false);
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
  assert.equal(previewEmpty.hidden, true);
  assert.equal(previewAttribution.hidden, false);
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
  assert.equal(previewEmpty.hidden, false);
  assert.equal(previewAttribution.hidden, false, "clearing must not shrink the block either");
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

test("the block keeps one size whether or not a position is set", async () => {
  const { field, previewCanvas, previewEmpty, previewAttribution, latitude, longitude } = buildPositionField();
  // Exactly one of the two squares is shown at any time, and the credit under
  // them never leaves the flow — so the block's height is the same in both
  // states without anything having to measure it.
  const shown = () => [previewCanvas, previewEmpty, previewAttribution].filter((el) => !el.hidden);
  assert.deepEqual(shown(), [previewEmpty, previewAttribution]);

  latitude.value = "52";
  longitude.value = "-2";
  await longitude.dispatch("input");
  field.refreshPreview();
  assert.deepEqual(shown(), [previewCanvas, previewAttribution]);
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

test("dragging the map moves the position under the marker", async () => {
  const { field, previewCanvas, latitude, longitude, locator } = buildDraggableField();
  const before = field.value();

  // Pull the map east; the point under the fixed centre marker moves west.
  await dragMap(previewCanvas, [[160, 100]]);

  const after = field.value();
  assert.ok(after.longitude < before.longitude, `${after.longitude} < ${before.longitude}`);
  assert.ok(Math.abs(after.latitude - before.latitude) < 1e-9, "a horizontal drag does not move north");
  // The drag is an input like any other: the three fields agree afterwards.
  assert.equal(Number(latitude.value), after.latitude);
  assert.equal(Number(longitude.value), after.longitude);
  assert.equal(locator.value.length, 6);
});

test("a vertical drag moves the position north or south", async () => {
  const { field, previewCanvas } = buildDraggableField();
  const before = field.value();
  // Pull the map down; the point under the marker moves north.
  await dragMap(previewCanvas, [[100, 160]]);
  const after = field.value();
  assert.ok(after.latitude > before.latitude, `${after.latitude} > ${before.latitude}`);
});

test("a press that barely moves is a click, not a drag", async () => {
  const { field, previewCanvas, pans, changes } = buildDraggableField();
  const before = field.value();
  const firstTile = previewCanvas.children[0];

  await dragMap(previewCanvas, [[101, 102]]);

  assert.deepEqual(field.value(), before, "a shaky press leaves the position alone");
  assert.deepEqual(changes, [], "and reports no change");
  assert.deepEqual(pans, [], "and is not counted as a map drag");
  assert.equal(previewCanvas.children[0], firstTile, "and costs no redraw");
});

test("the drag translates the tiles it has and redraws once, on release", async () => {
  const { previewCanvas } = buildDraggableField();
  const firstTile = previewCanvas.children[0];

  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  for (const x of [120, 140, 160]) {
    await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: x, clientY: 100 });
  }
  // Still the same tiles, shifted: a redraw per pointermove would refetch the
  // whole grid dozens of times across one gesture.
  assert.equal(previewCanvas.children[0], firstTile);
  assert.deepEqual(tileTransforms(previewCanvas), tilesIn(previewCanvas).map(() => "translate(60px, 0px)"));
  // The marker and the range ring mark the position being chosen, so they stay
  // at the centre while the map slides under them.
  assert.equal(previewCanvas.children.at(-1).style.transform, undefined);

  await previewCanvas.dispatch("pointerup", { pointerId: 1 });
  assert.notEqual(previewCanvas.children[0], firstTile, "release redraws around the new centre");
  assert.deepEqual(tileTransforms(previewCanvas), tilesIn(previewCanvas).map(() => ""));
});

test("a drag past the drawn map rebases and keeps tracking the pointer", async () => {
  const { field, previewCanvas } = buildDraggableField();
  const before = field.value();
  const firstTile = previewCanvas.children[0];

  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  // Past the overscan: the map has run out of drawn tiles, so it redraws
  // around where it now is mid-gesture rather than showing blank canvas.
  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 260, clientY: 100 });
  assert.notEqual(previewCanvas.children[0], firstTile, "rebased mid-drag");
  assert.deepEqual(tileTransforms(previewCanvas), tilesIn(previewCanvas).map(() => ""));
  const rebased = field.value();

  // The same gesture carries on from the rebased origin.
  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 300, clientY: 100 });
  assert.ok(field.value().longitude < rebased.longitude, "kept moving west");
  await previewCanvas.dispatch("pointerup", { pointerId: 1 });
  assert.ok(field.value().longitude < before.longitude);
});

test("onPan reports the drag once, without the coordinates it produced", async () => {
  const { previewCanvas, pans } = buildDraggableField();
  await dragMap(previewCanvas, [[130, 100], [150, 100], [170, 100]]);
  assert.deepEqual(pans, [true], "one drag, one report");
  await dragMap(previewCanvas, [[140, 120]]);
  assert.equal(pans.length, 2);
});

test("a cancelled drag still settles the map on where it was left", async () => {
  const { field, previewCanvas, pans } = buildDraggableField();
  const before = field.value();
  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 150, clientY: 100 });
  await previewCanvas.dispatch("pointercancel", { pointerId: 1 });
  assert.ok(field.value().longitude < before.longitude);
  assert.deepEqual(tileTransforms(previewCanvas), tilesIn(previewCanvas).map(() => ""));
  assert.deepEqual(pans, [true]);
  assert.equal(previewCanvas.classList.contains("is-panning"), false);
});

test("moves from another pointer, and drags with no position or no render, are ignored", async () => {
  const { field, previewCanvas } = buildDraggableField();
  const before = field.value();
  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  // A second finger landing on the map must not steer the first one's drag.
  await previewCanvas.dispatch("pointermove", { pointerId: 2, clientX: 300, clientY: 300 });
  assert.deepEqual(field.value(), before);
  await previewCanvas.dispatch("pointerup", { pointerId: 1 });

  // Nothing drawn, nothing to drag: an empty preview has no zoom to compute in.
  const empty = buildPositionField();
  await dragMap(empty.previewCanvas, [[200, 200]]);
  assert.equal(empty.field.value(), null);
  assert.deepEqual(empty.pans, []);
});

test("the drag ignores secondary buttons", async () => {
  const { field, previewCanvas } = buildDraggableField();
  const before = field.value();
  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 2, clientX: 100, clientY: 100 });
  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 200, clientY: 100 });
  assert.deepEqual(field.value(), before);
});

test("the drawn map extends past the viewport so a drag has somewhere to go", () => {
  const { previewCanvas } = buildDraggableField();
  const lefts = tilesIn(previewCanvas).map((tile) => Number.parseFloat(tile.style.left));
  const tops = tilesIn(previewCanvas).map((tile) => Number.parseFloat(tile.style.top));
  // Overscan: the grid starts left of and above the viewport's own origin, and
  // the canvas's overflow is what hides it until a drag pulls it into view.
  assert.ok(Math.min(...lefts) <= -128, `leftmost tile at ${Math.min(...lefts)}`);
  assert.ok(Math.min(...tops) <= -128, `topmost tile at ${Math.min(...tops)}`);
});

test("a redraw queued just before a drag is settled by it, not fired under it", async () => {
  const { field, previewCanvas, longitude } = buildDraggableField();

  // A keystroke inside the debounce window, then a drag started before its
  // redraw has fired.
  longitude.value = "-2.5";
  await longitude.dispatch("input");
  const queued = previewCanvas.children[0];

  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  // Settled at pointerdown: the tiles now show where the drag is starting
  // from, rather than the position two keystrokes ago.
  const atStart = previewCanvas.children[0];
  assert.notEqual(atStart, queued, "the pending redraw ran at pointerdown");

  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 150, clientY: 100 });
  // Past the debounce, still dragging: nothing may recentre the grid under the
  // pointer, or the next move applies the whole accumulated delta to a map
  // that has already moved.
  await afterPreviewDebounce();
  assert.equal(previewCanvas.children[0], atStart, "no redraw fired mid-drag");
  assert.deepEqual(tileTransforms(previewCanvas), tilesIn(previewCanvas).map(() => "translate(50px, 0px)"));

  await previewCanvas.dispatch("pointerup", { pointerId: 1 });
  assert.notEqual(previewCanvas.children[0], atStart, "release redraws once");
});

test("a queued redraw is not lost to a press that turns out not to be a drag", async () => {
  const { field, previewCanvas, longitude } = buildDraggableField();
  const stale = previewCanvas.children[0];
  longitude.value = "-2.5";
  await longitude.dispatch("input");

  // Press and release without moving. endDrag has nothing to redraw for, so
  // if the pointerdown had merely cancelled the queued redraw the map would
  // still be showing the position before the keystroke, for good.
  await dragMap(previewCanvas, [[101, 101]]);
  await afterPreviewDebounce();

  assert.notEqual(previewCanvas.children[0], stale, "the typed position reached the map");
  assert.equal(field.value().longitude, -2.5);
});

// --- City/Locality autocomplete ---------------------------------------------

// The lookup fires on the keystroke, so typing only has to outrun the stub's
// own promise rather than a timer. A macrotask is enough for that and keeps the
// tests honest about the ordering: anything the field defers past this would
// show up as a failure rather than be papered over by a generous sleep.
function afterCityLookup() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const MANCHESTER = {
  id: "2643123",
  name: "Manchester",
  region: "England",
  country: "United Kingdom",
  countryCode: "GB",
  latitude: 53.48095,
  longitude: -2.23743,
};
const LONDON = {
  id: "2643743",
  name: "London",
  region: "England",
  country: "United Kingdom",
  countryCode: "GB",
  latitude: 51.50853,
  longitude: -0.12573,
};
const MANCHESTER_NH = {
  id: "5089178",
  name: "Manchester",
  region: "New Hampshire",
  country: "United States",
  countryCode: "US",
  latitude: 42.99564,
  longitude: -71.45479,
};

// Builds the field over a stub lookup and records every call it makes, so the
// tests can assert both what reached the endpoint and what came back.
function buildCityField({ results = [MANCHESTER, MANCHESTER_NH], fail = null } = {}) {
  const calls = [];
  const selections = [];
  const field = createCityField({
    search: async (query) => {
      calls.push({ query });
      if (fail) {
        throw fail;
      }
      return results;
    },
    onSelect: (city) => selections.push(city),
  });
  const [, wrapper] = field.nodes;
  const [input, list, note] = wrapper.children;
  return { field, input, list, note, calls, selections };
}

async function typeCity(input, text) {
  input.value = text;
  await input.dispatch("input");
  await afterCityLookup();
}

test("city field labels a text input and hides its suggestion list until it has one", () => {
  const { field, input, list } = buildCityField();
  const [label, wrapper] = field.nodes;
  assert.equal(label.tagName, "LABEL");
  assert.equal(label.textContent, "City/Locality");
  assert.equal(label.htmlFor, input.id);
  assert.equal(wrapper.className, "modal-city-field");
  assert.equal(input.type, "text");
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(list.hidden, true);
  assert.equal(field.focusTarget, input);
  assert.equal(field.value(), null);
});

test("typing queries the lookup once and lists what it returns", async () => {
  const { input, list, calls } = buildCityField();
  await typeCity(input, "manch");

  assert.deepEqual(calls, [{ query: "manch" }]);
  assert.equal(list.hidden, false);
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].children[0].textContent, "Manchester");
  assert.equal(list.children[0].children[1].textContent, "England, United Kingdom");
  assert.equal(list.children[1].children[1].textContent, "New Hampshire, United States");
});

test("the top suggestion is highlighted as soon as the list opens", async () => {
  const { input, list } = buildCityField();
  await typeCity(input, "manch");
  assert.equal(list.children[0].classList.contains("is-active"), true);
  assert.equal(list.children[1].classList.contains("is-active"), false);
  assert.equal(input.getAttribute("aria-activedescendant"), list.children[0].id);
});

test("the lookup is the typed text and nothing else", async () => {
  // The endpoint accepts a lat/lon ranking hint and the field deliberately
  // sends none: a position in a query string on every keystroke is not yet
  // worth the ordering it buys.
  const { input, calls } = buildCityField();
  await typeCity(input, "manch");
  assert.deepEqual(calls, [{ query: "manch" }]);
});

test("Enter commits the highlighted suggestion and never submits the form", async () => {
  const { field, input, list, selections } = buildCityField();
  await typeCity(input, "manch");

  let defaultPrevented = false;
  await input.dispatch("keydown", { key: "Enter", preventDefault() { defaultPrevented = true; } });

  assert.equal(defaultPrevented, true, "the modal's form must not submit on this Enter");
  assert.deepEqual(selections, [MANCHESTER]);
  assert.equal(field.value(), MANCHESTER);
  assert.equal(input.value, "Manchester, England, United Kingdom");
  assert.equal(list.hidden, true);
});

test("the arrow keys move the highlight and wrap around the list", async () => {
  const { input, list, selections } = buildCityField();
  await typeCity(input, "manch");

  await input.dispatch("keydown", { key: "ArrowDown", preventDefault() {} });
  assert.equal(list.children[1].classList.contains("is-active"), true);
  // Past the end and back to the top, so a long list is never a dead end.
  await input.dispatch("keydown", { key: "ArrowDown", preventDefault() {} });
  assert.equal(list.children[0].classList.contains("is-active"), true);
  await input.dispatch("keydown", { key: "ArrowUp", preventDefault() {} });
  assert.equal(list.children[1].classList.contains("is-active"), true);

  await input.dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(selections, [MANCHESTER_NH]);
});

test("moving focus away commits the top suggestion", async () => {
  const { input, list, selections } = buildCityField();
  await typeCity(input, "manch");
  await input.dispatch("blur");

  assert.deepEqual(selections, [MANCHESTER]);
  assert.equal(input.value, "Manchester, England, United Kingdom");
  assert.equal(list.hidden, true);
});

test("pointing at a suggestion and pressing commits that one, not the top one", async () => {
  const { input, list, selections } = buildCityField();
  await typeCity(input, "manch");

  let defaultPrevented = false;
  await list.children[1].dispatch("pointerdown", {
    preventDefault() { defaultPrevented = true; },
  });

  // Suppressing the default is what keeps focus in the box, so the blur that
  // would otherwise fire first cannot commit the wrong entry.
  assert.equal(defaultPrevented, true);
  assert.deepEqual(selections, [MANCHESTER_NH]);
});

test("Escape closes the list without committing and without reaching the modal", async () => {
  const { field, input, list, selections } = buildCityField();
  await typeCity(input, "manch");

  let propagationStopped = false;
  await input.dispatch("keydown", {
    key: "Escape",
    preventDefault() {},
    stopPropagation() { propagationStopped = true; },
  });

  assert.equal(propagationStopped, true, "Escape here must not close the whole modal");
  assert.equal(list.hidden, true);
  assert.equal(field.value(), null);
  assert.deepEqual(selections, []);
});

test("clearing the box closes the list and asks for nothing", async () => {
  const { input, list, note, calls } = buildCityField();
  await typeCity(input, "manch");
  await typeCity(input, "");

  assert.equal(calls.length, 1, "an empty box is not a query");
  assert.equal(list.hidden, true);
  assert.equal(note.hidden, true);
});

test("a lookup that finds nothing says so instead of leaving a stale list", async () => {
  const { input, list, note } = buildCityField({ results: [] });
  await typeCity(input, "zzzz");
  assert.equal(list.hidden, true);
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "No matching places.");
});

test("a failed lookup is reported in the field, not thrown at the modal", async () => {
  const { input, list, note } = buildCityField({ fail: new Error("HTTP 503") });
  await typeCity(input, "manch");
  assert.equal(list.hidden, true);
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /City lookup unavailable: HTTP 503/);
});

test("a slow lookup superseded by a later keystroke never reaches the list", async () => {
  const pending = [];
  const field = createCityField({
    search: (query) => new Promise((resolve) => pending.push({ query, resolve })),
    onSelect: () => {},
  });
  const [, wrapper] = field.nodes;
  const [input, list] = wrapper.children;

  await typeCity(input, "man");
  await typeCity(input, "manchester");
  assert.equal(pending.length, 2);

  // The first request answers last, as a slow one can. Its results describe a
  // prefix the box no longer holds and must be dropped.
  pending[1].resolve([MANCHESTER]);
  pending[0].resolve([MANCHESTER_NH]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[1].textContent, "England, United Kingdom");
});

test("a query already answered is replayed without waiting or asking again", async () => {
  const { input, list, calls } = buildCityField();
  await typeCity(input, "man");
  await typeCity(input, "manc");
  assert.equal(calls.length, 2);

  // Backspacing lands on a query the field already has an answer for, so it
  // renders from memory with no request and nothing to await.
  input.value = "man";
  await input.dispatch("input");
  assert.equal(list.hidden, false, "the cached list is on screen synchronously");
  assert.equal(list.children.length, 2);
  assert.equal(calls.length, 2, "a cache hit asks the endpoint nothing");
});

test("a failed lookup is not cached, so the next keystroke retries", async () => {
  let failure = new Error("HTTP 503");
  const calls = [];
  const field = createCityField({
    search: async (query) => {
      calls.push(query);
      if (failure) {
        throw failure;
      }
      return [MANCHESTER];
    },
    onSelect: () => {},
  });
  const [, wrapper] = field.nodes;
  const [input, list] = wrapper.children;

  await typeCity(input, "manch");
  assert.equal(list.hidden, true);

  // Same text again, now that the endpoint is back. A cached failure would
  // replay the outage for the rest of the modal session instead of retrying.
  failure = null;
  await typeCity(input, "manch");

  assert.deepEqual(calls, ["manch", "manch"]);
  assert.equal(list.hidden, false);
});

// --- Repeaters plotted on the preview ----------------------------------------

function pinsIn(canvas) {
  return canvas.children.filter((child) => String(child.className).startsWith("repeater-map-pin"));
}

// buildDraggableField centres on 52.0, -2.0 at a 30 km radius, so these are
// placed by hand relative to that: a degree of latitude is ~111 km. The ring
// fills 0.9 of the map's width (PREVIEW_RANGE_FILL), so the viewport reaches
// 30/0.9 = 33.3 km north and south -- which leaves only 30-33.3 km for a
// marker that is outside the ring and still on the map.
const NEAR = { latitude: 52.05, longitude: -2.0, inRange: true };
const ALSO_NEAR = { latitude: 51.96, longitude: -2.04, inRange: true };
const BEYOND_RING = { latitude: 52.28, longitude: -2.0, inRange: false };
const OFF_MAP = { latitude: 55.0, longitude: -2.0, inRange: false };

test("setMarkers draws one square per repeater and captions the map", () => {
  const { field, previewCanvas, previewCount } = buildDraggableField();
  field.setMarkers([NEAR, ALSO_NEAR, BEYOND_RING]);

  assert.equal(pinsIn(previewCanvas).length, 3);
  assert.equal(previewCount.hidden, false);
  assert.equal(previewCount.textContent, "2 in range, 1 just outside");
});

test("a repeater outside the ring is dimmed rather than dropped", () => {
  const { field, previewCanvas } = buildDraggableField();
  field.setMarkers([NEAR, BEYOND_RING]);

  const dimmed = pinsIn(previewCanvas).filter((pin) => pin.classList.contains("is-out-of-range"));
  assert.equal(dimmed.length, 1, "the one the radius excludes shows what widening would add");
});

test("a position that is really a locator box is marked as approximate", () => {
  const { field, previewCanvas } = buildDraggableField();
  field.setMarkers([{ ...NEAR, approximate: true }, ALSO_NEAR]);

  const approximate = pinsIn(previewCanvas).filter((pin) => pin.classList.contains("is-approximate"));
  assert.equal(approximate.length, 1);
});

test("the caption counts the squares on the map, not the ones handed in", () => {
  const { field, previewCanvas, previewCount } = buildDraggableField();
  // OFF_MAP is inside a wide search but far outside the viewport the ring is
  // framed to. Counting it would promise a square the map has no room for.
  field.setMarkers([NEAR, OFF_MAP]);

  assert.equal(pinsIn(previewCanvas).length, 1);
  assert.equal(previewCount.textContent, "1 in range");
});

test("a preview in flight keeps the squares already drawn and says so", () => {
  const { field, previewCanvas, previewCount } = buildDraggableField();
  field.setMarkers([NEAR, ALSO_NEAR]);
  field.setMarkers(null, "loading");

  // Blanking the map on every edit would flicker it through each keystroke of
  // a radius, so only the caption changes.
  assert.equal(pinsIn(previewCanvas).length, 2);
  assert.equal(previewCount.classList.contains("is-loading"), true);
  assert.equal(previewCount.textContent, "2 in range");
});

test("a preview that could not run says so without clearing the map", () => {
  const { field, previewCanvas, previewCount } = buildDraggableField();
  field.setMarkers([NEAR]);
  field.setMarkers(null, "failed");

  assert.equal(pinsIn(previewCanvas).length, 1);
  assert.equal(previewCount.hidden, false);
  assert.equal(previewCount.textContent, "Could not preview this search.");
});

test("clearing the location takes the squares and the caption with it", async () => {
  const { field, previewCanvas, previewCount, geoRow } = buildDraggableField();
  field.setMarkers([NEAR, ALSO_NEAR]);

  await geoRow.children[2].dispatch("click");
  await afterPreviewDebounce();

  assert.equal(pinsIn(previewCanvas).length, 0);
  assert.equal(previewCount.hidden, true);
});

// --- City field: review follow-ups -------------------------------------------

test("a failed lookup reaches the shell whole, not just as a one-line note", async () => {
  const failure = new Error("City lookup timed out after 4 s");
  const reported = [];
  const field = createCityField({
    search: async () => { throw failure; },
    onError: (error) => reported.push(error),
    onSelect: () => {},
  });
  const [, wrapper] = field.nodes;
  const [input, , note] = wrapper.children;
  await typeCity(input, "manch");

  // The note is for the user; the debug panel needs the error itself, stack
  // and all, or a service failure cannot be investigated.
  assert.deepEqual(reported, [failure]);
  assert.match(note.textContent, /City lookup timed out/);
});

test("the lookup note announces itself to a screen reader", () => {
  const { note } = buildCityField();
  assert.equal(note.getAttribute("role"), "status");
  assert.equal(note.getAttribute("aria-live"), "polite");
});

test("a list answering an older prefix is not committed by moving on", async () => {
  const pending = [];
  const selections = [];
  const field = createCityField({
    search: (query) => new Promise((resolve) => pending.push({ query, resolve })),
    onSelect: (city) => selections.push(city),
  });
  const [, wrapper] = field.nodes;
  const [input, list] = wrapper.children;

  input.value = "lond";
  await input.dispatch("input");
  pending[0].resolve([MANCHESTER]);
  await afterCityLookup();
  assert.equal(list.hidden, false);

  // Typing on leaves the old list up so the box never blinks empty. Committing
  // it now would set London's coordinates for a box reading "londonderry".
  input.value = "londonderry";
  await input.dispatch("input");
  await input.dispatch("blur");

  assert.deepEqual(selections, []);
  assert.equal(field.value(), null);
  assert.equal(input.value, "londonderry", "the typed text is left alone");
});

test("leaving the field abandons a lookup that has not answered yet", async () => {
  const pending = [];
  const field = createCityField({
    search: (query) => new Promise((resolve) => pending.push({ query, resolve })),
    onSelect: () => {},
  });
  const [, wrapper] = field.nodes;
  const [input, list] = wrapper.children;

  input.value = "manch";
  await input.dispatch("input");
  await input.dispatch("blur");
  pending[0].resolve([MANCHESTER, MANCHESTER_NH]);
  await afterCityLookup();

  // Without invalidating it, the answer arrives and opens a drop-down under a
  // field the user has already moved on from.
  assert.equal(list.hidden, true);
});

test("a touch press on a suggestion scrolls; the tap that follows commits", async () => {
  const { input, list, selections } = buildCityField();
  await typeCity(input, "manch");

  let defaultPrevented = false;
  await list.children[1].dispatch("pointerdown", {
    pointerType: "touch",
    preventDefault() { defaultPrevented = true; },
  });
  // Suppressing a touch press also cancels the browser's scrolling, and the
  // list shows about seven of twenty rows — so a finger could never reach the
  // eighth.
  assert.equal(defaultPrevented, false);
  assert.deepEqual(selections, [], "a press alone commits nothing on touch");

  await list.children[1].dispatch("click");
  assert.deepEqual(selections, [MANCHESTER_NH]);
});

test("the blur a touch press causes does not commit the highlighted entry", async () => {
  const { input, selections, list } = buildCityField();
  await typeCity(input, "manch");

  await list.dispatch("pointerdown", { pointerType: "touch", preventDefault() {} });
  await input.dispatch("blur");

  // The gesture decides for itself: a tap commits what it hit, a scroll commits
  // nothing. Either way the top entry must not be committed behind it.
  assert.deepEqual(selections, []);
});

test("Enter mid-composition belongs to the IME, not the suggestion list", async () => {
  const { input, selections } = buildCityField();
  await typeCity(input, "manch");

  let defaultPrevented = false;
  await input.dispatch("keydown", {
    key: "Enter",
    isComposing: true,
    preventDefault() { defaultPrevented = true; },
  });

  assert.equal(defaultPrevented, false, "the IME needs this Enter to confirm its characters");
  assert.deepEqual(selections, []);
});

// --- Map preview: review follow-ups ------------------------------------------

test("switching the preview off takes the squares with it", () => {
  const { field, previewCanvas, previewCount } = buildDraggableField();
  field.setMarkers([NEAR, ALSO_NEAR]);
  field.setMarkers([], "off");

  // Kept, they would be redrawn around the next position the user enters — the
  // previous location's repeaters, plotted over a different town.
  assert.equal(pinsIn(previewCanvas).length, 0);
  assert.equal(previewCount.hidden, true);
});

test("a clipped search says so rather than reading as full coverage", () => {
  const { field, previewCount } = buildDraggableField();
  field.setMarkers([NEAR], "ok", { truncated: true });
  assert.equal(previewCount.textContent, "1 in range (part of the area only)");

  field.setMarkers([NEAR], "ok");
  assert.equal(previewCount.textContent, "1 in range");
});

test("repeater squares travel with the map under a drag", async () => {
  const { field, previewCanvas } = buildDraggableField();
  field.setMarkers([NEAR, ALSO_NEAR]);

  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 140, clientY: 120 });

  // They mark places on the ground. Left behind, every one slides off its town
  // for the length of the gesture and jumps back on release.
  const shifted = pinsIn(previewCanvas).map((pin) => pin.style.transform);
  assert.deepEqual(shifted, [
    "translate(calc(-50% + 40px), calc(-50% + 20px))",
    "translate(calc(-50% + 40px), calc(-50% + 20px))",
  ]);
  await previewCanvas.dispatch("pointerup", { pointerId: 1 });
});

test("a repeater across the antimeridian is drawn beside the map, not a world away", () => {
  // Fiji, hard against the line. The raw difference between two world pixels
  // either side of it is almost a whole world wide, which would put this
  // repeater far off the viewport and out of the count.
  const { field, previewCanvas, previewCount } = buildDraggableField({
    initial: { latitudeText: "-17.800000", longitudeText: "179.900000" },
  });
  field.setMarkers([{ latitude: -17.8, longitude: -179.9, inRange: true }]);

  assert.equal(pinsIn(previewCanvas).length, 1, "about 21 km east, so well inside the map");
  assert.equal(previewCount.textContent, "1 in range");
});

test("a clipped search keeps saying so while the next preview loads", () => {
  const { field, previewCount } = buildDraggableField();
  field.setMarkers([NEAR], "ok", { truncated: true });
  assert.equal(previewCount.textContent, "1 in range (part of the area only)");

  // The next edit puts the preview back in flight. The squares on screen are
  // still the clipped ones, so dropping the qualifier would have the map claim
  // full coverage of a radius it never searched.
  field.setMarkers(null, "loading");
  assert.equal(previewCount.textContent, "1 in range (part of the area only)");
});

test("the caption names what the query would drop or could not place", () => {
  const { field, previewCount } = buildDraggableField();
  field.setMarkers([NEAR, ALSO_NEAR], "ok", { unsupported: 2 });
  assert.equal(previewCount.textContent, "2 in range (2 this radio cannot use)");

  field.setMarkers([NEAR], "ok", { unmapped: 1 });
  assert.equal(previewCount.textContent, "1 in range (1 with no location)");

  // All three qualifiers at once still read as one parenthetical.
  field.setMarkers([NEAR, BEYOND_RING], "ok", { truncated: true, unmapped: 1, unsupported: 3 });
  assert.equal(
    previewCount.textContent,
    "1 in range, 1 just outside (part of the area only; 1 with no location; 3 this radio cannot use)",
  );

  // And they clear with the next clean answer.
  field.setMarkers([NEAR], "ok");
  assert.equal(previewCount.textContent, "1 in range");
});

test("the map caption announces itself to a screen reader", () => {
  const { previewCount } = buildDraggableField();
  assert.equal(previewCount.getAttribute("role"), "status");
  assert.equal(previewCount.getAttribute("aria-live"), "polite");
});

test("an answer arriving mid-drag waits for the gesture to end", async () => {
  const { field, previewCanvas } = buildDraggableField();
  const before = previewCanvas.children[0];

  await previewCanvas.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  await previewCanvas.dispatch("pointermove", { pointerId: 1, clientX: 140, clientY: 100 });
  // The preview query fires 600 ms after the form settles, and holding the
  // pointer still is exactly how that happens. Recentring now would leave the
  // drag measuring from an origin the map no longer has.
  field.setMarkers([NEAR, ALSO_NEAR]);
  assert.equal(previewCanvas.children[0], before, "the tiles were not recentred under the pointer");

  await previewCanvas.dispatch("pointerup", { pointerId: 1 });
  assert.notEqual(previewCanvas.children[0], before, "release draws them");
  assert.equal(pinsIn(previewCanvas).length, 2, "and the markers that arrived are there");
});

test("a touch scroll that commits nothing still closes the list", async () => {
  const { input, list, selections } = buildCityField();
  await input.dispatch("focus");
  await typeCity(input, "manch");

  // Press, blur (ignored because the gesture might be a tap), then lift with no
  // click: the gesture was a scroll. No second blur will ever come, so nothing
  // else would close the list.
  await list.dispatch("pointerdown", { pointerType: "touch", preventDefault() {} });
  await input.dispatch("blur");
  await list.dispatch("pointerup", { pointerType: "touch" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.deepEqual(selections, [], "a scroll commits nothing");
});

test("a new lookup clears the previous one's verdict", async () => {
  const pending = [];
  let results = [];
  const field = createCityField({
    search: (query) => {
      if (results === null) {
        return new Promise((resolve) => pending.push(resolve));
      }
      return Promise.resolve(results);
    },
    onSelect: () => {},
  });
  const [, wrapper] = field.nodes;
  const [input, , note] = wrapper.children;

  await typeCity(input, "zzzz");
  assert.equal(note.textContent, "No matching places.");

  // The next request is slow. Leaving the old verdict up presents it as the
  // answer for what is being typed now.
  results = null;
  input.value = "manch";
  await input.dispatch("input");
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, "");
  pending[0]([MANCHESTER]);
});

// A real browser runs an option's own pointerdown handler first, then bubbles
// the same event to the list. The fake DOM has no bubbling, so a test that
// wants that sequence dispatches at both, which is what each listener would
// have been handed.
async function pressOption(list, index, init = {}) {
  const event = { pointerType: "mouse", preventDefault() {}, ...init };
  await list.children[index].dispatch("pointerdown", event);
  await list.dispatch("pointerdown", { ...event, target: list.children[index] });
}

test("a mouse press on the list never suppresses a later blur commit", async () => {
  const { input, list, selections } = buildCityField();
  await typeCity(input, "manch");

  // The press is suppressed for a mouse, so focus never leaves the box and no
  // blur needs ignoring. Marking the gesture active anyway strands the flag,
  // because an option's handler has already hidden the list by the time the
  // event bubbles here — the release and click then land on the page, and the
  // listeners that would clear it are on an element nothing is pointing at.
  await list.dispatch("pointerdown", { pointerType: "mouse", preventDefault() {} });
  await input.dispatch("blur");

  assert.deepEqual(selections, [MANCHESTER], "the blur still commits");
  assert.equal(list.hidden, true);
});

test("picking one city by mouse does not strand the next one", async () => {
  const byQuery = { lond: [LONDON], manch: [MANCHESTER, MANCHESTER_NH] };
  const selections = [];
  const field = createCityField({
    search: async (query) => byQuery[query] || [],
    onSelect: (city) => selections.push(city),
  });
  const [, wrapper] = field.nodes;
  const [input, list] = wrapper.children;

  // The reported sequence: click London, type Manchester, press Tab.
  await input.dispatch("focus");
  await typeCity(input, "lond");
  await pressOption(list, 0);
  assert.deepEqual(selections, [LONDON]);

  await typeCity(input, "manch");
  await input.dispatch("blur");

  assert.deepEqual(selections, [LONDON, MANCHESTER], "Tab commits the new city");
  assert.equal(field.value(), MANCHESTER);
  assert.equal(list.hidden, true, "and its list does not sit open over the form");
});

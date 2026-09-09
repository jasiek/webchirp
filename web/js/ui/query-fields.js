import { decodeMaidenheadBox, encodeMaidenhead } from "../rsgb.js";
import { latLonToWorldPixel, worldPixelToLatLon, zoomForRadius } from "../staticmap.js";
import { createMapAttribution, renderStaticMap } from "./static-map-view.js";

// Field components for the shared repeater-query modal. Each factory builds
// its own DOM from a config and returns the same shape:
//
//   { key, nodes, focusTarget, value }
//
// `nodes` are appended to the modal grid in order; `focusTarget` is the
// element the modal focuses when this field is first (null when nothing here
// is focusable); `value()` reads the field's typed value. Behaviour is
// identical for every data source — only labels, options, values and defaults
// come from the config. Nothing here queries a directory, logs or tracks
// analytics; that belongs to the modal shell and the per-source configs. (The
// position field's map preview does load OSM tiles, but only for the position
// already typed into it — no directory is contacted and nothing is reported.)
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
    // Exposed so the shell can follow edits: the position field's map preview
    // draws the search radius this field holds.
    input,
    value: () => numericFieldValue(input),
  };
}

// The preview normally frames the search radius rather than a fixed area, so
// the whole "repeaters within N km" circle is on screen. This zoom is only the
// fallback for a source with no range filter at all — close enough to name the
// town, wide enough to show which one.
const PREVIEW_ZOOM = 11;
// How much of the square the range circle fills. Short of 1 so the ring has
// visible map outside it, which is what makes it read as a radius rather than
// as the edge of the widget.
const PREVIEW_RANGE_FILL = 0.9;
// The canvas is only measurable once the modal is on screen; refreshPreview()
// is what the shell calls at that point. This is the fallback for a render
// that happens while the card still has no layout (a test, or a future caller
// that forgets), so the map is approximately right rather than zero-sized.
const PREVIEW_FALLBACK_SIZE = 300;
// Every keystroke in latitude, longitude or the locator is a new position, and
// rendering each one would fetch a tile set per character. The preview only
// has to keep up with the typist, not with the keyboard.
const PREVIEW_DEBOUNCE_MS = 300;
// How much map is drawn beyond each edge of the preview. A drag translates the
// tiles that are already there, so this is how far one can travel before the
// trailing edge runs out of map — and, in the other direction, how much extra
// tile traffic every render costs. Past it the drag rebases: the map redraws
// around where it now is and the drag carries on from there.
const PREVIEW_OVERSCAN = 128;
// A drag has to beat this before it counts as one. Below it, a press is a
// click with a shaky hand, and moving the location under it would make the map
// impossible to merely look at.
const PREVIEW_DRAG_SLOP = 3;

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
//
// Under the three inputs sits a static OSM map of whatever position they
// currently hold, so a mistyped digit or a locator from the wrong square is
// visible before the query runs rather than after a hundred repeaters from the
// wrong country land in the grid. It is a fourth way *into* the position as
// well as a picture of it: dragging the map moves the coordinates under the
// marker, which stays pinned to the centre. `onPan()` fires once per drag that
// actually moved, so the shell can count it the way it counts geolocation —
// where the drag ended up is not reported.
export function createPositionField({ key = "position", locatorPlaceholder, initial = {}, onChange, onPan } = {}) {
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

  // The preview: a tile canvas, a stand-in line for when there is no position
  // to draw, and the OSM credit. It spans both columns of the modal grid (see
  // .modal-map-preview in web/styles.css), so it reads as one block belonging
  // to the three inputs above it rather than as a fourth labelled field.
  const previewCanvas = document.createElement("div");
  previewCanvas.className = "repeater-map-canvas";
  previewCanvas.title = "Drag the map to move the location";
  const previewEmpty = document.createElement("p");
  previewEmpty.className = "modal-map-preview-empty";
  previewEmpty.textContent = "Set a latitude and longitude to preview the location.";
  const previewAttribution = createMapAttribution();
  const preview = document.createElement("div");
  preview.className = "modal-map-preview";
  preview.appendChild(previewCanvas);
  preview.appendChild(previewEmpty);
  preview.appendChild(previewAttribution);

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

  // Draw whatever position the inputs hold, or the stand-in line when they
  // hold none — an out-of-range or half-entered pair is "no position" here for
  // exactly the reason it is to value(), so the preview never shows a spot the
  // query would refuse to use.
  function renderPreview() {
    // The container, not the canvas: renderStaticMap pins the canvas to a
    // pixel width, so measuring the canvas would only ever read back the width
    // of the previous render and a resized card could never be caught up with.
    // The map is square, so that one measurement is both of its sides.
    lastPreviewWidth = preview.clientWidth || PREVIEW_FALLBACK_SIZE;
    const position = currentPosition();
    previewCanvas.hidden = !position;
    previewAttribution.hidden = !position;
    previewEmpty.hidden = Boolean(position);
    if (!position) {
      previewCanvas.innerHTML = "";
      return;
    }
    const radiusMetres = Number.isFinite(rangeKm) && rangeKm > 0 ? rangeKm * 1000 : 0;
    // Frame the search radius when there is one; a source without a range
    // filter falls back to the fixed zoom.
    lastPreviewZoom = zoomForRadius(position.latitude, radiusMetres, lastPreviewWidth, {
      fill: PREVIEW_RANGE_FILL,
    }) ?? PREVIEW_ZOOM;
    renderStaticMap(previewCanvas, position, {
      zoom: lastPreviewZoom,
      width: lastPreviewWidth,
      height: lastPreviewWidth,
      radiusMetres,
      overscan: PREVIEW_OVERSCAN,
    });
  }

  let previewTimer = 0;
  // Width of the last render, so a resize can tell a card that actually
  // changed shape from one that merely reflowed.
  let lastPreviewWidth = 0;
  // Zoom of the last render. A drag needs it to turn screen pixels back into
  // degrees, and it is the render's own value rather than a recomputed one so
  // the arithmetic matches the tiles actually on screen.
  let lastPreviewZoom = 0;
  // The search radius the preview draws, in km. It belongs to a different
  // field entirely (Range/Distance), so the modal shell pushes it in here —
  // see setRangeKm.
  let rangeKm = Number.NaN;

  function schedulePreview() {
    // A drag writes the coordinate fields on every pointermove; redrawing
    // under it would refetch the tile grid dozens of times across one gesture
    // and yank the map out from under the pointer. The drag redraws itself,
    // when it rebases and when it ends.
    if (drag) {
      return;
    }
    if (previewTimer) {
      clearTimeout(previewTimer);
    }
    previewTimer = setTimeout(() => {
      previewTimer = 0;
      renderPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  // Redraw now, dropping any debounced redraw it pre-empts. The shell calls
  // this once the modal is on screen, which is the first moment the canvas has
  // a width to measure.
  function refreshPreview() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = 0;
    }
    renderPreview();
  }

  // Every path that can move the position ends here, so this is the one place
  // the preview has to follow.
  function notifyChange() {
    schedulePreview();
    if (typeof onChange === "function") {
      onChange(String(latitude.value ?? ""), String(longitude.value ?? ""));
    }
  }

  // --- The map as an input --------------------------------------------------

  // Write a coordinate pair into the three fields. Shared by setPosition and
  // by the drag, so a dragged position reaches the locator and the shell's
  // onChange exactly as a geolocated one does.
  function applyPosition(lat, lon) {
    latitude.value = Number(lat).toFixed(6);
    longitude.value = Number(lon).toFixed(6);
    refreshLocatorFromCoords();
    notifyChange();
  }

  // The in-progress drag: where the pointer went down, the position the map
  // was drawn around at that moment, and whether it has yet moved far enough
  // to count. Null whenever no drag is running.
  let drag = null;

  // Offset the tiles without redrawing them. Only the tiles move: the marker
  // and the range ring mark the position being chosen, which is always the
  // centre of the viewport.
  function panTiles(dx, dy) {
    for (const child of previewCanvas.children) {
      if (child.className === "repeater-map-tile") {
        child.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
      }
    }
  }

  // Where the centre lands once the map has been dragged by (dx, dy): dragging
  // the map right moves the point under the marker west, hence the subtraction.
  function positionAfterPan(dx, dy) {
    const origin = latLonToWorldPixel(drag.latitude, drag.longitude, drag.zoom);
    return worldPixelToLatLon(origin.x - dx, origin.y - dy, drag.zoom);
  }

  previewCanvas.addEventListener("pointerdown", (event) => {
    const position = currentPosition();
    // Nothing to drag before there is a position, and nothing to compute with
    // before a render has fixed a zoom. Secondary buttons are left to the
    // browser's own menus.
    if (!position || !lastPreviewZoom || (event.button ?? 0) !== 0) {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latitude: position.latitude,
      longitude: position.longitude,
      zoom: lastPreviewZoom,
      moved: false,
    };
    // Capture, so a drag that leaves the little map keeps being this map's
    // drag instead of ending wherever the pointer crossed the border.
    previewCanvas.setPointerCapture?.(event.pointerId);
    previewCanvas.classList.add("is-panning");
    event.preventDefault?.();
  });

  previewCanvas.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < PREVIEW_DRAG_SLOP) {
      return;
    }
    drag.moved = true;
    const next = positionAfterPan(dx, dy);
    // The fields track the map as it moves, so the numbers are part of the
    // feedback rather than something that appears at the end.
    applyPosition(next.latitude, next.longitude);
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= PREVIEW_OVERSCAN) {
      // Dragged to the edge of the map that was drawn: redraw around where we
      // are now and let the same gesture carry on from there.
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      drag.latitude = next.latitude;
      drag.longitude = next.longitude;
      panTiles(0, 0);
      renderPreview();
      drag.zoom = lastPreviewZoom;
      return;
    }
    panTiles(dx, dy);
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) {
      return;
    }
    const moved = drag.moved;
    drag = null;
    previewCanvas.classList.remove("is-panning");
    previewCanvas.releasePointerCapture?.(event?.pointerId);
    if (!moved) {
      return;
    }
    // The tiles are still translated and only cover where the map used to be;
    // one real render at the new centre replaces both.
    panTiles(0, 0);
    renderPreview();
    // Only that the map was used to set the position, never where it ended up.
    if (typeof onPan === "function") {
      onPan();
    }
  }

  previewCanvas.addEventListener("pointerup", endDrag);
  previewCanvas.addEventListener("pointercancel", endDrag);

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

  // A rendered tile grid is a fixed pixel size, so it stops fitting the card
  // the moment the card changes width — a phone rotated with the modal open,
  // or a desktop window dragged narrower — leaving the marker off-centre.
  // Redrawing on a real width change keeps the position under the dot.
  // Guarded: the headless tests' DOM has no ResizeObserver, and a preview that
  // never notices a resize is still a correct preview.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (preview.clientWidth && preview.clientWidth !== lastPreviewWidth) {
        schedulePreview();
      }
    }).observe(preview);
  }

  // Seed the locator from whatever coordinates the field opened with. The
  // preview is only put into its empty/filled state here, not drawn: the modal
  // is still hidden, so refreshPreview() from the shell is what measures and
  // draws it.
  refreshLocatorFromCoords();
  previewCanvas.hidden = true;
  previewAttribution.hidden = true;
  previewEmpty.hidden = false;

  return {
    key,
    nodes: [
      labelledBy("Latitude", latitude.id),
      latitude,
      labelledBy("Longitude", longitude.id),
      longitude,
      labelledBy("Locator", locator.id),
      geoRow,
      preview,
    ],
    focusTarget: latitude,
    refreshPreview,
    // The range filter is a sibling field, so the shell hands its value over
    // whenever it changes; the preview reframes around the new radius.
    setRangeKm: (km) => {
      const next = Number(km);
      if (next === rangeKm || (Number.isNaN(next) && Number.isNaN(rangeKm))) {
        return;
      }
      rangeKm = next;
      schedulePreview();
    },
    value: () => currentPosition(),
    setPosition: applyPosition,
    geolocateButton,
  };
}

import { decodeMaidenheadBox, encodeMaidenhead } from "../rsgb.js";
import { latLonToWorldPixel, worldPixelToLatLon, zoomForRadius } from "../staticmap.js";
import { rememberBounded } from "./format.js";
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
// works. They are deliberately not in web/js/ui/dom.js: the fields exist only
// between one modal open and the next, so nothing outside this file may look
// them up.
const FIELD_ID_PREFIX = "repeater-query-field-";

function fieldId(key, suffix = "") {
  return `${FIELD_ID_PREFIX}${key}${suffix ? `-${suffix}` : ""}`;
}

// Every field's label carries this class, whichever element it is built from,
// so the stacked phone layout can put the gap between fields on the labels and
// leave a label sitting close to the control it names (see the max-width: 560px
// block in web/styles.css). A selector cannot do the job on its own: a label is
// a <label> when it has a control to point at and a <span> when it does not.
const FIELD_LABEL_CLASS = "modal-field-label";

function labelledBy(text, controlId) {
  const label = document.createElement("label");
  label.className = FIELD_LABEL_CLASS;
  label.htmlFor = controlId;
  label.textContent = text;
  return label;
}

function plainLabel(text) {
  const span = document.createElement("span");
  span.className = FIELD_LABEL_CLASS;
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
// The worked examples in the coordinate placeholders. Manchester, to match the
// place the Place name box uses as its own example, at the four decimal places
// (about 10 m) the field is worth typing to by hand.
const LATITUDE_PLACEHOLDER = "Latitude 53.4808";
const LONGITUDE_PLACEHOLDER = "Longitude -2.2426";

// A drag has to beat this before it counts as one. Below it, a press is a
// click with a shaky hand, and moving the location under it would make the map
// impossible to merely look at.
const PREVIEW_DRAG_SLOP = 3;

// A latitude/longitude pair on one row, and a Maidenhead locator sharing its
// row with the geolocate and clear buttons. The locator is a two-way
// alternative way to enter the position, not a filter of its own — every
// source's query consumes only the coordinate pair. Editing one side rewrites
// the other; the rewrites are programmatic value assignments, which fire no
// input events, so the two handlers cannot feed back into each other.
//
// `onChange(latitudeText, longitudeText)` fires whenever the coordinate texts
// change (typing, locator edits, setPosition), so the modal shell can persist
// the position across opens — the one part of the form that does survive a
// close.
//
// Below the last field in the form (see `tailNodes`) sits a static OSM map of
// whatever position the inputs hold, so a mistyped digit or a locator from the
// wrong square is visible before the query runs rather than after a hundred
// repeaters from the wrong country land in the grid. It is a fourth way *into*
// the position as well as a picture of it: dragging the map moves the
// coordinates under the marker, which stays pinned to the centre. `onPan()`
// fires once per drag that actually moved, so the shell can count it the way
// it counts geolocation — where the drag ended up is not reported.
export function createPositionField({ key = "position", locatorPlaceholder, initial = {}, onChange, onPan } = {}) {
  const latitude = document.createElement("input");
  latitude.id = fieldId(key, "latitude");
  latitude.name = "latitude";
  latitude.type = "number";
  latitude.step = "any";
  latitude.value = String(initial.latitudeText ?? "");
  // The two coordinate boxes share one "Coordinates" label, so each names
  // itself in its own placeholder -- the word plus a worked example, because
  // the example alone ("53.4808") does not say which half of the pair it is.
  // The example is a signed decimal and not a hemisphere letter for the same
  // reason: that is what the field accepts, and "2.2426 W" typed literally
  // into a number input is a position in Russia.
  latitude.placeholder = LATITUDE_PLACEHOLDER;
  latitude.setAttribute("aria-label", "Latitude");
  latitude.title = "Latitude";

  const longitude = document.createElement("input");
  longitude.id = fieldId(key, "longitude");
  longitude.name = "longitude";
  longitude.type = "number";
  longitude.step = "any";
  longitude.value = String(initial.longitudeText ?? "");
  longitude.placeholder = LONGITUDE_PLACEHOLDER;
  longitude.setAttribute("aria-label", "Longitude");
  longitude.title = "Longitude";

  // One row, two equal boxes (see .modal-coord-row in web/styles.css).
  const coordRow = document.createElement("div");
  coordRow.className = "modal-coord-row";
  coordRow.appendChild(latitude);
  coordRow.appendChild(longitude);

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
  // The canvas and the stand-in are the same square (see .modal-map-preview in
  // web/styles.css) and only one of them is ever shown, so the block is the
  // same size before a position is entered as after — the modal does not
  // resize under the pointer the moment a locator is typed. The attribution
  // stays put for the same reason: it is the widget's credit, not the tiles'.
  const previewCanvas = document.createElement("div");
  previewCanvas.className = "repeater-map-canvas";
  previewCanvas.title = "Drag the map to move the location";
  const previewEmpty = document.createElement("p");
  previewEmpty.className = "modal-map-preview-empty";
  previewEmpty.textContent = "Set a latitude and longitude to preview the location.";
  const previewAttribution = createMapAttribution();
  // Caption counting the squares on the map. A live region because every
  // message here arrives asynchronously while focus is still on the control
  // that triggered it.
  const previewCount = document.createElement("p");
  previewCount.className = "modal-map-preview-count";
  previewCount.setAttribute("role", "status");
  previewCount.setAttribute("aria-live", "polite");
  previewCount.hidden = true;
  const preview = document.createElement("div");
  preview.className = "modal-map-preview";
  preview.appendChild(previewCanvas);
  preview.appendChild(previewEmpty);
  preview.appendChild(previewCount);
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
    previewEmpty.hidden = Boolean(position);
    if (!position) {
      previewCanvas.innerHTML = "";
      updateCount(null);
      return;
    }
    const radiusMetres = Number.isFinite(rangeKm) && rangeKm > 0 ? rangeKm * 1000 : 0;
    // Frame the search radius when there is one; a source without a range
    // filter falls back to the fixed zoom.
    lastPreviewZoom = zoomForRadius(position.latitude, radiusMetres, lastPreviewWidth, {
      fill: PREVIEW_RANGE_FILL,
    }) ?? PREVIEW_ZOOM;
    const { drawn } = renderStaticMap(previewCanvas, position, {
      zoom: lastPreviewZoom,
      width: lastPreviewWidth,
      height: lastPreviewWidth,
      radiusMetres,
      overscan: PREVIEW_OVERSCAN,
      markers: plot.points,
    });
    updateCount(drawn);
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
  // Everything the caption under the map is built from, pushed in by the shell
  // after it previews the query the form describes (see setMarkers). Held here
  // rather than fetched here because this file contacts no directory.
  //   state:      "ok" once an answer is drawn, "loading" while the next is
  //               fetched, "failed" when it could not be, "blocked" when no
  //               radio is loaded to import into, "needed" when the source
  //               cannot be queried until a position is set, "off" when there
  //               is nothing to preview.
  //   points:     the repeaters to plot.
  //   truncated:  the source searched only part of the area (RSGB clips its
  //               fan-out at 24 squares), so the count is not whole-radius
  //               coverage.
  //   unmapped:   repeaters the query inserts but the map cannot place.
  //   unsupported: repeaters the map places but the selected radio cannot use.
  //   drawn:      the tally from the last render, so a caption rewritten
  //               without a redraw still describes the squares on screen.
  let plot = { state: "off", points: [], truncated: false, unmapped: 0, unsupported: 0, drawn: null };

  // States whose caption does not depend on what is drawn.
  const FIXED_CAPTIONS = {
    failed: "Could not preview this search.",
    blocked: "Select a radio to preview repeaters.",
    // The readable half of a disabled Query API button. The button carries the
    // same sentence as a title, which is nothing at all on a touch screen, so
    // the reason it cannot be pressed has to be on the page somewhere -- and
    // under the map is where the user is already looking for the missing
    // location.
    needed: "Set a location to search this directory.",
  };

  // Caption the map with what is drawn on it, not with what was handed in: a
  // station the radius reaches but the viewport does not is real, and promising
  // it under a map that has no square for it is worse than not counting it.
  function updateCount(drawn) {
    plot.drawn = drawn;
    previewCount.classList.toggle("is-loading", plot.state === "loading");
    if (FIXED_CAPTIONS[plot.state]) {
      previewCount.textContent = FIXED_CAPTIONS[plot.state];
      previewCount.hidden = false;
      return;
    }
    previewCount.hidden = plot.state === "off" || !drawn;
    if (!drawn) {
      return;
    }
    if (plot.state === "loading" && drawn.inRange === 0 && drawn.outOfRange === 0) {
      previewCount.textContent = "Looking for repeaters...";
      return;
    }
    const parts = [drawn.outOfRange > 0
      ? `${drawn.inRange} in range, ${drawn.outOfRange} just outside`
      : `${drawn.inRange} in range`];
    if (plot.truncated) {
      parts.push("part of the area only");
    }
    if (plot.unmapped > 0) {
      parts.push(`${plot.unmapped} with no location`);
    }
    if (plot.unsupported > 0) {
      parts.push(`${plot.unsupported} this radio cannot use`);
    }
    previewCount.textContent = parts.length > 1
      ? `${parts[0]} (${parts.slice(1).join("; ")})`
      : parts[0];
  }

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

  function cancelScheduledPreview() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = 0;
    }
  }

  // Redraw now, dropping any debounced redraw it pre-empts. The shell calls
  // this once the modal is on screen, which is the first moment the canvas has
  // a width to measure.
  //
  // Never during a drag: a directory answer landing mid-gesture would recentre
  // the tiles under a drag still measuring from the old origin, and the basemap
  // would jump away from the pointer. endDrag redraws anyway.
  function refreshPreview() {
    if (drag) {
      return;
    }
    cancelScheduledPreview();
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

  // Offset the map without redrawing it. The tiles and the repeater squares
  // move (they mark places on the ground); the centre marker and the range
  // ring do not (they mark the position being chosen, always the viewport
  // centre). A pin is centred on its coordinate by a transform of its own, so
  // the pan composes with that rather than replacing it.
  function panTiles(dx, dy) {
    const tileShift = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    const pinShift = dx || dy
      ? `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
      : "";
    for (const child of previewCanvas.children) {
      const className = String(child.className || "");
      if (className === "repeater-map-tile") {
        child.style.transform = tileShift;
      } else if (className.startsWith("repeater-map-pin")) {
        child.style.transform = pinShift;
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
    // Nothing to drag before there is a position. Secondary buttons are left
    // to the browser's own menus.
    if (!position || (event.button ?? 0) !== 0) {
      return;
    }
    // A redraw queued by a keystroke that landed inside the debounce window
    // is still pending here, and schedulePreview's drag guard only covers
    // redraws asked for *after* the drag began. Left alone it fires
    // mid-gesture, recentring the tile grid under a captured pointer that goes
    // on measuring from where it started — a visible jump, then a doubled pan
    // until release. Settling it now also makes the tiles and the drag's
    // origin describe the same place, which they otherwise need not.
    if (previewTimer) {
      refreshPreview();
    }
    // Nothing to compute with before a render has fixed a zoom.
    if (!lastPreviewZoom) {
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
  previewEmpty.hidden = false;

  return {
    key,
    nodes: [
      labelledBy("Coordinates", latitude.id),
      coordRow,
      labelledBy("Locator", locator.id),
      geoRow,
    ],
    // Appended after every other field rather than in place (see buildFields in
    // web/js/ui/repeater-query.js). The preview draws the whole query -- the
    // position, and the range circle a later field supplies -- so a range
    // control below the picture of itself was the one field the user had to
    // scroll past the map to reach.
    tailNodes: [preview],
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
    // Plot what the current filters would return. `state` is "loading" while a
    // preview is in flight, "ok" with points, "blocked" when the app could not
    // import the answer anyway, or "failed"/"off" when there is nothing to show
    // — the squares already drawn stay put while the next answer is fetched,
    // because blanking the map on every edit would make it flicker through
    // every keystroke of a radius.
    setMarkers: (points, state = "ok", { truncated = false, unmapped = 0, unsupported = 0 } = {}) => {
      plot.state = state;
      if (state === "ok") {
        // Only an answer carries the qualifiers; "loading" and "failed" keep
        // the ones describing the squares still on screen.
        Object.assign(plot, { truncated, unmapped, unsupported, points: Array.isArray(points) ? points : [] });
        refreshPreview();
        return;
      }
      // "off", "blocked" and "needed" all mean there is nothing to preview, so
      // the squares must go with the caption, or they would be redrawn around
      // the next position the user enters while its own preview is still on
      // its way.
      if ((state === "off" || state === "blocked" || state === "needed") && plot.points.length > 0) {
        plot.points = [];
        refreshPreview();
        return;
      }
      // The other states change only the caption; a redraw would refetch the
      // tile grid just to say "loading".
      updateCount(plot.drawn);
    },
    value: () => currentPosition(),
    setPosition: applyPosition,
    geolocateButton,
  };
}

// --- Place name autocomplete -------------------------------------------------

// The lookup runs on every keystroke with no debounce: typing leaves 150-250 ms
// between characters, so a window short enough not to be felt collapses
// nothing. Instead searchGeneration drops superseded responses and a per-field
// cache of answered queries makes backspacing over an overshot letter free.
// Capped so a long session cannot accumulate an entry per keystroke.
const CITY_CACHE_LIMIT = 60;

// The administrative context that distinguishes a place from its namesakes.
// Region is often blank for small places and is skipped, not left as a comma.
function cityContext(city) {
  return [city.region, city.country].filter((part) => part && part.length > 0).join(", ");
}

// Full text of a committed choice: "London" alone would not say which of the
// four the coordinates below it came from.
function cityLabel(city) {
  const context = cityContext(city);
  return context ? `${city.name}, ${context}` : city.name;
}

// Text input that suggests place names. It stores no position itself: it
// reports the chosen city through `onSelect(city)` and the modal shell pushes
// the coordinates into the position field, which owns latitude, longitude,
// the locator and the map.
//
// Injected by the shell, because this file contacts no service and has no
// logger: `search(query)` -> Promise of suggestions; `onError(error)` for the
// debug panel (the field shows its own one-line note); `onSelect(city)`.
// `initial.city` is the place kept from last time, shown without a lookup.
//
// Commit rules: Enter, a click, or moving focus away commits the highlighted
// suggestion (the first starts highlighted, so "type and tab away" lands on
// the best match); arrows move the highlight; Escape closes the list and
// leaves the text alone.
export function createCityField({
  key = "city",
  label = "Place name",
  placeholder = "e.g. Manchester",
  initial = {},
  search,
  onError,
  onSelect,
} = {}) {
  const input = document.createElement("input");
  input.id = fieldId(key);
  input.name = key;
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  // A combobox rather than a plain text box, so a screen reader announces that
  // there is a list under it and which entry is current.
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");

  const list = document.createElement("ul");
  list.id = fieldId(key, "listbox");
  list.className = "modal-city-suggestions";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  input.setAttribute("aria-controls", list.id);

  // Status line for "no matches" and "lookup failed". A failed suggestion is
  // not a failed query, so it is reported here and nowhere else. A live region,
  // because both messages arrive after the keystroke and open no list.
  const note = document.createElement("p");
  note.className = "modal-city-note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  note.hidden = true;

  // The list is absolutely positioned against this wrapper (see
  // .modal-city-field in web/styles.css), so it overlays the fields below
  // instead of pushing the whole modal taller on every keystroke.
  const wrapper = document.createElement("div");
  wrapper.className = "modal-city-field";
  wrapper.appendChild(input);
  wrapper.appendChild(list);
  wrapper.appendChild(note);

  // A mouse press anywhere in the list (scrollbar included) must not move focus
  // out of the input, because blur commits the highlighted entry. A touch press
  // cannot be suppressed the same way without cancelling scrolling, so it sets
  // a flag instead: the blur it causes is ignored and a tap commits through the
  // option's click handler. The flag is never set for a mouse -- its option
  // handler has already committed and closed the list, so no click would follow
  // to clear it, and every later blur would return early.
  list.addEventListener("pointerdown", (event) => {
    if ((event.pointerType || "mouse") === "mouse") {
      event.preventDefault?.();
      return;
    }
    listPointerActive = true;
  });
  // Cleared whichever way the gesture ends. A touch scroll produces no click,
  // and the blur it caused was ignored, so the list must close itself here;
  // the check runs after the click a tap would have produced.
  const endListPointer = () => {
    listPointerActive = false;
    setTimeout(() => {
      if (!list.hidden && !inputFocused && !listPointerActive) {
        closeList();
      }
    }, 0);
  };
  list.addEventListener("pointerup", endListPointer);
  list.addEventListener("pointercancel", endListPointer);

  let suggestions = [];
  // The text the visible list answers. The previous prefix's results stay on
  // screen while the next lookup runs, and committing them then would be wrong.
  let suggestionsQuery = "";
  // True between a press inside the list and the end of that gesture. On a
  // touchscreen the press is as likely to be the start of a scroll as a tap,
  // and either way the blur it causes must not commit the highlighted entry.
  let listPointerActive = false;
  // Whether the box still holds focus. Tracked rather than read from
  // document.activeElement so the check works the same in the headless tests,
  // whose DOM has no active element.
  let inputFocused = false;
  let activeIndex = -1;
  let selected = initial.city || null;
  // Bumped on every keystroke, commit and cancel, so a response that lands
  // after a later one has rendered can bow out.
  let searchGeneration = 0;
  // Answered queries, keyed by the typed text. See CITY_CACHE_LIMIT.
  const cache = new Map();

  function setNote(text) {
    note.textContent = text || "";
    note.hidden = !text;
  }

  function closeList() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  }

  // Move the highlight, in the list and in what a screen reader reads.
  function setActiveIndex(index) {
    activeIndex = index;
    for (let i = 0; i < list.children.length; i += 1) {
      const option = list.children[i];
      const isActive = i === index;
      option.classList.toggle("is-active", isActive);
      option.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView?.({ block: "nearest" });
      }
    }
  }

  function renderSuggestions(entries) {
    suggestions = entries;
    list.innerHTML = "";
    if (entries.length === 0) {
      closeList();
      return;
    }
    entries.forEach((city, index) => {
      const option = document.createElement("li");
      option.id = fieldId(key, `option-${index}`);
      option.className = "modal-city-suggestion";
      option.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "modal-city-name";
      name.textContent = city.name;
      option.appendChild(name);
      const context = cityContext(city);
      if (context) {
        const detail = document.createElement("span");
        detail.className = "modal-city-context";
        detail.textContent = context;
        option.appendChild(detail);
      }
      // A mouse commits on pointerdown: a click would blur the input first, and
      // blur commits whatever is highlighted, not necessarily this entry. A
      // touch press may yet become a scroll, so it waits for the click.
      option.addEventListener("pointerdown", (event) => {
        if ((event.pointerType || "mouse") !== "mouse") {
          return;
        }
        event.preventDefault?.();
        setActiveIndex(index);
        commitActive();
      });
      // The touch path. A mouse reaches here after its pointerdown has
      // already committed and closed the list, so there is nothing to commit.
      option.addEventListener("click", () => {
        listPointerActive = false;
        setActiveIndex(index);
        commitActive();
      });
      option.addEventListener("pointerenter", () => setActiveIndex(index));
      list.appendChild(option);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    // The top match starts highlighted: it is the one Enter and a blur commit,
    // and a highlight that only appeared on the first arrow press would make
    // that invisible until after the fact.
    setActiveIndex(0);
  }

  // Take the highlighted suggestion: put its full name in the box, close the
  // list, and report it. Returns whether anything was committed, so the key
  // handler knows whether to swallow the Enter.
  function commitActive() {
    const city = suggestions[activeIndex];
    // A list still answering a shorter prefix must not be committed: it would
    // set "London" for a box reading "londonderry".
    if (!city || suggestionsQuery !== String(input.value ?? "").trim()) {
      return false;
    }
    selected = city;
    input.value = cityLabel(city);
    setNote("");
    closeList();
    listPointerActive = false;
    // A lookup still in flight would reopen the list over a settled choice.
    searchGeneration += 1;
    if (typeof onSelect === "function") {
      onSelect(city);
    }
    return true;
  }

  // Wipe the box and the choice it held, because the position was set by some
  // other route and the name no longer describes the coordinates under it.
  // Silent: the shell is the caller, so reporting back would risk a loop.
  function clear() {
    if (!selected && String(input.value ?? "") === "") {
      return;
    }
    selected = null;
    input.value = "";
    setNote("");
    closeList();
    searchGeneration += 1;
  }

  // Show a result set, from wherever it came. One place, so a cached answer and
  // a fresh one put the list into exactly the same state.
  function showResults(results, query) {
    suggestionsQuery = query;
    renderSuggestions(results);
    setNote(results.length === 0 ? "No matching places." : "");
  }

  async function runSearch(text) {
    const generation = searchGeneration;
    let results = [];
    try {
      results = await search(text);
    } catch (error) {
      if (generation !== searchGeneration) {
        return;
      }
      suggestionsQuery = "";
      renderSuggestions([]);
      // One line for the user; the whole error, stack included, goes to the
      // debug panel through the shell — this file has no logger of its own.
      setNote(`City lookup unavailable: ${error.message}`);
      if (typeof onError === "function") {
        onError(error);
      }
      return;
    }
    // A failed lookup is deliberately not cached: the next keystroke should
    // retry rather than replay the outage for the rest of the modal session.
    rememberBounded(cache, text, results, CITY_CACHE_LIMIT);
    // Superseded by a later keystroke or by a commit while this was in flight.
    if (generation !== searchGeneration) {
      return;
    }
    showResults(results, text);
  }

  input.addEventListener("input", () => {
    // Typing means any pointer gesture on the list finished, however it ended
    // -- a touch that lifted off the list never reaches its pointerup handler.
    listPointerActive = false;
    // Editing the text abandons the previous choice: the coordinates already
    // pushed into the position field stay (the user may be refining the name
    // of the place they picked), but nothing here still claims to describe
    // them.
    selected = null;
    const text = String(input.value ?? "").trim();
    // Every new keystroke invalidates whatever is in flight, whether or not a
    // fresh lookup follows it.
    searchGeneration += 1;
    if (text.length === 0) {
      suggestionsQuery = "";
      renderSuggestions([]);
      setNote("");
      return;
    }
    if (typeof search !== "function") {
      return;
    }
    const cached = cache.get(text);
    if (cached) {
      showResults(cached, text);
      return;
    }
    // The previous verdict belongs to the previous text; left up while the
    // next request runs it reads as the verdict on what is being typed now.
    setNote("");
    runSearch(text);
  });

  input.addEventListener("keydown", (event) => {
    // Mid-composition, Enter and the arrows belong to the IME.
    if (list.hidden || event.isComposing) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault?.();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = suggestions.length;
      setActiveIndex(((activeIndex + step) % count + count) % count);
      return;
    }
    if (event.key === "Enter") {
      // The modal's form submits on Enter, so committing a suggestion has to
      // swallow the key or picking a city would run the query at the same time.
      event.preventDefault?.();
      commitActive();
      return;
    }
    if (event.key === "Escape") {
      // Escape on the document closes the whole modal
      // (web/js/ui.js); with a list open it should only close the list.
      event.preventDefault?.();
      event.stopPropagation?.();
      searchGeneration += 1;
      closeList();
    }
  });

  // Leaving the field takes the top suggestion, which is the field's whole
  // promise: type enough of a name, move on, and the position is set.
  input.addEventListener("focus", () => { inputFocused = true; });

  input.addEventListener("blur", () => {
    inputFocused = false;
    // Focus left because a finger landed in the list; that gesture decides
    // for itself whether it is a tap or a scroll.
    if (listPointerActive) {
      return;
    }
    if (!commitActive()) {
      closeList();
      // A lookup still in flight would otherwise reopen the list under a
      // field the user has moved on from.
      searchGeneration += 1;
    }
  });

  // Assigning the value fires no input event, so this triggers no lookup.
  if (selected) {
    input.value = cityLabel(selected);
  }

  return {
    key,
    nodes: [labelledBy(label, input.id), wrapper],
    focusTarget: input,
    // The committed place, or null. No source filters by city; this exists
    // for the shell's persistence and the tests, not for a query parameter.
    value: () => selected,
    clear,
    input,
    list,
  };
}

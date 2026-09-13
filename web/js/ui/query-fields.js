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
// works. They are deliberately not in web/js/ui/dom.js: the fields exist only
// between one modal open and the next, so nothing outside this file may look
// them up.
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
  // What the squares on the map add up to. The map shows where they are; this
  // says how many, which is the number that decides whether to widen the radius
  // or narrow the filters — and it is the only place the out-of-range ones are
  // counted rather than merely dimmed.
  const previewCount = document.createElement("p");
  previewCount.className = "modal-map-preview-count";
  // A live region, for the same reason the city lookup's note is one: every
  // message here -- the count, "looking", the failure, the blocked state --
  // arrives asynchronously while focus is still on the control that triggered
  // it, so a screen reader would otherwise announce none of them.
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
      markers,
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
  // Repeaters to plot, pushed in by the shell after it previews the query the
  // form currently describes. Held here rather than fetched here for the reason
  // every other field holds nothing it did not build: this file contacts no
  // directory. See setMarkers.
  let markers = [];
  // What the caption should say about the squares, independent of them:
  // "ok" once an answer is drawn, "loading" while the next is being fetched,
  // "failed" when it could not be, "off" when there is nothing to preview.
  let previewState = "off";
  // Whether the source could only search part of the area asked for — RSGB
  // clips its locator fan-out at 24 squares. A count drawn from a clipped
  // search reads as coverage of the whole radius unless it says otherwise.
  let previewTruncated = false;
  // How far the caption's count is from what Query API would insert: repeaters
  // the query takes but the map cannot place, and repeaters the map places but
  // the selected radio cannot express. Both stay at zero for most searches; a
  // caption that ignored them would quietly promise the wrong total.
  let previewUnmapped = 0;
  let previewUnsupported = 0;
  // The tally from the last render, so a caption rewritten without a redraw
  // (a preview starting or failing) still describes the squares on screen.
  let lastDrawn = null;

  // Caption the map with what is drawn on it, not with what was handed in: a
  // station the radius reaches but the viewport does not is real, and promising
  // it under a map that has no square for it is worse than not counting it.
  function updateCount(drawn) {
    lastDrawn = drawn;
    previewCount.hidden = previewState === "off" || !drawn;
    previewCount.classList.toggle("is-loading", previewState === "loading");
    if (previewState === "failed") {
      previewCount.textContent = "Could not preview this search.";
      previewCount.hidden = false;
      return;
    }
    // Nothing was asked, and nothing could be imported either: the caption says
    // why rather than leaving the map blank next to a filled-in form.
    if (previewState === "blocked") {
      previewCount.textContent = "Select a radio to preview repeaters.";
      previewCount.hidden = false;
      return;
    }
    if (!drawn) {
      return;
    }
    if (previewState === "loading" && drawn.inRange === 0 && drawn.outOfRange === 0) {
      previewCount.textContent = "Looking for repeaters...";
      return;
    }
    const parts = [drawn.outOfRange > 0
      ? `${drawn.inRange} in range, ${drawn.outOfRange} just outside`
      : `${drawn.inRange} in range`];
    if (previewTruncated) {
      parts.push("part of the area only");
    }
    if (previewUnmapped > 0) {
      parts.push(`${previewUnmapped} with no location`);
    }
    if (previewUnsupported > 0) {
      parts.push(`${previewUnsupported} this radio cannot use`);
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
  // Never during a drag. A directory answer can land mid-gesture -- the preview
  // query fires 600 ms after the form settles, and holding the pointer still is
  // exactly how that happens -- and recentring the tiles then leaves the drag
  // measuring from an origin the map no longer has, so the next pointermove
  // translates the freshly centred map by the whole displacement and the
  // basemap jumps away from the pointer until release. The markers are already
  // stored, so deferring costs nothing: endDrag redraws anyway.
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

  // Offset the map without redrawing it. The tiles move, and so do the repeater
  // squares plotted on them: those mark places on the ground, so a drag that
  // left them behind would slide every one of them off its town until the
  // redraw on release put it back. The centre marker and the range ring do not
  // move — they mark the position being chosen, which is always the centre of
  // the viewport.
  //
  // A pin is centred on its coordinate by a transform of its own, so the pan
  // has to compose with that rather than replace it.
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
    // Plot what the current filters would return. `state` is "loading" while a
    // preview is in flight, "ok" with points, "blocked" when the app could not
    // import the answer anyway, or "failed"/"off" when there is nothing to show
    // — the squares already drawn stay put while the next answer is fetched,
    // because blanking the map on every edit would make it flicker through
    // every keystroke of a radius.
    setMarkers: (points, state = "ok", { truncated = false, unmapped = 0, unsupported = 0 } = {}) => {
      previewState = state;
      if (state === "ok") {
        // Only an answer says how much of the area it covered, or how far its
        // count is from what the query would insert. "loading" and "failed"
        // carry no options, so assigning here unconditionally would drop those
        // qualifiers while the squares they describe are still the ones on
        // screen.
        previewTruncated = truncated;
        previewUnmapped = unmapped;
        previewUnsupported = unsupported;
        markers = Array.isArray(points) ? points : [];
        refreshPreview();
        return;
      }
      // "off" and "blocked" both mean there is nothing to preview, so the
      // squares must go with the caption. Kept they would be redrawn at the
      // next position the user enters — the previous location's repeaters,
      // plotted around the new one, for as long as its own preview takes to
      // arrive.
      if ((state === "off" || state === "blocked") && markers.length > 0) {
        markers = [];
        refreshPreview();
        return;
      }
      // The other states change only the caption, so the map is left alone
      // rather than redrawn — a redraw would refetch the tile grid to say
      // "loading".
      updateCount(lastDrawn);
    },
    value: () => currentPosition(),
    setPosition: applyPosition,
    geolocateButton,
  };
}

// --- City/Locality autocomplete ---------------------------------------------

// The lookup runs on the keystroke, with no debounce in front of it. A debounce
// is worth having when it collapses a burst into one request, but ordinary
// typing leaves 150-250 ms between characters, so any window short enough not
// to be felt is also too short to collapse anything -- it would have charged
// every keystroke a delay to save a request it rarely saved. What a debounce is
// usually there to protect against is handled directly instead: searchGeneration
// drops a response that a later keystroke has already superseded, and the cache
// below means a prefix typed twice costs one request.
//
// Most of the typing in this box is a prefix of a prefix, and backspacing over
// an overshot letter returns to a query already answered. Replaying those from
// memory is what makes the list feel instant rather than merely quick: a cache
// hit skips the round-trip entirely.
//
// Per field instance, so it lives exactly as long as one open modal and can
// never serve a stale answer into a later session. Capped, because a fast
// typist in a long session would otherwise accumulate an entry per keystroke;
// at the cap the oldest goes, which is the query furthest from what is being
// typed now.
const CITY_CACHE_LIMIT = 60;

// Render one suggestion as the drop-down shows it: the place first, then
// whatever administrative context distinguishes it from its namesakes. Region
// is often blank for small places and is skipped rather than left as a stray
// comma.
function cityContext(city) {
  return [city.region, city.country].filter((part) => part && part.length > 0).join(", ");
}

// Full text of a committed choice, which is what the input then holds. It has
// to carry the context too: "London" alone in the box would not say which of
// the four the coordinates below it came from.
function cityLabel(city) {
  const context = cityContext(city);
  return context ? `${city.name}, ${context}` : city.name;
}

// Text input that suggests place names, and hands the chosen one's coordinates
// to whoever asked for it. It sets no position itself — it reports the
// selection through `onSelect(city)` and the modal shell pushes it into the
// position field, which is what owns latitude, longitude, the locator and the
// map. That keeps this a fifth way *into* the position rather than a second
// place that stores one.
//
// The pieces the shell injects:
//   search(query)        -> Promise of suggestions. Injected because this file
//                           contacts no service of its own.
//   onError(error)       -> a lookup failed. The field shows a one-line note of
//                           its own, but the whole error belongs in the debug
//                           panel, and this file has no logger.
//   onSelect(city)       -> a suggestion was committed, or null when the choice
//                           was abandoned. The modal shell persists it, so the
//                           place survives a close and a source switch exactly
//                           as the coordinates it set do.
//
// `initial.city` is the place the field opens holding -- the one the shell kept
// from last time. The box shows its name and value() returns it straight away,
// with no lookup: the coordinates it produced are already in the form, so
// re-deriving them would be a request whose answer is on screen.
//
// Commit rules, in the order they fire:
//   - Enter or a click commits the highlighted suggestion.
//   - Moving focus away commits it too, so a typist who tabs on does not leave
//     a half-typed name that means nothing.
//   - Arrow keys move the highlight; the first suggestion starts highlighted,
//     which is what makes "type and tab away" land on the best match.
//   - Escape abandons the list and leaves the text alone.
export function createCityField({
  key = "city",
  label = "City/Locality",
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

  // A status line under the box for the two things the list itself cannot say:
  // that a lookup found nothing, and that the lookup failed. A failed
  // suggestion request is not a failed query — the user can still type
  // coordinates — so it is reported here and nowhere else.
  const note = document.createElement("p");
  note.className = "modal-city-note";
  // A live region: "No matching places" and a lookup failure both arrive after
  // the keystroke that caused them and open no list, so without this a screen
  // reader user cannot tell a finished empty lookup from one still running.
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

  // Pressing anywhere in the list -- including its scrollbar, once twenty
  // matches overflow the box -- must not move focus out of the input, because
  // leaving the input commits whatever is highlighted. The per-option handlers
  // suppress the default for the same reason; this covers the gaps between
  // them.
  //
  // Only for a mouse. Suppressing a touch press also cancels the browser's
  // scrolling, and the list holds up to twenty entries in about seven rows of
  // space -- so a finger could never reach the eighth. The flag stands in for
  // the suppression there: the blur the press causes is ignored, and the tap
  // commits through the option's click handler instead.
  list.addEventListener("pointerdown", (event) => {
    listPointerActive = true;
    if ((event.pointerType || "mouse") === "mouse") {
      event.preventDefault?.();
    }
  });
  // Cleared whichever way the gesture ends, including a scroll that produces no
  // click at all -- a flag left set would swallow the next blur's commit.
  //
  // A scroll also has to close the list itself. The press already blurred the
  // input, and that blur was ignored precisely because this gesture might have
  // been a tap; when it turns out not to be, no click follows and no second
  // blur ever will, so the drop-down would sit open over the form with
  // aria-expanded="true" while the user fills in the fields underneath it. The
  // check runs after the click a tap would have produced, and does nothing if
  // that click already closed the list.
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
  // The text the visible list is an answer to. A list can outlive the query it
  // came from — the previous prefix's results stay on screen while the next
  // lookup runs, so the box never blinks empty — and that is exactly when
  // committing it would be wrong. See commitActive.
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
  // Counts lookups so a slow one that lands after a later one has already
  // rendered can bow out. Responses to separate keystrokes have no ordering
  // guarantee, and without this the list can end up showing matches for a
  // prefix the box no longer contains.
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
      // A mouse commits on pointerdown, for the ordering: a click on the list
      // would otherwise blur the input first, and blur commits whatever is
      // highlighted — which is not necessarily the entry being clicked.
      // Suppressing the default keeps focus in the box so the highlight the
      // pointer set is the one that commits.
      option.addEventListener("pointerdown", (event) => {
        // A touch press may yet turn into a scroll, so it waits for the click
        // that only a tap produces.
        if ((event.pointerType || "mouse") !== "mouse") {
          return;
        }
        event.preventDefault?.();
        setActiveIndex(index);
        commitActive();
      });
      // The touch path. A mouse reaches here too, but only after its
      // pointerdown has already committed and closed the list, which leaves
      // nothing highlighted for this to commit twice.
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
    // A list still showing answers to a shorter prefix, while the lookup for
    // what is actually typed is in flight, must not be committed: it would set
    // "London" for a box reading "londonderry". Leaving the typed text alone is
    // the honest outcome — the position simply stays as it was.
    if (!city || suggestionsQuery !== String(input.value ?? "").trim()) {
      return false;
    }
    selected = city;
    input.value = cityLabel(city);
    setNote("");
    closeList();
    // Nothing is re-queried for the committed text; a lookup already in flight
    // would reopen the list over a settled choice.
    searchGeneration += 1;
    if (typeof onSelect === "function") {
      onSelect(city);
    }
    return true;
  }

  // Wipe the box and the choice it held. Called when the position is set by
  // some other route -- geolocation, a typed coordinate, a map drag -- because
  // at that moment the name in the box no longer describes the coordinates
  // underneath it, and a label that lies about the position is worse than no
  // label. Silent by design: the shell is the caller, so telling it what it
  // just did would only risk a loop.
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

  function rememberResults(key, results) {
    cache.set(key, results);
    if (cache.size > CITY_CACHE_LIMIT) {
      // Map iterates in insertion order, so the first key is the oldest.
      cache.delete(cache.keys().next().value);
    }
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
    rememberResults(text, results);
    // Superseded by a later keystroke or by a commit while this was in flight.
    if (generation !== searchGeneration) {
      return;
    }
    showResults(results, text);
  }

  input.addEventListener("input", () => {
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
    // "No matching places" or a lookup failure belongs to the text that
    // produced it. Left up while the next request runs -- as long as the
    // four-second deadline, if the service is stalling -- it reads as the
    // verdict on what is being typed now, and a search that would have
    // succeeded looks like one that already failed.
    setNote("");
    runSearch(text);
  });

  input.addEventListener("keydown", (event) => {
    // Mid-composition, Enter and the arrows belong to the IME: Enter confirms
    // the characters being composed, and swallowing it here would commit a
    // suggestion the user has not finished asking for. A list that opened
    // asynchronously under an active composition makes this reachable.
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
    // Focus left because a finger landed in the list. That gesture decides for
    // itself — a tap commits the entry it hit, a scroll commits nothing — and
    // committing the highlighted one here would pre-empt both.
    if (listPointerActive) {
      return;
    }
    if (!commitActive()) {
      closeList();
      // Nothing was committed, so a lookup still in flight has no one left to
      // show its answer to: without this it resolves and reopens the list under
      // a field the user has already moved on from.
      searchGeneration += 1;
    }
  });

  // Show the place the field was handed, if any. Assigning the value fires no
  // input event, so this cannot trigger the lookup that a typed character
  // would.
  if (selected) {
    input.value = cityLabel(selected);
  }

  return {
    key,
    nodes: [labelledBy(label, input.id), wrapper],
    focusTarget: input,
    // The committed place, or null. No source filters by city — every query
    // consumes the coordinate pair this produced — so this exists for the
    // shell's persistence and for the tests, not for a query parameter.
    value: () => selected,
    clear,
    input,
    list,
  };
}

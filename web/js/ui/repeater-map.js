import {
  OSM_ATTRIBUTION,
  formatCoordinates,
  osmTileUrl,
  planStaticMap,
} from "../staticmap.js";
import { rowGeo } from "../row-geo.js";
import { trackEvent } from "./analytics.js";

// Static OSM context map for imported repeater channels (issue #57). Rows that
// arrived from a repeater directory carry coordinates (web/js/row-geo.js);
// hovering their Location cell shows the map as a tooltip on hover-capable
// (desktop) devices, and tapping it opens a dismissable modal on touch
// devices. The map is non-interactive: tiles positioned so the repeater sits
// dead-center under a red dot, with the coordinates as a header.
export function createRepeaterMap(ctx) {
  const { dom, state } = ctx;

  const MAP_ZOOM = 12;
  // Tooltip matches the left sidebar's 280px column (issue #57: "no bigger
  // than the sidebar"); the modal map is square.
  const TOOLTIP_MAP_WIDTH = 280;
  const TOOLTIP_MAP_HEIGHT = 220;

  function hoverCapable() {
    return window.matchMedia?.("(hover: hover)")?.matches ?? true;
  }

  // Paired with repeater_import, this says whether the map earns its keep: a
  // map dismissed inside a second is a pointer passing through, not a look, so
  // only dwells past the threshold count. The surface argument scopes
  // cancellation, not the event: the grid can scroll while the modal is open
  // (the tap that opened it often scrolls the table a little) and that
  // scroll's hideTooltip must not kill the modal's pending dwell. Which
  // surface it was is not reported, and the coordinates are never sent.
  const MAP_DWELL_MS = 1000;
  let dwellTimer = 0;
  let dwellSurface = "";

  function beginDwell(surface) {
    if (dwellTimer) {
      clearTimeout(dwellTimer);
    }
    dwellSurface = surface;
    dwellTimer = setTimeout(() => {
      dwellTimer = 0;
      trackEvent("repeater_map_shown");
    }, MAP_DWELL_MS);
  }

  function cancelDwell(surface) {
    if (dwellTimer && dwellSurface === surface) {
      clearTimeout(dwellTimer);
      dwellTimer = 0;
    }
  }

  // Fill a map viewport element with positioned tile images, the centered
  // marker and the OSM attribution. Tiles that fail to load just stay blank —
  // the coordinates header still identifies the spot.
  function renderMap(canvasEl, geo, width, height) {
    canvasEl.innerHTML = "";
    canvasEl.style.width = `${width}px`;
    canvasEl.style.height = `${height}px`;
    const plan = planStaticMap(geo.latitude, geo.longitude, {
      zoom: MAP_ZOOM,
      width,
      height,
    });
    for (const tile of plan.tiles) {
      const img = document.createElement("img");
      img.className = "repeater-map-tile";
      img.alt = "";
      img.draggable = false;
      // The app is served with COEP: require-corp (Pyodide needs the
      // cross-origin isolation), which blocks plain cross-origin images.
      // tile.openstreetmap.org sends Access-Control-Allow-Origin: *, so a
      // CORS-mode load satisfies COEP where a no-cors one is blocked.
      img.crossOrigin = "anonymous";
      img.style.left = `${tile.left}px`;
      img.style.top = `${tile.top}px`;
      img.src = osmTileUrl(tile);
      canvasEl.appendChild(img);
    }
    const marker = document.createElement("div");
    marker.className = "repeater-map-marker";
    canvasEl.appendChild(marker);
    const attribution = document.createElement("div");
    attribution.className = "repeater-map-attribution";
    attribution.textContent = OSM_ATTRIBUTION;
    canvasEl.appendChild(attribution);
  }

  function geoForEventTarget(target) {
    const button = target?.closest?.(".channel-location-button");
    if (!button) {
      return null;
    }
    const rowIdx = Number(button.closest("tr")?.dataset?.rowIdx);
    if (!Number.isInteger(rowIdx)) {
      return null;
    }
    return rowGeo(state.currentRows[rowIdx]);
  }

  // --- Desktop tooltip ------------------------------------------------------

  function showTooltip(geo, anchorEl) {
    dom.repeaterMapTooltipCoordsEl.textContent = formatCoordinates(geo.latitude, geo.longitude);
    renderMap(dom.repeaterMapTooltipCanvasEl, geo, TOOLTIP_MAP_WIDTH, TOOLTIP_MAP_HEIGHT);
    const tooltip = dom.repeaterMapTooltipEl;
    tooltip.classList.remove("hidden");
    // Location is the leftmost column, so to the right of the cell is always
    // in the grid; only the vertical position needs clamping to the viewport.
    const rect = anchorEl.getBoundingClientRect();
    const tooltipHeight = tooltip.offsetHeight || TOOLTIP_MAP_HEIGHT;
    const top = Math.max(
      8,
      Math.min(rect.top + rect.height / 2 - tooltipHeight / 2, window.innerHeight - tooltipHeight - 8),
    );
    tooltip.style.left = `${Math.round(rect.right + 10)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    beginDwell("tooltip");
  }

  function hideTooltip() {
    cancelDwell("tooltip");
    dom.repeaterMapTooltipEl.classList.add("hidden");
    dom.repeaterMapTooltipCanvasEl.innerHTML = "";
  }

  // --- Mobile modal ---------------------------------------------------------

  function openModal(geo) {
    dom.repeaterMapModalCoordsEl.textContent = formatCoordinates(geo.latitude, geo.longitude);
    // Show first: the canvas has no layout width while the overlay is hidden.
    // The map is square, sized to the modal card's width (issue #57), which
    // the stylesheet caps well inside the viewport.
    dom.repeaterMapModalEl.classList.remove("hidden");
    const size = dom.repeaterMapModalCanvasEl.clientWidth
      || Math.min(Math.round(window.innerWidth * 0.8), 320);
    renderMap(dom.repeaterMapModalCanvasEl, geo, size, size);
    beginDwell("modal");
  }

  function closeModal() {
    cancelDwell("modal");
    dom.repeaterMapModalEl.classList.add("hidden");
    dom.repeaterMapModalCanvasEl.innerHTML = "";
    // Drop the explicit size renderMap set, so the next open re-measures the
    // CSS width (the viewport may have rotated or resized in between).
    dom.repeaterMapModalCanvasEl.style.width = "";
    dom.repeaterMapModalCanvasEl.style.height = "";
  }

  function isModalOpen() {
    return !dom.repeaterMapModalEl.classList.contains("hidden");
  }

  function bindEvents() {
    dom.tableBody.addEventListener("mouseover", (event) => {
      if (!hoverCapable()) {
        return;
      }
      const geo = geoForEventTarget(event.target);
      if (geo) {
        showTooltip(geo, event.target.closest(".channel-location-button"));
      }
    });
    dom.tableBody.addEventListener("mouseout", (event) => {
      const button = event.target?.closest?.(".channel-location-button");
      if (button && !button.contains(event.relatedTarget)) {
        hideTooltip();
      }
    });
    // Scrolling recycles row elements under the cursor; the anchor cell may
    // now show a different channel, so the tooltip must not linger.
    dom.tableScrollEl.addEventListener("scroll", hideTooltip, { passive: true });

    dom.tableBody.addEventListener("click", (event) => {
      if (hoverCapable()) {
        return;
      }
      const geo = geoForEventTarget(event.target);
      if (geo) {
        openModal(geo);
      }
    });
    dom.repeaterMapCloseEl.addEventListener("click", closeModal);
    dom.repeaterMapModalEl.addEventListener("click", (event) => {
      if (event.target === dom.repeaterMapModalEl) {
        closeModal();
      }
    });
  }

  return { bindEvents, isModalOpen, closeModal, hideTooltip };
}

import { callsignFromName, createCallsignLookup, pickLookupEntry } from "../callsign-lookup.js";
import { buildRepeaterEndpoints, resolveRepeaterApiBase } from "../datasources.js";
import { formatCoordinates } from "../staticmap.js";
import { trackEvent } from "./analytics.js";
import { fillMapAttribution, renderStaticMap } from "./static-map-view.js";

// Static OSM context map for repeater channels (issue #57). Hovering a
// Location cell whose channel name is a callsign asks api.codeplug.org where
// that repeater is (web/js/callsign-lookup.js) and draws the answer: a tooltip
// on hover-capable (desktop) devices, a dismissable modal on tap for touch
// devices. The map is non-interactive: tiles positioned so the repeater sits
// dead-center under a red dot, with the coordinates as a header.
//
// The position is looked up per hover rather than carried on the row, so a map
// is available for any channel named after a repeater -- one read off a radio,
// loaded from a .img file or typed by hand -- and not only for the rows this
// session happened to import from a directory. A callsign the directory does
// not know answers 404 and simply gets no map; both answers are cached for 24h
// by the endpoint, so a re-hover costs no request.
export function createRepeaterMap(ctx, { lookup = null } = {}) {
  const { dom, state } = ctx;

  // Injected by the tests, which have no network; production resolves the same
  // deployment-configured base the query modal uses.
  const lookupCallsign = lookup
    || createCallsignLookup(buildRepeaterEndpoints(resolveRepeaterApiBase()).lookup).lookup;

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

  // This surface's fixed zoom, applied to both its sizes; the shared renderer
  // (web/js/ui/static-map-view.js) owns everything below the tile plan.
  function renderMap(canvasEl, geo, width, height) {
    renderStaticMap(canvasEl, geo, { zoom: MAP_ZOOM, width, height });
  }

  // How long the pointer has to rest on a cell before a request leaves. A
  // pointer crossing the Location column on its way somewhere else sweeps
  // through every row in the window, and without this each of those would be a
  // lookup. Short enough that a deliberate hover still feels immediate.
  const HOVER_LOOKUP_DELAY_MS = 180;

  // Identifies the hover a lookup belongs to. Lookups are asynchronous and the
  // pointer does not wait for them, so a reply has to prove it is still wanted
  // before it draws anything: by the time a cold request returns, the pointer
  // may be two rows down, off the table, or on a cell whose row has been
  // recycled underneath it by the virtualized grid.
  let hoverToken = 0;
  let hoverTimer = 0;

  function cancelPendingLookup() {
    hoverToken += 1;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = 0;
    }
  }

  // What a Location cell is asking about: the channel's callsign and the
  // frequency that tells same-callsign entries apart. Null for anything that
  // is not a Location cell, or whose name is not a callsign -- those rows never
  // reach the network.
  function queryForEventTarget(target) {
    const button = target?.closest?.(".channel-location-button");
    if (!button) {
      return null;
    }
    const rowIdx = Number(button.closest("tr")?.dataset?.rowIdx);
    if (!Number.isInteger(rowIdx)) {
      return null;
    }
    const row = state.currentRows[rowIdx];
    const callsign = callsignFromName(row?.Name);
    if (!callsign) {
      return null;
    }
    return { button, callsign, frequency: Number(row?.Frequency) };
  }

  // Resolve a cell's position and hand it to `show`, unless the hover it
  // belongs to has been superseded. A lookup failure is swallowed rather than
  // surfaced: the map is an unasked-for convenience, so a directory that is
  // down or unreachable costs the map and nothing else -- no modal, no error
  // banner, no Sentry report for a network the user never invoked.
  function resolveAndShow(query, show) {
    const token = hoverToken;
    lookupCallsign(query.callsign)
      .then((entries) => {
        const entry = pickLookupEntry(entries, query.frequency);
        if (entry && token === hoverToken) {
          show(entry);
        }
      })
      .catch(() => {});
  }

  // --- Desktop tooltip ------------------------------------------------------

  // Leaving the Location cell does not hide the map immediately: the tooltip
  // sits 10px to the right, and the pointer has to cross that gap to reach the
  // attribution link. Entering the tooltip cancels the pending hide.
  const TOOLTIP_HIDE_DELAY_MS = 250;
  let hideTimer = 0;
  // The Location button the pointer is inside. mouseover fires again for every
  // element boundary crossed within one cell, and each of those would
  // otherwise cancel and restart the lookup the first one began.
  let hoverButton = null;

  function cancelPendingHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  function scheduleHideTooltip() {
    cancelPendingHide();
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      hideTooltip();
    }, TOOLTIP_HIDE_DELAY_MS);
  }

  function showTooltip(geo, anchorEl) {
    cancelPendingHide();
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

  // Take the picture down without touching any lookup in flight. This is the
  // hand-off case: the pointer has moved to another Location cell, so the map
  // on screen now belongs to the wrong row and must go, while the request for
  // the row under the pointer has to survive.
  function clearTooltipDisplay() {
    cancelPendingHide();
    cancelDwell("tooltip");
    dom.repeaterMapTooltipEl.classList.add("hidden");
    dom.repeaterMapTooltipCanvasEl.innerHTML = "";
  }

  // The full stop: the pointer has left the cells altogether (or the grid
  // scrolled out from under it), so a reply still on its way must not draw.
  function hideTooltip() {
    cancelPendingLookup();
    hoverButton = null;
    clearTooltipDisplay();
  }

  // --- Mobile modal ---------------------------------------------------------

  // The Location button the modal was opened from, so dismissing it puts the
  // caret back where it started instead of at the top of the document.
  let modalTrigger = null;

  function openModal(geo, triggerEl) {
    modalTrigger = triggerEl || null;
    dom.repeaterMapModalCoordsEl.textContent = formatCoordinates(geo.latitude, geo.longitude);
    // Show first: the canvas has no layout width while the overlay is hidden.
    // The map is square, sized to the modal card's width (issue #57), which
    // the stylesheet caps well inside the viewport.
    dom.repeaterMapModalEl.classList.remove("hidden");
    const size = dom.repeaterMapModalCanvasEl.clientWidth
      || Math.min(Math.round(window.innerWidth * 0.8), 320);
    renderMap(dom.repeaterMapModalCanvasEl, geo, size, size);
    // Focus the one control the dialog has, so a keyboard or switch user can
    // dismiss it without tabbing through the table behind it.
    dom.repeaterMapCloseEl.focus?.();
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
    const trigger = modalTrigger;
    modalTrigger = null;
    trigger?.focus?.();
  }

  function isModalOpen() {
    return !dom.repeaterMapModalEl.classList.contains("hidden");
  }

  function bindEvents() {
    fillMapAttribution(dom.repeaterMapTooltipAttributionEl);
    fillMapAttribution(dom.repeaterMapModalAttributionEl);

    dom.tableBody.addEventListener("mouseover", (event) => {
      if (!hoverCapable()) {
        return;
      }
      const button = event.target?.closest?.(".channel-location-button");
      if (!button || button === hoverButton) {
        return;
      }
      hoverButton = button;
      // A new cell supersedes the last, including one with no callsign: moving
      // from a repeater row onto a plain one must cancel the request in flight,
      // or its reply would draw a map beside the wrong row.
      cancelPendingLookup();
      const query = queryForEventTarget(event.target);
      if (!query) {
        // Nothing to show here. The hide the previous cell's mouseout
        // scheduled stands, which is what takes the old map down.
        return;
      }
      // The pointer is still inside the Location column, so the previous
      // cell's pending hide is wrong -- but its map is too, so it goes now
      // rather than waiting to be overwritten.
      clearTooltipDisplay();
      hoverTimer = setTimeout(() => {
        hoverTimer = 0;
        resolveAndShow(query, (entry) => showTooltip(entry, query.button));
      }, HOVER_LOOKUP_DELAY_MS);
    });
    dom.tableBody.addEventListener("mouseout", (event) => {
      const button = event.target?.closest?.(".channel-location-button");
      if (button && !button.contains(event.relatedTarget)) {
        hoverButton = null;
        scheduleHideTooltip();
      }
    });
    // The tooltip is hoverable so its attribution link can be clicked; keep it
    // up while the pointer is inside it, and drop it as soon as the pointer
    // leaves for anything that is not the tooltip itself.
    dom.repeaterMapTooltipEl.addEventListener("mouseover", cancelPendingHide);
    dom.repeaterMapTooltipEl.addEventListener("mouseout", (event) => {
      if (!dom.repeaterMapTooltipEl.contains(event.relatedTarget)) {
        scheduleHideTooltip();
      }
    });
    // Scrolling recycles row elements under the cursor; the anchor cell may
    // now show a different channel, so the tooltip must not linger.
    dom.tableScrollEl.addEventListener("scroll", hideTooltip, { passive: true });

    dom.tableBody.addEventListener("click", (event) => {
      if (hoverCapable()) {
        return;
      }
      const query = queryForEventTarget(event.target);
      if (!query) {
        return;
      }
      // A tap is a deliberate ask, so it skips the hover delay -- but it still
      // carries a token, because a second tap elsewhere while the first is in
      // flight must win.
      cancelPendingLookup();
      resolveAndShow(query, (entry) => openModal(entry, query.button));
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

import assert from "node:assert/strict";
import test from "node:test";

import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from "../../web/js/staticmap.js";
import { setRowGeo } from "../../web/js/row-geo.js";
import { FakeElement, installFakeDom } from "../support/fake-dom.mjs";

// Every element focus() lands on, in order, so the modal's focus handling is
// observable.
const FOCUS_LOG = [];

// The shared FakeElement plus what createRepeaterMap needs from layout: the
// anchor cell's rectangle, which positions the tooltip, and a focus() that
// records where focus went rather than only flagging the element.
class MapFakeElement extends FakeElement {
  getBoundingClientRect() {
    return { top: 100, right: 60, bottom: 120, left: 0, width: 60, height: 20 };
  }

  focus() {
    super.focus();
    FOCUS_LOG.push(this);
  }
}

function installMapDom({ hoverCapable = false } = {}) {
  installFakeDom({
    window: {
      innerWidth: 400,
      innerHeight: 800,
      // "(hover: hover)" picks the surface: the tooltip on desktop, the modal
      // on a touch device.
      matchMedia: () => ({ matches: hoverCapable }),
    },
  });
}

// A geo row rendered as a Location button inside a table row, the shape
// channel-table.js produces.
function buildFixture() {
  const dom = {};
  for (const key of [
    "tableBody",
    "tableScrollEl",
    "repeaterMapTooltipEl",
    "repeaterMapTooltipCoordsEl",
    "repeaterMapTooltipCanvasEl",
    "repeaterMapTooltipAttributionEl",
    "repeaterMapModalEl",
    "repeaterMapModalCoordsEl",
    "repeaterMapModalCanvasEl",
    "repeaterMapModalAttributionEl",
    "repeaterMapCloseEl",
  ]) {
    dom[key] = new MapFakeElement(key === "repeaterMapCloseEl" ? "button" : "div");
  }
  dom.repeaterMapTooltipEl.classList.add("hidden");
  dom.repeaterMapModalEl.classList.add("hidden");
  dom.repeaterMapModalCanvasEl.clientWidth = 300;

  // index.html's nesting, which the hover and backdrop handlers read through
  // contains(): each surface owns its coordinates, canvas and attribution.
  for (const child of [
    dom.repeaterMapTooltipCoordsEl,
    dom.repeaterMapTooltipCanvasEl,
    dom.repeaterMapTooltipAttributionEl,
  ]) {
    dom.repeaterMapTooltipEl.appendChild(child);
  }
  const card = dom.repeaterMapModalEl.appendChild(new MapFakeElement("div"));
  card.className = "repeater-map-card";
  for (const child of [
    dom.repeaterMapModalCoordsEl,
    dom.repeaterMapCloseEl,
    dom.repeaterMapModalCanvasEl,
    dom.repeaterMapModalAttributionEl,
  ]) {
    card.appendChild(child);
  }

  const tr = new MapFakeElement("tr");
  tr.dataset.rowIdx = "0";
  dom.tableBody.appendChild(tr);
  const cell = tr.appendChild(new MapFakeElement("td"));
  const button = cell.appendChild(new MapFakeElement("button"));
  button.className = "channel-location-button has-geo";

  const row = { Location: "0", Name: "GB3KI" };
  setRowGeo(row, 51.3704, 1.1289);
  return { dom, state: { currentRows: [row] }, button };
}

async function bootMap(options) {
  installMapDom(options);
  const fixture = buildFixture();
  const { createRepeaterMap } = await import("../../web/js/ui/repeater-map.js");
  const map = createRepeaterMap({ dom: fixture.dom, state: fixture.state });
  map.bindEvents();
  return { ...fixture, map };
}

test("every map surface credits OpenStreetMap with a link to the licence", async () => {
  const { dom, map } = await bootMap();
  for (const el of [dom.repeaterMapTooltipAttributionEl, dom.repeaterMapModalAttributionEl]) {
    assert.equal(el.children.length, 1, "the attribution must be a link, not bare text");
    const [link] = el.children;
    assert.equal(link.tagName, "A");
    assert.equal(link.href, OSM_COPYRIGHT_URL);
    assert.equal(link.textContent, OSM_ATTRIBUTION);
    assert.equal(link.rel, "noopener noreferrer");
  }
  // Binding twice must not stack duplicate credits.
  map.bindEvents();
  assert.equal(dom.repeaterMapModalAttributionEl.children.length, 1);
});

test("the modal takes focus on open and hands it back on close", async () => {
  const { dom, button, map } = await bootMap();
  FOCUS_LOG.length = 0;

  dom.tableBody.dispatch("click", { target: button });
  assert.equal(map.isModalOpen(), true);
  assert.equal(FOCUS_LOG.at(-1), dom.repeaterMapCloseEl, "focus moves into the dialog");

  // Dismissal via the close button, the backdrop and Escape (which ui.js
  // routes to closeModal) all restore the Location button that opened it.
  const dismissals = [
    () => dom.repeaterMapCloseEl.dispatch("click", { target: dom.repeaterMapCloseEl }),
    () => dom.repeaterMapModalEl.dispatch("click", { target: dom.repeaterMapModalEl }),
    () => map.closeModal(),
  ];
  for (const dismiss of dismissals) {
    if (!map.isModalOpen()) {
      dom.tableBody.dispatch("click", { target: button });
    }
    FOCUS_LOG.length = 0;
    dismiss();
    assert.equal(map.isModalOpen(), false);
    assert.equal(FOCUS_LOG.at(-1), button, "focus returns to the Location cell");
  }

  // A click on the card itself is not a dismissal.
  dom.tableBody.dispatch("click", { target: button });
  dom.repeaterMapModalEl.dispatch("click", { target: dom.repeaterMapModalCanvasEl });
  assert.equal(map.isModalOpen(), true);
  map.closeModal();
});

test("the tooltip survives the trip from the cell to its attribution link", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dom, button } = await bootMap({ hoverCapable: true });
  const tooltip = dom.repeaterMapTooltipEl;
  const link = dom.repeaterMapTooltipAttributionEl.children[0];

  dom.tableBody.dispatch("mouseover", { target: button });
  assert.equal(tooltip.classList.contains("hidden"), false);

  // Leaving the cell for the 10px gap starts a hide; reaching the tooltip
  // cancels it, or the link could never be clicked.
  dom.tableBody.dispatch("mouseout", { target: button, relatedTarget: dom.tableBody });
  tooltip.dispatch("mouseover", { target: link });
  t.mock.timers.tick(1000);
  assert.equal(tooltip.classList.contains("hidden"), false, "hovering the tooltip keeps it up");

  // Leaving the tooltip for anything outside it hides it.
  tooltip.dispatch("mouseout", { target: link, relatedTarget: dom.tableBody });
  t.mock.timers.tick(1000);
  assert.equal(tooltip.classList.contains("hidden"), true);

  // Moving inside the tooltip (map to link) is not a departure.
  dom.tableBody.dispatch("mouseover", { target: button });
  tooltip.dispatch("mouseout", { target: dom.repeaterMapTooltipCanvasEl, relatedTarget: link });
  t.mock.timers.tick(1000);
  assert.equal(tooltip.classList.contains("hidden"), false);

  // Scrolling recycles rows under the cursor, so it hides with no grace period.
  dom.tableScrollEl.dispatch("scroll", {});
  assert.equal(tooltip.classList.contains("hidden"), true);
});

test("the map renders tiles and a marker around the repeater", async () => {
  const { dom, button, map } = await bootMap();
  dom.tableBody.dispatch("click", { target: button });
  const kinds = dom.repeaterMapModalCanvasEl.children.map((child) => child.className);
  assert.ok(kinds.filter((kind) => kind === "repeater-map-tile").length >= 1);
  assert.equal(kinds.at(-1), "repeater-map-marker");
  // Tiles load in CORS mode; a plain cross-origin image is blocked under COEP
  // (FINDINGS **coep-blocks-plain-cross-origin-images**).
  for (const tile of dom.repeaterMapModalCanvasEl.children.slice(0, -1)) {
    assert.equal(tile.crossOrigin, "anonymous");
    assert.match(tile.src, /^https:\/\/tile\.openstreetmap\.org\//);
  }
  assert.equal(dom.repeaterMapModalCoordsEl.textContent, "51.37040, 1.12890");
  map.closeModal();
});

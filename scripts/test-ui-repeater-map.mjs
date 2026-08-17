import assert from "node:assert/strict";
import test from "node:test";

import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from "../web/js/staticmap.js";
import { setRowGeo } from "../web/js/row-geo.js";

// Enough of a DOM for createRepeaterMap: real class lists (the module opens and
// closes on "hidden"), a parent chain for closest(), and a focus log so the
// modal's focus handling is observable.
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.parent = null;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
    this.clientWidth = 0;
    this.offsetHeight = 0;
    this._classes = new Set();
    this.classList = {
      add: (name) => this._classes.add(name),
      remove: (name) => this._classes.delete(name),
      contains: (name) => this._classes.has(name),
      toggle: (name, on) => (on ? this._classes.add(name) : this._classes.delete(name)),
    };
  }

  get className() {
    return Array.from(this._classes).join(" ");
  }

  set className(value) {
    this._classes = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  set innerHTML(value) {
    this.children = [];
    this._innerHTML = String(value ?? "");
  }

  get innerHTML() {
    return this._innerHTML || "";
  }

  appendChild(child) {
    child.parent = this;
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
    for (const handler of this.listeners.get(String(type)) || []) {
      handler({ type, ...event });
    }
  }

  matches(selector) {
    return selector.startsWith(".")
      ? this._classes.has(selector.slice(1))
      : this.tagName === selector.toUpperCase();
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (node.matches(selector)) {
        return node;
      }
    }
    return null;
  }

  contains(other) {
    for (let node = other; node; node = node.parent) {
      if (node === this) {
        return true;
      }
    }
    return false;
  }

  getBoundingClientRect() {
    return { top: 100, right: 60, bottom: 120, left: 0, width: 60, height: 20 };
  }

  focus() {
    FOCUS_LOG.push(this);
  }
}

const FOCUS_LOG = [];

function installFakeDom({ hoverCapable = false } = {}) {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tagName) => new FakeElement(tagName) },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
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
    dom[key] = new FakeElement(key === "repeaterMapCloseEl" ? "button" : "div");
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
  const card = dom.repeaterMapModalEl.appendChild(new FakeElement("div"));
  card.className = "repeater-map-card";
  for (const child of [
    dom.repeaterMapModalCoordsEl,
    dom.repeaterMapCloseEl,
    dom.repeaterMapModalCanvasEl,
    dom.repeaterMapModalAttributionEl,
  ]) {
    card.appendChild(child);
  }

  const tr = new FakeElement("tr");
  tr.dataset.rowIdx = "0";
  dom.tableBody.appendChild(tr);
  const cell = tr.appendChild(new FakeElement("td"));
  const button = cell.appendChild(new FakeElement("button"));
  button.className = "channel-location-button has-geo";

  const row = { Location: "0", Name: "GB3KI" };
  setRowGeo(row, 51.3704, 1.1289);
  return { dom, state: { currentRows: [row] }, button };
}

async function bootMap(options) {
  installFakeDom(options);
  const fixture = buildFixture();
  const { createRepeaterMap } = await import("../web/js/ui/repeater-map.js");
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

import assert from "node:assert/strict";
import test from "node:test";

import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from "../../web/js/staticmap.ts";
import { installIndexPage, pageElement } from "../support/index-page.mjs";
import { dispatch, setLayout } from "../support/ui-interactions.mjs";

// One repeater's RXF entry, the shape api.codeplug.org/lookup/<CALLSIGN>
// answers with.
function rxfEntry({ qra = "GB3KI", rx = "145.0375", tx = "145.6375", latitude = "51.370400", longitude = "1.128900" } = {}) {
  return `<repeater><qra>${qra}</qra>`
    + `<qrg type="rx">${rx}</qrg><qrg type="tx">${tx}</qrg>`
    + `<location><latitude>${latitude}</latitude><longitude>${longitude}</longitude></location>`
    + "</repeater>";
}

function rxfResponse(entries) {
  return `<?xml version="1.0"?><rxf><perspective>repeater</perspective><repeaters>${entries.join("")}</repeaters></rxf>`;
}

// A fetch that answers every lookup from one table and counts what it was
// asked, so the cache can be proved rather than assumed. A callsign with no
// entry answers 404, the endpoint's "not in any directory" reply.
function installFakeLookupFetch(bodies) {
  const requested = [];
  const fetchImpl = (url) => {
    requested.push(String(url));
    const callsign = String(url).split("/").pop();
    const body = bodies[callsign];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  };
  return { fetchImpl, requested };
}

// What layout would measure for a Location button, which positions the
// tooltip beside it.
const ANCHOR_RECT = Object.freeze({ top: 100, right: 60, bottom: 120, left: 0, width: 60, height: 20 });

function installMapDom({ hoverCapable = false } = {}) {
  installIndexPage({
    window: {
      innerWidth: 400,
      innerHeight: 800,
      // "(hover: hover)" picks the surface: the tooltip on desktop, the modal
      // on a touch device.
      matchMedia: () => ({ matches: hoverCapable }),
    },
  });
}

// index.html's map surfaces, and channel rows rendered into its grid as
// Location buttons inside table rows, the shape web/js/ui/channel-table.ts
// produces. Each row's Name is what the hover looks up.
function buildFixture(rows) {
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
    dom[key] = pageElement(key);
  }
  // The modal map is drawn at its canvas's laid-out width.
  setLayout(dom.repeaterMapModalCanvasEl, { clientWidth: 300 });

  const buttons = rows.map((row, rowIdx) => {
    const tr = document.createElement("tr");
    tr.dataset.rowIdx = String(rowIdx);
    dom.tableBody.appendChild(tr);
    const cell = tr.appendChild(document.createElement("td"));
    const button = cell.appendChild(document.createElement("button"));
    button.className = "channel-location-button";
    setLayout(button, { getBoundingClientRect: () => ({ ...ANCHOR_RECT }) });
    return button;
  });

  return { dom, state: { currentRows: rows }, buttons, button: buttons[0] };
}

const DEFAULT_ROWS = [{ Location: "0", Name: "GB3KI", Frequency: "145.637500" }];
const DEFAULT_BODIES = { GB3KI: rxfResponse([rxfEntry()]) };

async function bootMap({ rows = DEFAULT_ROWS, bodies = DEFAULT_BODIES, ...options } = {}) {
  installMapDom(options);
  const fixture = buildFixture(rows);
  const { fetchImpl, requested } = installFakeLookupFetch(bodies);
  const { createCallsignLookup } = await import("../../web/js/callsign-lookup.ts");
  const { createRepeaterMap } = await import("../../web/js/ui/repeater-map.ts");
  const { lookup } = createCallsignLookup("https://api.example.com/lookup", { fetchImpl });
  const map = createRepeaterMap({ dom: fixture.dom, state: fixture.state }, { lookup });
  map.bindEvents();
  return { ...fixture, map, requested };
}

// The hover path is a debounce followed by a network round trip, so a test
// that wants the map on screen has to let both settle. Real timers rather than
// mocked ones: the promise the fake fetch resolves needs microtask turns that a
// mocked clock does not hand out.
const HOVER_LOOKUP_DELAY_MS = 180;

function settle(ms = HOVER_LOOKUP_DELAY_MS + 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hover(dom, button) {
  dispatch(button, "mouseover");
  await settle();
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

test("a hover looks the channel's callsign up and maps what comes back", async () => {
  const { dom, button, requested } = await bootMap({ hoverCapable: true });
  await hover(dom, button);

  assert.deepEqual(requested, ["https://api.example.com/lookup/GB3KI"]);
  assert.equal(dom.repeaterMapTooltipEl.classList.contains("hidden"), false);
  assert.equal(dom.repeaterMapTooltipCoordsEl.textContent, "51.37040, 1.12890");
  const kinds = Array.from(dom.repeaterMapTooltipCanvasEl.children).map((child) => child.className);
  assert.ok(kinds.filter((kind) => kind === "repeater-map-tile").length >= 1);
  assert.equal(kinds.at(-1), "repeater-map-marker");
});

test("a callsign the directory does not know gets no map, not an error", async () => {
  // 404 is the endpoint's ordinary "not in any directory" answer, so it must
  // leave the surface alone rather than throwing anywhere a user could see it.
  const { dom, button, requested } = await bootMap({
    hoverCapable: true,
    rows: [{ Location: "0", Name: "GB3ZZ" }],
    bodies: {},
  });
  await hover(dom, button);

  assert.deepEqual(requested, ["https://api.example.com/lookup/GB3ZZ"]);
  assert.equal(dom.repeaterMapTooltipEl.classList.contains("hidden"), true);
});

test("a channel name that is not a callsign never reaches the network", async () => {
  // A bank of presets would otherwise spend one request -- and one cached 404
  // -- per channel, for names that could never be in a repeater directory.
  const { dom, buttons, requested } = await bootMap({
    hoverCapable: true,
    rows: [
      { Location: "0", Name: "PMR 1" },
      { Location: "1", Name: "GMRS 15R" },
      { Location: "2", Name: "" },
      { Location: "3", Name: "Home" },
    ],
  });
  for (const button of buttons) {
    await hover(dom, button);
  }
  assert.deepEqual(requested, []);
  assert.equal(dom.repeaterMapTooltipEl.classList.contains("hidden"), true);
});

test("a re-hover is answered from the cache rather than the network", async () => {
  // The endpoint caches for 24h, so a repeat costs no round trip anyway; this
  // is the session-scoped short-circuit in front of that, which also collapses
  // the burst of hovers one pointer crossing a cell produces.
  const { dom, button, requested } = await bootMap({ hoverCapable: true });
  await hover(dom, button);
  dispatch(button, "mouseout", { relatedTarget: dom.tableBody });
  await hover(dom, button);

  assert.deepEqual(requested, ["https://api.example.com/lookup/GB3KI"]);
  assert.equal(dom.repeaterMapTooltipEl.classList.contains("hidden"), false);
});

test("a pointer passing through a row does not spend a request on it", async () => {
  // The debounce is the whole point: sweeping the Location column on the way
  // somewhere else would otherwise be one lookup per row in the window.
  const { dom, buttons, requested } = await bootMap({
    hoverCapable: true,
    rows: [
      { Location: "0", Name: "GB3KI", Frequency: "145.637500" },
      { Location: "1", Name: "GB3AM", Frequency: "51.340000" },
    ],
    bodies: {
      GB3KI: rxfResponse([rxfEntry()]),
      GB3AM: rxfResponse([rxfEntry({ qra: "GB3AM", rx: "51.34", tx: "50.84", latitude: "51.650000", longitude: "-0.620000" })]),
    },
  });

  dispatch(buttons[0], "mouseover");
  dispatch(buttons[0], "mouseout", { relatedTarget: buttons[1] });
  await hover(dom, buttons[1]);

  assert.deepEqual(requested, ["https://api.example.com/lookup/GB3AM"], "only the row rested on is looked up");
  assert.equal(dom.repeaterMapTooltipCoordsEl.textContent, "51.65000, -0.62000");
});

test("a reply that arrives after the pointer has gone draws nothing", async () => {
  const { dom, button } = await bootMap({ hoverCapable: true });
  dispatch(button, "mouseover");
  // Scrolling recycles rows under the cursor, so whatever the lookup was for
  // may no longer be the row under the anchor cell by the time it answers.
  dispatch(dom.tableScrollEl, "scroll", {});
  await settle();
  assert.equal(dom.repeaterMapTooltipEl.classList.contains("hidden"), true);
});

test("the modal takes focus on open and hands it back on close", async () => {
  const { dom, button, map } = await bootMap();

  dispatch(button, "click");
  await settle(0);
  assert.equal(map.isModalOpen(), true);
  assert.equal(document.activeElement, dom.repeaterMapCloseEl, "focus moves into the dialog");

  // Dismissal via the close button, the backdrop and Escape (which ui.js
  // routes to closeModal) all restore the Location button that opened it.
  const dismissals = [
    () => dispatch(dom.repeaterMapCloseEl, "click"),
    () => dispatch(dom.repeaterMapModalEl, "click"),
    () => map.closeModal(),
  ];
  for (const dismiss of dismissals) {
    if (!map.isModalOpen()) {
      dispatch(button, "click");
      await settle(0);
    }
    dismiss();
    assert.equal(map.isModalOpen(), false);
    assert.equal(document.activeElement, button, "focus returns to the Location cell");
  }

  // A click on the card itself is not a dismissal.
  dispatch(button, "click");
  await settle(0);
  dispatch(dom.repeaterMapModalCanvasEl, "click");
  assert.equal(map.isModalOpen(), true);
  map.closeModal();
});

test("the tooltip survives the trip from the cell to its attribution link", async () => {
  const { dom, button } = await bootMap({ hoverCapable: true });
  const tooltip = dom.repeaterMapTooltipEl;
  const link = dom.repeaterMapTooltipAttributionEl.children[0];

  await hover(dom, button);
  assert.equal(tooltip.classList.contains("hidden"), false);

  // Leaving the cell for the 10px gap starts a hide; reaching the tooltip
  // cancels it, or the link could never be clicked.
  dispatch(button, "mouseout", { relatedTarget: tooltip });
  dispatch(link, "mouseover");
  await settle(400);
  assert.equal(tooltip.classList.contains("hidden"), false, "hovering the tooltip keeps it up");

  // Leaving the tooltip for anything outside it hides it.
  dispatch(link, "mouseout", { relatedTarget: dom.tableBody });
  await settle(400);
  assert.equal(tooltip.classList.contains("hidden"), true);

  // Moving inside the tooltip (map to link) is not a departure.
  await hover(dom, button);
  dispatch(dom.repeaterMapTooltipCanvasEl, "mouseout", { relatedTarget: link });
  await settle(400);
  assert.equal(tooltip.classList.contains("hidden"), false);

  // Scrolling recycles rows under the cursor, so it hides with no grace period.
  dispatch(dom.tableScrollEl, "scroll", {});
  assert.equal(tooltip.classList.contains("hidden"), true);
});

test("the map renders tiles and a marker around the repeater", async () => {
  const { dom, button, map } = await bootMap();
  dispatch(button, "click");
  await settle(0);
  const kinds = Array.from(dom.repeaterMapModalCanvasEl.children).map((child) => child.className);
  assert.ok(kinds.filter((kind) => kind === "repeater-map-tile").length >= 1);
  assert.equal(kinds.at(-1), "repeater-map-marker");
  // Tiles load in CORS mode; a plain cross-origin image is blocked under COEP
  // (FINDINGS **coep-blocks-plain-cross-origin-images**).
  for (const tile of Array.from(dom.repeaterMapModalCanvasEl.children).slice(0, -1)) {
    assert.equal(tile.crossOrigin, "anonymous");
    assert.match(tile.src, /^https:\/\/tile\.openstreetmap\.org\//);
  }
  assert.equal(dom.repeaterMapModalCoordsEl.textContent, "51.37040, 1.12890");
  map.closeModal();
});

import {
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  OSM_TILE_SIZE,
  latLonToWorldPixel,
  metresPerPixel,
  osmTileUrl,
  planStaticMap,
} from "../staticmap.js";

// The DOM half of the static OSM maps. web/js/staticmap.js does the
// projection maths and hands back a tile plan; this turns one plan into
// positioned <img> tiles with a centre marker, and builds the attribution
// strip the OSM tile policy requires on every rendered map.
//
// Two surfaces draw the same map and must draw it identically — the
// imported-channel context map (web/js/ui/repeater-map.js) and the coordinate
// preview in the repeater-query modal (web/js/ui/query-fields.js) — so the
// tile element details (crossOrigin, class names, absolute placement) live
// here once instead of being copied per caller.

// Fill a map viewport element with positioned tile images, an optional
// search-radius ring, and the centered marker. Tiles that fail to load just
// stay blank: the surrounding surface still names the coordinates, so a
// missing tile costs context, not meaning.
//
// `zoom` may be fractional. Tiles only exist at whole zooms, so the grid is
// planned at the next whole zoom up and drawn scaled down to the fraction —
// which is why every tile carries an explicit pixel size. Downscaling a
// higher-zoom tile also reads sharper than the whole zoom below would.
//
// `radiusMetres` draws a circle of that ground radius around the centre, for
// callers previewing a "repeaters within N km" search.
//
// `overscan` plans that many extra pixels of map beyond each edge, hidden by
// the viewport's own overflow. A map nobody can move needs none; a draggable
// one needs it, or the first pixel of a drag exposes blank canvas at the
// trailing edge before any redraw could cover it.
//
// `markers` are other positions to plot: { latitude, longitude, inRange?,
// approximate? }. `inRange` false dims one, so stations just outside the ring
// show what widening would add; `approximate` marks a locator-box position
// rather than a surveyed point. Drawn as squares, not dots, because half the
// RSGB directory publishes only a 4-character locator (a box ~111 km across).
export function renderStaticMap(canvasEl, geo, { zoom, width, height, radiusMetres = 0, overscan = 0, markers = [] }) {
  canvasEl.innerHTML = "";
  canvasEl.style.width = `${width}px`;
  canvasEl.style.height = `${height}px`;
  const tileZoom = Math.ceil(zoom);
  const scale = Math.pow(2, zoom - tileZoom);
  const plan = planStaticMap(geo.latitude, geo.longitude, {
    zoom: tileZoom,
    width: (width + 2 * overscan) / scale,
    height: (height + 2 * overscan) / scale,
  });
  const tileSize = OSM_TILE_SIZE * scale;
  for (const tile of plan.tiles) {
    const img = document.createElement("img");
    img.className = "repeater-map-tile";
    img.alt = "";
    img.draggable = false;
    // The dev server sends COEP: require-corp (Pyodide needs the
    // cross-origin isolation), which blocks plain cross-origin images.
    // tile.openstreetmap.org sends Access-Control-Allow-Origin: *, so a
    // CORS-mode load satisfies COEP where a no-cors one is blocked.
    img.crossOrigin = "anonymous";
    // The plan is centred on the padded viewport, so shifting every tile back
    // by the overscan lands the coordinate in the middle of the real one.
    img.style.left = `${tile.left * scale - overscan}px`;
    img.style.top = `${tile.top * scale - overscan}px`;
    img.style.width = `${tileSize}px`;
    img.style.height = `${tileSize}px`;
    img.src = osmTileUrl(tile);
    canvasEl.appendChild(img);
  }
  if (Number(radiusMetres) > 0) {
    // Sized in metres, not pixels: at these radii Mercator distortion across
    // the circle is far below a pixel, so a plain CSS circle is the shape.
    const diameter = (2 * Number(radiusMetres)) / metresPerPixel(geo.latitude, zoom);
    const range = document.createElement("div");
    range.className = "repeater-map-range";
    range.style.width = `${diameter}px`;
    range.style.height = `${diameter}px`;
    canvasEl.appendChild(range);
  }
  // Drawn between the ring and the centre marker. Tallied as drawn and handed
  // back, so a caption counts what is on the map, not what was handed in.
  const drawn = { inRange: 0, outOfRange: 0 };
  if (markers.length > 0) {
    // The centre of the viewport is the centre of the map, so a marker's offset
    // from it is the difference between the two world pixels at this zoom.
    const origin = latLonToWorldPixel(geo.latitude, geo.longitude, zoom);
    // The world wraps in x: take the shorter way round the antimeridian, or a
    // repeater at 179.9°E sits a world's width from a map centred on 179.9°W.
    const worldWidth = Math.pow(2, zoom) * OSM_TILE_SIZE;
    for (const entry of markers) {
      const point = latLonToWorldPixel(entry.latitude, entry.longitude, zoom);
      let dx = point.x - origin.x;
      if (dx > worldWidth / 2) {
        dx -= worldWidth;
      } else if (dx < -worldWidth / 2) {
        dx += worldWidth;
      }
      const left = (width / 2) + dx;
      const top = (height / 2) + (point.y - origin.y);
      // Off the viewport: a station the radius reaches but the map does not.
      // Pinned to the edge it would read as sitting on the boundary.
      if (left < 0 || top < 0 || left > width || top > height) {
        continue;
      }
      const pin = document.createElement("div");
      pin.className = "repeater-map-pin";
      if (entry.inRange === false) {
        pin.classList.add("is-out-of-range");
      }
      if (entry.approximate) {
        pin.classList.add("is-approximate");
      }
      pin.style.left = `${left}px`;
      pin.style.top = `${top}px`;
      canvasEl.appendChild(pin);
      drawn[entry.inRange === false ? "outOfRange" : "inRange"] += 1;
    }
  }
  // Last, so the point stays legible over both the tiles and the ring.
  const marker = document.createElement("div");
  marker.className = "repeater-map-marker";
  canvasEl.appendChild(marker);
  return { drawn };
}

// The OSM tile policy wants the credit to reach the licence, so the
// attribution strip under each map carries a link to the copyright page
// rather than plain text. Idempotent: a strip that already has the link is
// left alone, so a surface built once and shown many times fills it once.
export function fillMapAttribution(el) {
  if (!el || el.children?.length) {
    return;
  }
  const link = document.createElement("a");
  link.href = OSM_COPYRIGHT_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = OSM_ATTRIBUTION;
  el.appendChild(link);
}

// The same strip as an element of its own, for surfaces that build their DOM
// in script (the query modal's fields) rather than declaring it in
// web/index.html.
export function createMapAttribution() {
  const el = document.createElement("div");
  el.className = "repeater-map-attribution";
  fillMapAttribution(el);
  return el;
}

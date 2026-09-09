import {
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  OSM_TILE_SIZE,
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
export function renderStaticMap(canvasEl, geo, { zoom, width, height, radiusMetres = 0, overscan = 0 }) {
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
  // Last, so the point stays legible over both the tiles and the ring.
  const marker = document.createElement("div");
  marker.className = "repeater-map-marker";
  canvasEl.appendChild(marker);
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

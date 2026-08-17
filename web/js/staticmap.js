// Static OSM map maths: pure functions that turn a coordinate into the tile
// grid a fixed-size viewport needs, with the point dead-center. The UI module
// (web/js/ui/repeater-map.js) owns the DOM; nothing here touches it, so the
// projection and tile plan are testable headless.

export const OSM_TILE_SIZE = 256;
export const OSM_TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
// Required by the OSM tile usage policy on every rendered map.
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

// Web Mercator: coordinate -> absolute pixel position on the world map at a
// zoom level (the map is 2^zoom * 256 pixels square).
export function latLonToWorldPixel(latitude, longitude, zoom) {
  const worldSize = Math.pow(2, zoom) * OSM_TILE_SIZE;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, Number(latitude)));
  const lon = Number(longitude);
  const x = ((lon + 180) / 360) * worldSize;
  const latRad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const y = (0.5 - mercator / (2 * Math.PI)) * worldSize;
  return { x, y };
}

// Plan the tiles a width x height viewport centered on the coordinate needs.
// Tiles carry the CSS offset that puts them in place inside the (relatively
// positioned, overflow-hidden) viewport; x wraps around the antimeridian and
// rows outside the map (polar regions) are dropped.
export function planStaticMap(latitude, longitude, { zoom, width, height }) {
  const tileCount = Math.pow(2, zoom);
  const center = latLonToWorldPixel(latitude, longitude, zoom);
  const viewLeft = center.x - width / 2;
  const viewTop = center.y - height / 2;

  const firstTileX = Math.floor(viewLeft / OSM_TILE_SIZE);
  const lastTileX = Math.floor((viewLeft + width - 1) / OSM_TILE_SIZE);
  const firstTileY = Math.floor(viewTop / OSM_TILE_SIZE);
  const lastTileY = Math.floor((viewTop + height - 1) / OSM_TILE_SIZE);

  const tiles = [];
  for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
    if (tileY < 0 || tileY >= tileCount) {
      continue;
    }
    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      tiles.push({
        x: ((tileX % tileCount) + tileCount) % tileCount,
        y: tileY,
        z: zoom,
        left: Math.round(tileX * OSM_TILE_SIZE - viewLeft),
        top: Math.round(tileY * OSM_TILE_SIZE - viewTop),
      });
    }
  }
  return { width, height, tiles };
}

export function osmTileUrl(tile, template = OSM_TILE_URL_TEMPLATE) {
  return template
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

// Decimal-degree display form, e.g. "52.73774, 14.70523" (5 decimals ~ 1 m).
export function formatCoordinates(latitude, longitude) {
  return `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  OSM_EQUATOR_METRES_PER_PIXEL,
  OSM_TILE_SIZE,
  formatCoordinates,
  latLonToWorldPixel,
  metresPerPixel,
  osmTileUrl,
  planStaticMap,
  zoomForRadius,
} from "../../web/js/staticmap.js";
import { rowGeo, setRowGeo } from "../../web/js/row-geo.js";

test("latLonToWorldPixel puts 0,0 at the center of the world map", () => {
  const zoom = 3;
  const { x, y } = latLonToWorldPixel(0, 0, zoom);
  const half = (Math.pow(2, zoom) * OSM_TILE_SIZE) / 2;
  assert.ok(Math.abs(x - half) < 1e-6);
  assert.ok(Math.abs(y - half) < 1e-6);
});

test("latLonToWorldPixel matches the OSM reference tile for a known point", () => {
  // Dębno SR1D from the przemienniki sample: 52.737737, 14.705231 lands on
  // tile 4430/2678 at zoom 13 (standard slippy-map tiling).
  const { x, y } = latLonToWorldPixel(52.737737, 14.705231, 13);
  assert.equal(Math.floor(x / OSM_TILE_SIZE), 4430);
  assert.equal(Math.floor(y / OSM_TILE_SIZE), 2678);
});

test("planStaticMap centers the point and covers the viewport with tiles", () => {
  const width = 280;
  const height = 220;
  const plan = planStaticMap(52.737737, 14.705231, { zoom: 12, width, height });
  assert.equal(plan.width, width);
  assert.equal(plan.height, height);
  assert.ok(plan.tiles.length >= 2);
  for (const tile of plan.tiles) {
    // Every tile overlaps the viewport...
    assert.ok(tile.left < width && tile.left + OSM_TILE_SIZE > 0);
    assert.ok(tile.top < height && tile.top + OSM_TILE_SIZE > 0);
    // ...and carries valid tile coordinates.
    assert.ok(Number.isInteger(tile.x) && tile.x >= 0 && tile.x < Math.pow(2, 12));
    assert.ok(Number.isInteger(tile.y) && tile.y >= 0 && tile.y < Math.pow(2, 12));
  }
  // The center pixel of the viewport falls inside exactly one tile, and that
  // tile's offset places the target coordinate at the viewport center.
  const centerTile = plan.tiles.find(
    (tile) => tile.left <= width / 2 && width / 2 < tile.left + OSM_TILE_SIZE
      && tile.top <= height / 2 && height / 2 < tile.top + OSM_TILE_SIZE,
  );
  assert.ok(centerTile, "one tile must contain the viewport center");
  const world = latLonToWorldPixel(52.737737, 14.705231, 12);
  assert.equal(centerTile.x, Math.floor(world.x / OSM_TILE_SIZE));
  assert.equal(centerTile.y, Math.floor(world.y / OSM_TILE_SIZE));
});

test("planStaticMap wraps tile x across the antimeridian", () => {
  const plan = planStaticMap(0, 179.99, { zoom: 4, width: 280, height: 220 });
  const xs = plan.tiles.map((tile) => tile.x);
  assert.ok(xs.includes(15) && xs.includes(0), `expected wrap in ${xs}`);
});

test("osmTileUrl fills the template", () => {
  assert.equal(
    osmTileUrl({ x: 4429, y: 2703, z: 13 }),
    "https://tile.openstreetmap.org/13/4429/2703.png",
  );
});

test("formatCoordinates renders decimal degrees with 5 decimals", () => {
  assert.equal(formatCoordinates(52.737737, 14.705231), "52.73774, 14.70523");
  assert.equal(formatCoordinates(-33.9, -70.6), "-33.90000, -70.60000");
});

test("setRowGeo stores valid coordinates and rowGeo reads them back", () => {
  const row = {};
  setRowGeo(row, "52.737737", "14.705231");
  assert.deepEqual(rowGeo(row), { latitude: 52.737737, longitude: 14.705231 });
});

test("setRowGeo rejects missing, out-of-range and 0,0 placeholder coordinates", () => {
  for (const [lat, lon] of [[NaN, 10], ["", ""], [95, 10], [10, 200], [0, 0]]) {
    const row = {};
    setRowGeo(row, lat, lon);
    assert.equal(rowGeo(row), null, `expected no geo for ${lat},${lon}`);
  }
  assert.equal(rowGeo(null), null);
});

test("the geo sidecar never reaches header-driven serialization", async () => {
  const { serializeRowsToTsv } = await import("../../web/js/clipboard.js");
  const row = { Location: "0", Name: "SR1D" };
  setRowGeo(row, 52.737737, 14.705231);
  const tsv = serializeRowsToTsv([row]);
  assert.ok(!tsv.includes("52.737737"));
  assert.ok(!tsv.includes("__geo"));
});

test("ground resolution halves with every zoom level and shrinks away from the equator", () => {
  assert.equal(metresPerPixel(0, 0), OSM_EQUATOR_METRES_PER_PIXEL);
  assert.equal(metresPerPixel(0, 1), OSM_EQUATOR_METRES_PER_PIXEL / 2);
  // Mercator stretches the map away from the equator, so a pixel there covers
  // less ground: at 60 degrees, half as much as on the equator.
  assert.ok(Math.abs(metresPerPixel(60, 0) / metresPerPixel(0, 0) - 0.5) < 1e-9);
  // Symmetric about the equator, and the poles are clamped rather than zero.
  assert.equal(metresPerPixel(-52, 11), metresPerPixel(52, 11));
  assert.ok(metresPerPixel(90, 0) > 0);
});

test("zoomForRadius frames a circle at the requested fraction of the viewport", () => {
  const latitude = 52;
  const size = 320;
  const radiusMetres = 30000;
  const zoom = zoomForRadius(latitude, radiusMetres, size, { fill: 0.9 });
  // The circle's diameter comes out at exactly the asked-for fraction: the
  // zoom is fractional, so nothing has to be rounded away.
  const diameter = (2 * radiusMetres) / metresPerPixel(latitude, zoom);
  assert.ok(Math.abs(diameter - size * 0.9) < 1e-6, `diameter ${diameter}`);
});

test("zoomForRadius zooms in for a tighter search and out for a wider one", () => {
  const near = zoomForRadius(52, 5000, 320);
  const far = zoomForRadius(52, 200000, 320);
  assert.ok(near > far);
  // Quadrupling the area is one whole zoom level.
  const base = zoomForRadius(52, 10000, 320);
  assert.ok(Math.abs(base - zoomForRadius(52, 20000, 320) - 1) < 1e-9);
});

test("zoomForRadius stays inside its bounds and refuses inputs that are not a circle", () => {
  assert.equal(zoomForRadius(52, 20000000, 320), 1);
  assert.equal(zoomForRadius(52, 1, 320), 17);
  assert.equal(zoomForRadius(52, 5000, 320, { minZoom: 9, maxZoom: 10 }), 10);
  for (const radius of [0, -5, Number.NaN, undefined, "wide"]) {
    assert.equal(zoomForRadius(52, radius, 320), null, `radius ${radius}`);
  }
  // A viewport with no width yet is the hidden-modal case: no zoom to give.
  assert.equal(zoomForRadius(52, 30000, 0), null);
});

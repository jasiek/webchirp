// Repeater coordinates ride along on channel rows under a key that is not a
// CSV header. Everything that serializes rows (TSV clipboard, CSV export, the
// Python upload path) reads header keys only, so the sidecar never leaks into
// a codeplug; it simply disappears when a row is copied or re-imported.
const GEO_KEY = "__geo";

export function setRowGeo(row, latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!row || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return;
  }
  // Some directory entries carry a placeholder 0,0 (the gulf of Guinea) for
  // "unknown"; a map centered there would be worse than no map.
  if (lat === 0 && lon === 0) {
    return;
  }
  row[GEO_KEY] = { latitude: lat, longitude: lon };
}

export function rowGeo(row) {
  return row?.[GEO_KEY] || null;
}

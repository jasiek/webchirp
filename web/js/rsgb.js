// RSGB/ETCC UK repeater directory (https://api-beta.rsgb.online).
//
// Everything here is pure: locator maths, the square fan-out plan, dedup,
// filtering and row construction. The UI module (web/js/ui/rsgb-query.js) owns
// the modal and supplies the fetch. See FINDINGS.md **rsgb-etcc-api-shape** for
// the API's behaviour; the two rules that shape this file are that a lookup
// reports "nothing" as HTTP 200 with {"data":null} rather than an error, and
// that /locator only prefix-matches at four characters — so the fan-out is
// always over 4-character squares, never the 6-character square the user is
// standing in.

// No CORS proxy is involved: the API sends Access-Control-Allow-Origin: * on
// every response, unlike przemienniki.net and repeaterbook.com. The request
// must stay a *simple* one though (plain GET, no custom headers) — OPTIONS
// returns 405, so anything that triggers a preflight fails.
export const RSGB_API_BASE = "https://api-beta.rsgb.online";

// The directory is UK-only; the modal shows this instead of a country picker.
export const RSGB_COUNTRY_CODE = "GB";
export const RSGB_COUNTRY_LABEL = "United Kingdom";

const EARTH_RADIUS_KM = 6371.0088;
const FIELD_CODES = "ABCDEFGHIJKLMNOPQR";
const SUBSQUARE_CODES = "ABCDEFGHIJKLMNOPQRSTUVWX";

// Bands the API reports, longest wavelength first. Filtering is client-side
// (the query goes out by locator, not by band), so these are matched against
// the record's own `band` field rather than sent upstream.
export const RSGB_BANDS = [
  "40M",
  "30M",
  "20M",
  "15M",
  "10M",
  "6M",
  "4M",
  "2M",
  "70CM",
  "23CM",
  "13CM",
  "9CM",
  "6CM",
  "3CM",
  "24GHZ",
  "SHF",
];

// Voice and data modes a repeater can carry, from the API's documented flag
// table (served as HTML at the base URL). The table's remaining flags are all
// non-repeater station classes and are deliberately absent: "X" (regenerative
// node) is simplex on 429 of its 430 records, "B" (beacon) is transmit-only on
// every one, and "PX" (packet mailbox) never appears in the payload at all.
// "T" (ATV) is undocumented and its records *are* duplex repeaters, so they
// still reach the grid — there is just no checkbox to single them out.
// A handful of records carry undocumented flags (S/O/U/Y/L/I) that no option
// matches; they stay reachable because an empty mode selection means "any
// mode" rather than "none".
export const RSGB_MODES = [
  { value: "A", label: "Analogue" },
  { value: "D", label: "D-STAR" },
  { value: "F", label: "Fusion" },
  { value: "M", label: "DMR" },
  { value: "P", label: "P25" },
  { value: "N", label: "NXDN" },
  { value: "7", label: "M17" },
  { value: "E", label: "Tetra" },
];

// A radius wide enough to need more squares than this is asking for the whole
// directory; the caller is told when the plan was clipped rather than silently
// querying a subset.
const DEFAULT_MAX_SQUARES = 24;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = (Math.sin(dLat / 2) ** 2)
    + (Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * (Math.sin(dLon / 2) ** 2));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Encode a position as a Maidenhead locator. Only used for display — the query
// itself goes through squaresForRadius(), which works in square indexes.
export function encodeMaidenhead(latitude, longitude, precision = 6) {
  const lat = clamp(Number(latitude), -90, 90) + 90;
  const lon = ((Number(longitude) + 180) % 360 + 360) % 360;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return "";
  }
  const lonField = Math.min(17, Math.floor(lon / 20));
  const latField = Math.min(17, Math.floor(lat / 10));
  let locator = `${FIELD_CODES[lonField]}${FIELD_CODES[latField]}`;
  if (precision < 4) {
    return locator;
  }
  locator += `${Math.floor((lon % 20) / 2)}${Math.floor(lat % 10)}`;
  if (precision < 6) {
    return locator;
  }
  const lonSub = Math.min(23, Math.floor(((lon % 2) / 2) * 24));
  const latSub = Math.min(23, Math.floor((lat % 1) * 24));
  return `${locator}${SUBSQUARE_CODES[lonSub]}${SUBSQUARE_CODES[latSub]}`.slice(0, 6).toUpperCase();
}

// Decode a locator to the box it names, not a point. Records come at mixed
// precision — 4, 6 and 8 characters all occur, plus one 5-character oddity —
// so callers need the box to know how much slack a distance carries.
// Returns null for anything that has no valid 4-character prefix.
export function decodeMaidenheadBox(locator) {
  const text = String(locator || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (text.length < 4) {
    return null;
  }
  const lonField = FIELD_CODES.indexOf(text[0]);
  const latField = FIELD_CODES.indexOf(text[1]);
  const lonSquare = Number(text[2]);
  const latSquare = Number(text[3]);
  if (lonField < 0 || latField < 0 || !Number.isInteger(lonSquare) || !Number.isInteger(latSquare)) {
    return null;
  }

  let west = (lonField * 20) + (lonSquare * 2) - 180;
  let south = (latField * 10) + latSquare - 90;
  let lonSize = 2;
  let latSize = 1;
  let precision = 4;

  // A 5-character locator (one record carries "IO39X") has no meaning; the
  // valid 4-character prefix is kept rather than dropping the record.
  const lonSub = SUBSQUARE_CODES.indexOf(text[4] || "");
  const latSub = SUBSQUARE_CODES.indexOf(text[5] || "");
  if (text.length >= 6 && lonSub >= 0 && latSub >= 0) {
    west += lonSub * (2 / 24);
    south += latSub * (1 / 24);
    lonSize = 2 / 24;
    latSize = 1 / 24;
    precision = 6;

    const lonExt = Number(text[6]);
    const latExt = Number(text[7]);
    if (text.length >= 8 && Number.isInteger(lonExt) && Number.isInteger(latExt)) {
      west += lonExt * (lonSize / 10);
      south += latExt * (latSize / 10);
      lonSize /= 10;
      latSize /= 10;
      precision = 8;
    }
  }

  return {
    precision,
    south,
    west,
    north: south + latSize,
    east: west + lonSize,
    latitude: south + (latSize / 2),
    longitude: west + (lonSize / 2),
  };
}

// Distance to the nearest point of a locator box — a lower bound on how far the
// station actually is. Used to plan the square fan-out, not to rank records:
// ranking on it puts every station inside the searched square at 0 km, and a
// record pinned only to a 1 x 2 degree square would then outrank one measured
// at 13 km. filterRsgbRecords() judges records by their box centre instead.
export function distanceToBoxKm(latitude, longitude, box) {
  const nearestLat = clamp(latitude, box.south, box.north);
  const nearestLon = clamp(longitude, box.west, box.east);
  return haversineKm(latitude, longitude, nearestLat, nearestLon);
}

// The 4-character squares a radius touches, nearest first. Squares are 1 deg of
// latitude by 2 deg of longitude, aligned to -90/-180.
export function squaresForRadius(latitude, longitude, radiusKm, options = {}) {
  const maxSquares = Number(options.maxSquares) > 0 ? Number(options.maxSquares) : DEFAULT_MAX_SQUARES;
  const lat = Number(latitude);
  const lon = Number(longitude);
  const radius = Number(radiusKm);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius) || radius <= 0) {
    return { squares: [], truncated: false, considered: 0 };
  }

  const latDelta = radius / 111.19;
  // cos() collapses at the poles; the floor keeps the longitude span finite
  // there instead of spanning the globe.
  const lonDelta = radius / Math.max(1, 111.19 * Math.cos(toRadians(clamp(lat, -89, 89))));

  const latStart = Math.floor(clamp(lat - latDelta, -90, 89.999) + 90);
  const latEnd = Math.floor(clamp(lat + latDelta, -90, 89.999) + 90);
  const lonStart = Math.floor((lon - lonDelta + 180) / 2);
  const lonEnd = Math.floor((lon + lonDelta + 180) / 2);

  const candidates = [];
  for (let latIndex = latStart; latIndex <= latEnd; latIndex += 1) {
    for (let lonRaw = lonStart; lonRaw <= lonEnd; lonRaw += 1) {
      const lonIndex = ((lonRaw % 180) + 180) % 180;
      const locator = `${FIELD_CODES[Math.floor(lonIndex / 10)]}${FIELD_CODES[Math.floor(latIndex / 10)]}`
        + `${lonIndex % 10}${latIndex % 10}`;
      const box = decodeMaidenheadBox(locator);
      if (!box) {
        continue;
      }
      candidates.push({ locator, distanceKm: distanceToBoxKm(lat, lon, box) });
    }
  }

  const ordered = Array.from(new Map(candidates.map((entry) => [entry.locator, entry])).values())
    .filter((entry) => entry.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    squares: ordered.slice(0, maxSquares).map((entry) => entry.locator),
    truncated: ordered.length > maxSquares,
    considered: ordered.length,
  };
}

export function rsgbLocatorUrl(locator, baseUrl = RSGB_API_BASE) {
  const base = String(baseUrl || RSGB_API_BASE).trim().replace(/\/+$/, "");
  return `${base}/locator/${encodeURIComponent(String(locator || "").toUpperCase())}`;
}

// A lookup that matched nothing is HTTP 200 with {"data":null}, so the payload
// is what decides, not the status. A non-200 is still a real transport failure.
export function parseRsgbPayload(payload) {
  const data = payload?.data;
  if (data === null || data === undefined) {
    return [];
  }
  if (!Array.isArray(data)) {
    throw new Error("RSGB response had a non-array data field.");
  }
  return data;
}

// Fan out over the squares in parallel and return every record they hold.
// Squares are disjoint, so the only duplicates this can produce are the ones
// already in the source data; dedupeRsgbRecords() handles those.
export async function fetchRsgbRecords({
  squares,
  fetchImpl,
  baseUrl = RSGB_API_BASE,
  onRequest,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("No fetch implementation available for the RSGB query.");
  }
  const list = Array.from(squares || []);
  const results = await Promise.all(list.map(async (locator) => {
    const url = rsgbLocatorUrl(locator, baseUrl);
    // Deliberately header-free: adding one would force a CORS preflight, and
    // the API answers OPTIONS with 405.
    const response = await doFetch(url);
    if (!response.ok) {
      throw new Error(`RSGB query failed for ${locator}: HTTP ${response.status}`);
    }
    const records = parseRsgbPayload(await response.json());
    if (typeof onRequest === "function") {
      onRequest({ locator, url, count: records.length });
    }
    return records;
  }));
  return results.flat();
}

// `id` is the directory's only unique key. The fallback key matters for the one
// group that repeats a callsign, band and frequency; a callsign alone is not
// unique, since one holder legitimately runs several ports (GB7BSK is packet on
// 4 m, 2 m and 70 cm).
export function dedupeRsgbRecords(records) {
  const seen = new Map();
  for (const record of records || []) {
    const id = Number(record?.id);
    const key = Number.isFinite(id)
      ? `id:${id}`
      : `k:${record?.repeater}|${record?.band}|${record?.tx}|${record?.rx}`;
    if (!seen.has(key)) {
      seen.set(key, record);
    }
  }
  return Array.from(seen.values());
}

// Mode flags carry an access code for some modes ("M:1" is DMR colour code 1),
// so comparisons are on the part before the colon.
function modeFlagsOf(record) {
  return (Array.isArray(record?.modeCodes) ? record.modeCodes : [])
    .map((code) => String(code || "").split(":")[0].trim().toUpperCase())
    .filter((code) => code.length > 0);
}

// The directory is a directory of *stations*, and only some of them are
// repeaters: it also lists simplex gateways, hotspots, packet nodes and
// beacons. A repeater is a station that receives on one frequency and
// retransmits on another, so it needs two usable frequencies that differ.
//
// The `rx > 0` half is what makes this more than a `tx !== rx` test: all 36
// beacons are transmit-only and report rx as 0, so comparing the pair alone
// would call every one of them a duplex repeater with a ~145 MHz offset.
export function isRepeaterRecord(record) {
  const tx = Number(record?.tx);
  const rx = Number(record?.rx);
  return Number.isFinite(tx) && Number.isFinite(rx) && tx > 0 && rx > 0 && tx !== rx;
}

// Rank and filter. An empty band or mode selection means "any", matching the
// convention the other repeater sources use.
export function filterRsgbRecords(records, {
  latitude,
  longitude,
  radiusKm,
  bands = [],
  modes = [],
  onlyOperational = true,
} = {}) {
  const bandSet = new Set(Array.from(bands).map((band) => String(band).toUpperCase()));
  const modeSet = new Set(Array.from(modes).map((mode) => String(mode).toUpperCase()));
  const radius = Number(radiusKm);

  const entries = [];
  for (const record of records || []) {
    if (!isRepeaterRecord(record)) {
      continue;
    }
    if (onlyOperational && String(record?.status || "").toUpperCase() !== "OPERATIONAL") {
      continue;
    }
    if (bandSet.size > 0 && !bandSet.has(String(record?.band || "").toUpperCase())) {
      continue;
    }
    if (modeSet.size > 0 && !modeFlagsOf(record).some((flag) => modeSet.has(flag))) {
      continue;
    }
    // No coordinates in the payload; position comes from the locator alone.
    const box = decodeMaidenheadBox(record?.locator);
    if (!box) {
      continue;
    }
    // The box centre is the one distance that is both an honest estimate and
    // consistent with the filter: judging by the nearest corner instead admits
    // stations whose centres sit outside the radius, so a 30 km search returns
    // rows reading 33.6 km — which looks like a bug, and effectively is one.
    const distanceKm = haversineKm(latitude, longitude, box.latitude, box.longitude);
    if (Number.isFinite(radius) && radius > 0 && distanceKm > radius) {
      continue;
    }
    entries.push({
      record,
      distanceKm,
      // A 4-character locator places a station within ~111 x 130 km, so its
      // distance is an estimate the row must not present as measured.
      approximate: box.precision < 6,
    });
  }
  return entries.sort((a, b) => a.distanceKm - b.distanceKm);
}

function formatFrequencyMhz(hertz) {
  const numeric = Number(hertz);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  return (numeric / 1e6).toFixed(6);
}

// The record's modes in CHIRP terms. Analogue wins when a repeater carries both
// (most do), because an FM channel is what a mixed-mode repeater is usable as
// from a memory the grid can program.
function findRsgbMode(findEnumOption, record) {
  const flags = new Set(modeFlagsOf(record));
  const bandwidthKhz = Number(record?.txbw);
  const narrow = !Number.isFinite(bandwidthKhz) || bandwidthKhz <= 12.5;
  const analogue = narrow
    ? ["NFM", "FMN", "Narrow", "N-FM", "FM"]
    : ["FM", "Wide", "WFM"];

  if (flags.has("A")) {
    return findEnumOption("Mode", analogue, true);
  }
  const digital = [
    ["D", ["DV", "DSTAR", "D-STAR"]],
    ["F", ["C4FM", "DN", "VW", "DIG"]],
    ["M", ["DMR", "MOTOTRBO", "DIG"]],
    ["P", ["P25", "APCO25", "APCO-25", "DIG"]],
    ["N", ["NXDN", "DIG"]],
    ["7", ["M17", "DIG"]],
    ["E", ["TETRA", "DIG"]],
  ];
  for (const [flag, choices] of digital) {
    if (flags.has(flag)) {
      const match = findEnumOption("Mode", choices, true);
      if (match) {
        return match;
      }
    }
  }
  return findEnumOption("Mode", analogue, true);
}

// Build channel rows from filtered entries. `tx`/`rx` are the *repeater's*
// directions in Hz: the radio listens on `tx` and transmits on `rx`, so the
// channel frequency is `tx` and the shift is `rx - tx`. tx === rx means a
// simplex gateway or node, which is why duplex is derived from the pair rather
// than from the record's two-letter type code.
//
// A row whose frequency the selected radio cannot tune is dropped rather than
// inserted half-filled. setRowValue validates against the radio's own column
// metadata and keeps the previous value when a write is out of range, so a
// 1312 MHz ATV repeater on a 2m/70cm handheld would otherwise land in the grid
// with a blank Frequency and an accepted -63 MHz offset — a row that is not a
// channel. The caller compares lengths to report how many were left out.
export function buildRsgbRows(entries, { createBlankRow, setRowValue, findEnumOption }) {
  return entries.flatMap((entry) => {
    const record = entry?.record || entry;
    const row = createBlankRow();

    setRowValue(row, "Name", String(record?.repeater || "").trim());

    const outputHz = Number(record?.tx);
    const inputHz = Number(record?.rx);
    if (Number.isFinite(outputHz)) {
      setRowValue(row, "Frequency", formatFrequencyMhz(outputHz));
    }
    // The radio rejected the frequency: there is no channel to build here.
    if (!(Number.parseFloat(String(row.Frequency ?? "")) > 0)) {
      return [];
    }
    if (Number.isFinite(outputHz) && Number.isFinite(inputHz)) {
      const deltaHz = inputHz - outputHz;
      if (deltaHz === 0) {
        setRowValue(row, "Duplex", "");
        setRowValue(row, "Offset", "0.000000");
      } else {
        setRowValue(row, "Duplex", deltaHz < 0 ? "-" : "+");
        setRowValue(row, "Offset", formatFrequencyMhz(Math.abs(deltaHz)));
      }
    }

    // ctcss is in Hz with 0 standing for "no tone", not for 0 Hz.
    const ctcss = Number(record?.ctcss);
    if (Number.isFinite(ctcss) && ctcss > 0) {
      const toneMode = findEnumOption("Tone", ["Tone", "TSQL"], true);
      if (toneMode) {
        setRowValue(row, "Tone", toneMode);
      }
      setRowValue(row, "rToneFreq", ctcss.toFixed(1));
    }

    const mode = findRsgbMode(findEnumOption, record);
    if (mode) {
      setRowValue(row, "Mode", mode);
    }

    const distance = Number(entry?.distanceKm);
    const commentParts = [
      String(record?.town || "").trim(),
      String(record?.locator || "").trim(),
      Number.isFinite(distance)
        ? `${entry?.approximate ? "~" : ""}${distance.toFixed(1)} km`
        : "",
      String(record?.status || "").toUpperCase() === "OPERATIONAL"
        ? ""
        : String(record?.status || "").trim(),
    ].filter((part) => part.length > 0);
    setRowValue(row, "Comment", commentParts.join(" | "));

    return [row];
  });
}

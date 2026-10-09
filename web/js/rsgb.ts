// RSGB/ETCC UK repeater directory (https://api-beta.rsgb.online).
//
// Everything here is pure: locator maths, the square fan-out plan, dedup,
// filtering and row construction. The UI module (web/js/ui/repeater-query.ts) owns
// the modal and supplies the fetch. See FINDINGS.md **rsgb-etcc-api-shape** for
// the API's behaviour; the two rules that shape this file are that a lookup
// reports "nothing" as HTTP 200 with {"data":null} rather than an error, and
// that /locator only prefix-matches at four characters — so the fan-out is
// always over 4-character squares, never the 6-character square the user is
// standing in.

import { REPEATER_REQUEST_TIMEOUT_MS, withRequestTimeout } from "./request-timeout.ts";
import { NO_TONE } from "./repeater-record.ts";
import type { RepeaterMode, RepeaterRecord } from "./repeater-record.ts";
import { setHighestPower } from "./row-power.ts";
import type { RepeaterRowsResult, RowBuilderHooks, SkippedRepeater } from "./row-power.ts";
import type { ChannelRow } from "./ui/channel-values.ts";

/** A Maidenhead locator's box in degrees, its centre, and how many characters made it. */
export interface MaidenheadBox {
  precision: number;
  south: number;
  west: number;
  north: number;
  east: number;
  latitude: number;
  longitude: number;
}

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

// Every band the directory actually holds a repeater on, busiest first, so the
// two that carry 92% of them lead. Filtering is client-side (the query goes out
// by locator, not by band), so these are matched against the record's own
// `band` field rather than sent upstream.
//
// Repeater counts behind the order, measured 2026-07-31 over all 1809 records:
// 70cm 582, 2m 198, 23cm 37, 6m 21, 10m 4, 9cm 4, 3cm 3.
//
// The directory's other nine bands are omitted because no record on them is a
// repeater, so a checkbox could only ever return nothing. Two different reasons,
// worth keeping apart:
//   - 40m/30m/20m/15m: HF has no repeater allocation at all. Their 28 records
//     are packet mailboxes on 7.050/14.10/21.08 MHz, G0MBA's transmit-only
//     beacons and one APRS gateway. Permanent.
//   - 4m/13cm/6cm/24GHz/SHF: repeater-capable allocations that simply have none
//     coordinated today (4m is the notable one — 36 records, all simplex
//     gateways and nodes). **This half is a snapshot and will go stale**: if
//     ETCC coordinates a 4m repeater it stops being filterable here. It does
//     not become invisible — an empty band selection means "any band", so it
//     still reaches the grid; it just needs adding back to be selected on its
//     own. Re-measure when the directory moves.
export const RSGB_BANDS = [
  "70CM",
  "2M",
  "23CM",
  "6M",
  "10M",
  "9CM",
  "3CM",
];

// Ticked when the modal opens. The two bands that hold 780 of the directory's
// 849 repeaters, on the mode 531 of them carry — what a handheld can work
// without the user choosing anything. An unticked modal would default to every
// band and mode, which on 23cm and up is mostly gear the radio cannot tune.
export const RSGB_DEFAULT_BANDS = ["2M", "70CM"];
export const RSGB_DEFAULT_MODES = ["A"];
// Kept here rather than only in index.html's `value` so the markup and the
// reset-on-open path cannot drift apart.
export const RSGB_DEFAULT_RADIUS_KM = 30;

// The modes this import can actually produce a channel in: analogue FM, and
// D-STAR as the one digital mode of interest. Fusion, DMR, P25, NXDN, M17 and
// Tetra are all carried by the directory but are not offered — a channel row
// cannot express them usefully here, and offering them only invited the row
// builder to quietly write NFM instead.
//
// The API's remaining flags are non-repeater station classes and are absent for
// that reason: "X" (regenerative node) is simplex on 429 of its 430 records,
// "B" (beacon) is transmit-only on every one, and "PX" (packet mailbox) never
// appears in the payload at all. "T" (ATV) is undocumented and its records
// *are* duplex repeaters, so they still reach the grid — there is just no
// checkbox to single them out.
export const RSGB_MODES = [
  { value: "A", label: "Analogue" },
  { value: "D", label: "D-STAR" },
];

// A radius wide enough to need more squares than this is asking for the whole
// directory; the caller is told when the plan was clipped rather than silently
// querying a subset.
const DEFAULT_MAX_SQUARES = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = (Math.sin(dLat / 2) ** 2)
    + (Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * (Math.sin(dLon / 2) ** 2));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Encode a position as a Maidenhead locator. Only used for display — the query
// itself goes through squaresForRadius(), which works in square indexes.
export function encodeMaidenhead(latitude: number, longitude: number, precision = 6): string {
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
export function decodeMaidenheadBox(locator: unknown): MaidenheadBox | null {
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
export function distanceToBoxKm(latitude: number, longitude: number, box: MaidenheadBox): number {
  const nearestLat = clamp(latitude, box.south, box.north);
  const nearestLon = clamp(longitude, box.west, box.east);
  return haversineKm(latitude, longitude, nearestLat, nearestLon);
}

// The 4-character squares a radius touches, nearest first. Squares are 1 deg of
// latitude by 2 deg of longitude, aligned to -90/-180.
export function squaresForRadius(
  latitude: number,
  longitude: number,
  radiusKm: number,
  options: { maxSquares?: number } = {},
): { squares: string[]; truncated: boolean; considered: number } {
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

  const candidates: Array<{ locator: string; distanceKm: number }> = [];
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

export function rsgbLocatorUrl(locator: string, baseUrl: string = RSGB_API_BASE): string {
  const base = String(baseUrl || RSGB_API_BASE).trim().replace(/\/+$/, "");
  return `${base}/locator/${encodeURIComponent(String(locator || "").toUpperCase())}`;
}

// A lookup that matched nothing is HTTP 200 with {"data":null}, so the payload
// is what decides, not the status. A non-200 is still a real transport failure.
// payload is the API's JSON, whatever shape it arrived in.
export function parseRsgbPayload(payload: { data?: unknown } | null | undefined): RsgbRecord[] {
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
//
// Each square carries its own deadline, so the whole fan-out is bounded by one
// timeout rather than by their sum. A square that times out fails the entire
// query — the same as any other error here, and deliberately so: a locator
// square is a geographic tile, so dropping one silently would hand back a
// result set with an invisible hole in the middle of the search area, and the
// user would write those channels to a radio believing the missing repeaters
// simply are not there. A failed query the user can retry is the honest
// outcome; the error names the square that stalled.
/**
 * One station as the RSGB directory API returns it (tx, rx, band, mode,
 * status, locator, callsign, ...), read field by field as the API spells it.
 */
export interface RsgbRecord {
  id?: unknown;
  repeater?: unknown;
  band?: unknown;
  /** Output and input frequencies, in hertz. */
  tx?: unknown;
  rx?: unknown;
  /** Transmit bandwidth, in kHz. */
  txbw?: unknown;
  locator?: unknown;
  status?: unknown;
  town?: unknown;
  ctcss?: unknown;
  modeCodes?: unknown;
  [field: string]: unknown;
}
export interface RsgbFetchOptions {
  /** Four-character locator squares. */
  squares?: Iterable<string>;
  /** globalThis.fetch by default. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Told about each square once it has answered. */
  onRequest?: (request: {locator: string, url: string, count: number}) => void;
  /** Per square. */
  timeoutMs?: number;
}
/**
 * @returns Every record the squares hold.
 */
export async function fetchRsgbRecords({
  squares,
  fetchImpl,
  baseUrl = RSGB_API_BASE,
  onRequest,
  timeoutMs = REPEATER_REQUEST_TIMEOUT_MS,
}: RsgbFetchOptions = {}): Promise<RsgbRecord[]> {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("No fetch implementation available for the RSGB query.");
  }
  const list = Array.from(squares || []);
  const results = await Promise.all(list.map(async (locator) => {
    const url = rsgbLocatorUrl(locator, baseUrl);
    const records = await withRequestTimeout(`RSGB query for ${locator}`, async (signal) => {
      // Deliberately header-free: adding one would force a CORS preflight, and
      // the API answers OPTIONS with 405. The abort signal is not a header, so
      // the request stays a simple one.
      const response = await doFetch(url, { signal });
      if (!response.ok) {
        throw new Error(`RSGB query failed for ${locator}: HTTP ${response.status}`);
      }
      // Read inside the deadline: the response headers arriving is not the same
      // as the body arriving, and a proxy can stall between the two.
      return parseRsgbPayload(await response.json());
    }, timeoutMs);
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
export function dedupeRsgbRecords(records: readonly RsgbRecord[] | null | undefined): RsgbRecord[] {
  const seen = new Map<string, RsgbRecord>();
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
function modeFlagsOf(record: RsgbRecord | null | undefined): string[] {
  return (Array.isArray(record?.modeCodes) ? record.modeCodes as unknown[] : [])
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
export function isRepeaterRecord(record: RsgbRecord | null | undefined): boolean {
  const tx = Number(record?.tx);
  const rx = Number(record?.rx);
  return Number.isFinite(tx) && Number.isFinite(rx) && tx > 0 && rx > 0 && tx !== rx;
}

/** A record that passed the filter, with where it is and how far. */
export interface RsgbEntry {
  record: RsgbRecord;
  distanceKm: number;
  /** The distance is from a locator box's centre, not a measured position. */
  approximate: boolean;
  latitude: number;
  longitude: number;
}

export interface RsgbFilter {
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  /** Empty means any band. */
  bands?: Iterable<string>;
  /** Empty means any mode. */
  modes?: Iterable<string>;
  onlyOperational?: boolean;
}

// Rank and filter. An empty band or mode selection means "any", matching the
// convention the other repeater sources use.
export function filterRsgbRecords(records: RsgbRecord[] | null | undefined, {
  latitude,
  longitude,
  radiusKm,
  bands = [],
  modes = [],
  onlyOperational = true,
}: RsgbFilter = {}) {
  const bandSet = new Set(Array.from(bands).map((band) => String(band).toUpperCase()));
  const modeSet = new Set(Array.from(modes).map((mode) => String(mode).toUpperCase()));
  const radius = Number(radiusKm);

  const entries: RsgbEntry[] = [];
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
    // Number(): an absent centre measures NaN, as the arithmetic always did.
    const distanceKm = haversineKm(Number(latitude), Number(longitude), box.latitude, box.longitude);
    if (Number.isFinite(radius) && radius > 0 && distanceKm > radius) {
      continue;
    }
    entries.push({
      record,
      distanceKm,
      // A 4-character locator places a station within ~111 x 130 km, so its
      // distance is an estimate the row must not present as measured.
      approximate: box.precision < 6,
      // The box centre doubles as the station's position for the map sidecar
      // (buildRsgbRows below); it is the only position the payload offers.
      latitude: box.latitude,
      longitude: box.longitude,
    });
  }
  return entries.sort((a, b) => a.distanceKm - b.distanceKm);
}

// What each API mode flag is as a RepeaterMode, and the order a record's modes
// are listed in when the query did not ask for one: analogue first, because an
// FM channel is what a mixed-mode repeater is usable as from a memory the grid
// can program. "A" is resolved per record (narrow or wide FM, from `txbw`).
// Everything else reads as "other": "X" (regenerative node), "B" (beacon) and
// "PX" (packet mailbox) are station classes rather than modes, and "T" is
// undocumented -- its records look like ATV, but the API does not say so, and
// a guess would be offered to the grid as a Mode it has to refuse.
const RSGB_FLAG_MODES: ReadonlyArray<[string, RepeaterMode]> = [
  ["D", "D-STAR"],
  ["F", "Fusion"],
  ["M", "DMR"],
  ["P", "P25"],
  ["N", "NXDN"],
  ["7", "M17"],
  ["E", "TETRA"],
];

// Analogue FM is narrow unless the record says its transmit bandwidth is wider
// than 12.5 kHz; a record without `txbw` is taken as narrow, the UK 2m/70cm
// channel width.
function rsgbAnalogueMode(record: RsgbRecord): RepeaterMode {
  const bandwidthKhz = Number(record?.txbw);
  return Number.isFinite(bandwidthKhz) && bandwidthKhz > 12.5 ? "FM" : "NFM";
}

// A record's modes in the order the builder should try them. Two records carry
// no mode codes at all; they are the analogue voice repeaters their type says
// they are, rather than records dropped for a field the directory never filled.
function rsgbModesOf(record: RsgbRecord): RepeaterMode[] {
  const flags = new Set(modeFlagsOf(record));
  if (flags.size === 0 || flags.has("A")) {
    const modes: RepeaterMode[] = [rsgbAnalogueMode(record)];
    if (flags.size === 0) {
      return modes;
    }
    flags.delete("A");
    return modes.concat(rsgbFlaggedModes(flags));
  }
  return rsgbFlaggedModes(flags);
}

// The non-analogue flags as modes, in RSGB_FLAG_MODES order, with anything
// unknown read as one trailing "other".
function rsgbFlaggedModes(flags: Set<string>): RepeaterMode[] {
  const modes = RSGB_FLAG_MODES.filter(([flag]) => flags.has(flag)).map(([, mode]) => mode);
  const known = new Set(RSGB_FLAG_MODES.map(([flag]) => flag));
  if (Array.from(flags).some((flag) => !known.has(flag))) {
    modes.push("other");
  }
  return modes;
}

// The query's mode selection (API flags, "A" and "D" today) as RepeaterModes,
// for buildRepeaterRows' preferredModes, so a D-STAR search gets the DV side
// of a mixed-mode repeater rather than its FM one. "A" stands for analogue at
// either width.
export function rsgbPreferredModes(flags: Iterable<string>): RepeaterMode[] {
  const modes: RepeaterMode[] = [];
  for (const flag of Array.from(flags).map((value) => String(value).split(":")[0].trim().toUpperCase())) {
    if (flag === "A") {
      modes.push("NFM", "FM");
    } else {
      const match = RSGB_FLAG_MODES.find(([known]) => known === flag);
      if (match) {
        modes.push(match[1]);
      }
    }
  }
  return modes;
}

// The RSGB parser's second half: one record (or a filterRsgbRecords entry,
// which adds the distance and the locator-box position) as a RepeaterRecord,
// or null when it has no usable output frequency. `tx`/`rx` are the
// *repeater's* directions in Hz (FINDINGS.md **rsgb-record-semantics**): the
// radio listens on `tx` and transmits on `rx`, and tx === rx is a simplex
// gateway or node. `ctcss` is the access tone, 0 meaning none. There are no
// coordinates; the position is the locator box's centre, approximate when the
// box is coarser than six characters.
export function rsgbToRepeaterRecord(entry: RsgbEntry | RsgbRecord): RepeaterRecord | null {
  const isEntry = typeof (entry as Partial<RsgbEntry>)?.record === "object" && (entry as RsgbEntry).record !== null;
  const record = (isEntry ? (entry as RsgbEntry).record : entry) as RsgbRecord;
  const outputHz = Number(record?.tx);
  if (!Number.isInteger(outputHz) || outputHz <= 0) {
    return null;
  }
  const inputHz = Number(record?.rx);
  const ctcss = Number(record?.ctcss);
  const box = isEntry ? null : decodeMaidenheadBox(record?.locator);
  const latitude = isEntry ? (entry as RsgbEntry).latitude : box?.latitude;
  const longitude = isEntry ? (entry as RsgbEntry).longitude : box?.longitude;
  const positioned = Number.isFinite(latitude) && Number.isFinite(longitude);
  const distanceKm = isEntry ? Number((entry as RsgbEntry).distanceKm) : Number.NaN;
  const status = String(record?.status || "").trim();
  const id = record?.id;
  return {
    name: String(record?.repeater || "").trim(),
    outputHz,
    inputHz: Number.isInteger(inputHz) && inputHz > 0 && inputHz !== outputHz ? inputHz : null,
    modes: rsgbModesOf(record),
    // Several flags, so no single spelling to report.
    modeLabel: "",
    inputTone: Number.isFinite(ctcss) && ctcss > 0 ? { kind: "ctcss", hz: ctcss } : NO_TONE,
    outputTone: NO_TONE,
    locationName: String(record?.town || "").trim(),
    latitude: positioned ? Number(latitude) : null,
    longitude: positioned ? Number(longitude) : null,
    positionApproximate: isEntry ? Boolean((entry as RsgbEntry).approximate) : (box ? box.precision < 6 : false),
    positionLocator: String(record?.locator || "").trim(),
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
    // The only remark the payload carries: a status other than OPERATIONAL.
    remarks: status.toUpperCase() === "OPERATIONAL" ? "" : status,
    link: "",
    source: "rsgb",
    sourceId: id === null || id === undefined ? "" : String(id),
    raw: record,
  };
}

function formatFrequencyMhz(hertz: unknown): string {
  const numeric = Number(hertz);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  return (numeric / 1e6).toFixed(6);
}

// What each API mode flag would have to become in the grid's Mode column. Wider
// than RSGB_MODES on purpose: those flags are not offered as filters, but the
// records still carry them, and an unfiltered query has to reason about a
// repeater whose only mode is one of them.
const MODE_FLAG_CHOICES: Readonly<Record<string, string[]>> = {
  D: ["DV", "DSTAR", "D-STAR"],
  F: ["DN", "C4FM", "VW"],
  M: ["DMR", "MOTOTRBO"],
  P: ["P25", "APCO25", "APCO-25"],
  N: ["NXDN"],
  7: ["M17"],
  E: ["TETRA"],
};

// Preference order when the query did not ask for a mode. Analogue first,
// because an FM channel is what a mixed-mode repeater is usable as from a
// memory the grid can program.
const MODE_FLAG_FALLBACK_ORDER = ["A", "D", "F", "M", "P", "N", "7", "E"];

// Resolve a record to a Mode the selected radio advertises, honouring what the
// query asked for. Returns null when nothing usable exists, which is a skip
// rather than a substitution: a D-STAR query that answered with an NFM row, or
// a DMR-only repeater written as NFM, produces a channel that cannot work the
// repeater it claims to be.
function findRsgbMode(
  findEnumOption: RowBuilderHooks["findEnumOption"],
  record: RsgbRecord,
  preferredModes: Iterable<string> = [],
): string | null {
  const flags = new Set(modeFlagsOf(record));
  const bandwidthKhz = Number(record?.txbw);
  const narrow = !Number.isFinite(bandwidthKhz) || bandwidthKhz <= 12.5;
  const analogue = narrow
    ? ["NFM", "FMN", "Narrow", "N-FM", "FM"]
    : ["FM", "Wide", "WFM"];
  const resolve = (flag: string) => (
    flag === "A"
      ? findEnumOption("Mode", analogue, true)
      : findEnumOption("Mode", MODE_FLAG_CHOICES[flag] || [], true)
  );

  // Two records carry no mode codes at all; treat them as the analogue voice
  // repeaters their type says they are rather than dropping them.
  if (flags.size === 0) {
    return findEnumOption("Mode", analogue, true) || null;
  }

  // A mode the query asked for wins over the analogue-first default — asking
  // for D-STAR and being handed the same repeater's FM side is not an answer.
  const asked = Array.from(preferredModes)
    .map((mode) => String(mode).toUpperCase())
    .filter((mode) => flags.has(mode));
  const candidates = asked.length > 0
    ? asked
    : MODE_FLAG_FALLBACK_ORDER.filter((flag) => flags.has(flag));

  for (const flag of candidates) {
    const match = resolve(flag);
    if (match) {
      return match;
    }
  }
  return null;
}

// Build channel rows from filtered entries. `tx`/`rx` are the *repeater's*
// directions in Hz: the radio listens on `tx` and transmits on `rx`, so the
// channel frequency is `tx` and the shift is `rx - tx`. tx === rx means a
// simplex gateway or node, which is why duplex is derived from the pair rather
// than from the record's two-letter type code.
//
// Returns `{ rows, skipped }`. A repeater the selected radio cannot express is
// left out rather than written as something it is not, and `skipped` carries a
// reason per record so the caller can say which and why:
//   - "frequency": setRowValue validates against the radio's own column
//     metadata and keeps the previous value when a write is out of range, so a
//     1312 MHz ATV repeater on a 2m/70cm handheld would otherwise land in the
//     grid with a blank Frequency and an accepted -63 MHz offset.
//   - "mode": the radio advertises no Mode the repeater can be worked in — a
//     D-STAR-only repeater on an FM-only set. Writing NFM there produces a
//     channel that cannot work the repeater whose name it carries.
//   - "tone": the radio's tone table has no such CTCSS frequency (or it offers
//     no tone mode at all), so the access tone cannot be sent and the repeater
//     never opens. `tone` carries the frequency the directory published.
//
// `modes` is the query's own mode selection, so a D-STAR search gets the DV
// side of a mixed A/D repeater rather than its analogue one.
export function buildRsgbRows(
  entries: ReadonlyArray<RsgbEntry | RsgbRecord>,
  { createBlankRow, setRowValue, findEnumOption }: RowBuilderHooks,
  { modes = [] }: { modes?: Iterable<string> } = {},
): RepeaterRowsResult {
  const rows: ChannelRow[] = [];
  const skipped: SkippedRepeater[] = [];
  for (const entry of entries) {
    // An entry from filterRsgbRecords() carries its record; a bare record is
    // its own.
    const record = ((entry as Partial<RsgbEntry>)?.record || entry) as RsgbRecord;
    const row = createBlankRow();
    const name = String(record?.repeater || "").trim();

    setRowValue(row, "Name", name);

    const outputHz = Number(record?.tx);
    const inputHz = Number(record?.rx);
    if (Number.isFinite(outputHz)) {
      setRowValue(row, "Frequency", formatFrequencyMhz(outputHz));
    }
    if (!(Number.parseFloat(String(row.Frequency ?? "")) > 0)) {
      skipped.push({ repeater: name, reason: "frequency" });
      continue;
    }

    const mode = findRsgbMode(findEnumOption, record, modes);
    if (mode === null) {
      skipped.push({ repeater: name, reason: "mode" });
      continue;
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
    //
    // The tone goes in before the mode that encodes it, and the mode is
    // committed only once setRowValue says the tone itself was accepted. A
    // driver whose tone table lacks the directory's value — a reduced table,
    // or a mistyped record — otherwise takes the enum fallback and lands on
    // the first tone in the list, so the row would claim Tone 67.0 Hz and key
    // nothing (issue #104). Without its access tone the channel cannot work
    // the repeater at all, so the record is left out with a reason rather than
    // inserted as something it is not.
    const ctcss = Number(record?.ctcss);
    if (Number.isFinite(ctcss) && ctcss > 0) {
      const toneMode = findEnumOption("Tone", ["Tone", "TSQL"], true);
      if (!toneMode || !setRowValue(row, "rToneFreq", ctcss.toFixed(1))) {
        skipped.push({ repeater: name, reason: "tone", tone: ctcss.toFixed(1) });
        continue;
      }
      setRowValue(row, "Tone", toneMode);
    }

    setRowValue(row, "Mode", mode);

    // These are repeater channels, so the radio is reaching for a distant
    // machine: the highest tier the driver advertises is the only sensible
    // default. The ranking lives in web/js/row-power.ts because every repeater
    // directory needs the same answer.
    setHighestPower(row, { setRowValue, findEnumOption });

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

    rows.push(row);
  }
  return { rows, skipped };
}

// The one shape every repeater directory is read into.
//
// przemienniki.net, RepeaterBook and IRTS answer in RXF XML (web/js/rxf.ts);
// the RSGB/ETCC directory answers in its own JSON (web/js/rsgb.ts). Each wire
// format has one parser, and each parser ends here: a RepeaterRecord carries
// what the row builder (buildRepeaterRows, web/js/repeater-rows.ts) and the
// maps (the query preview in web/js/ui/repeater-sources.ts, the hover map in
// web/js/ui/repeater-map.ts) need, normalized so that nothing downstream has
// to know which directory answered. Frequencies are integer hertz, so the one
// conversion to the grid's MHz text happens once, in formatMhz below.
//
// Adding a fifth directory is two steps and touches nothing else: write a
// parser from its wire format into RepeaterRecord (keep the source's raw
// record on `raw`, and report an entry that cannot become a record -- one with
// no usable output frequency -- as a SkippedRepeater instead), then register a
// RepeaterDirectoryAdapter for it in createRepeaterSources
// (web/js/ui/repeater-sources.ts): its form fields, and a query() that fetches
// and returns the records. Rows, the preview map, skip reporting and the
// status line come from the shared code. tests/channels/repeater-adapters.mjs
// runs every registered adapter against a fixture and checks the invariants
// repeaterRecordProblem() states, so a new adapter joins its table.

/**
 * Every mode a directory reports, as spelled across the four sources
 * (FINDINGS.md **repeater-record-modes**). FM and NFM are both analogue FM:
 * NFM is a channel the directory says is narrow (RSGB's 12.5 kHz `txbw`),
 * FM one it says is wide or does not say. "other" is a mode the directory
 * named that is none of these; `modeLabel` keeps its spelling.
 */
export const REPEATER_MODES = [
  "FM",
  "NFM",
  "D-STAR",
  "DMR",
  "Fusion",
  "P25",
  "NXDN",
  "M17",
  "TETRA",
  "ATV",
  "other",
] as const;

/** A repeater's operating mode, from the closed list above. */
export type RepeaterMode = typeof REPEATER_MODES[number];

/**
 * A tone in one direction. "none" is explicit, so an absent tone and an
 * unreadable one ("CSQ", "Restricted") read the same; a DCS code is its three
 * octal digits as published ("023").
 */
export type RepeaterTone =
  | { kind: "none" }
  | { kind: "ctcss"; hz: number }
  | { kind: "dcs"; code: string };

/** The tone a direction carries when the directory names none. */
export const NO_TONE: RepeaterTone = Object.freeze({ kind: "none" });

/** One repeater, as every directory parser produces it. */
export interface RepeaterRecord {
  /** The callsign, or the directory's own name for the station. */
  name: string;
  /** What the repeater transmits and the radio receives, in integer hertz. */
  outputHz: number;
  /**
   * What the radio transmits for the repeater to hear, in integer hertz;
   * null for a simplex station. Never equal to outputHz.
   */
  inputHz: number | null;
  /**
   * The modes the repeater can be worked in, most preferred first; never
   * empty. A directory that lists several (RSGB) keeps its own order.
   */
  modes: RepeaterMode[];
  /**
   * The directory's own spelling of the mode, upper-cased, for diagnostics
   * and for an "other" mode; "" when it lists several.
   */
  modeLabel: string;
  /** The tone the radio transmits (the access tone). */
  inputTone: RepeaterTone;
  /** The tone the repeater transmits, which the radio may squelch on. */
  outputTone: RepeaterTone;
  /** The place the directory names, "" when it names none. */
  locationName: string;
  /** WGS84 degrees, in range, or both null when there is no position. */
  latitude: number | null;
  longitude: number | null;
  /** The position is the centre of a coarse locator box, not a surveyed point. */
  positionApproximate: boolean;
  /**
   * The Maidenhead locator the position was decoded from; "" when the
   * directory published coordinates (or nothing).
   */
  positionLocator: string;
  /** How far the query's position is, in km; null when the directory did not say. */
  distanceKm: number | null;
  /** Free text the directory attaches (remarks, a non-operational status). */
  remarks: string;
  /** A page about this repeater, "" when there is none. */
  link: string;
  /** The adapter id of the directory it came from. */
  source: string;
  /** The directory's own key for the record, "" when it has none. */
  sourceId: string;
  /** The record as the directory sent it, for debugging only. */
  raw: unknown;
}

// Integer hertz as the grid's Frequency/Offset text: MHz with six decimals,
// the precision CHIRP's own CSV uses. This is the one place a directory
// frequency is formatted; both row builders used to carry a copy, one taking
// MHz and one taking Hz.
export function formatMhz(hz: number): string {
  return (hz / 1e6).toFixed(6);
}

// A frequency in MHz (a number or its text) as integer hertz, or null when it
// is not a usable one. Rounding to the hertz absorbs the float noise of a
// decimal MHz value (145.6125 * 1e6 is not exactly an integer), and the >0
// rule matches parseQrgMhz in web/js/rxf.ts: no repeater works on 0 Hz.
export function mhzToHz(mhz: unknown): number | null {
  const numeric = Number(mhz);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric * 1e6);
}

// A CTCSS tone as the text the grid's tone columns hold. CHIRP's tone tables
// spell every tone with one decimal ("67.0", "88.5"); the runtime also matches
// by value, so "67" was accepted before, but one spelling keeps the row
// builder's own comparisons honest.
export function formatCtcss(hz: number): string {
  return hz.toFixed(1);
}

// Why a value is not a RepeaterRecord, or "" when it is one. The invariants
// every parser has to keep, stated once so tests/channels/repeater-adapters.mjs
// can hold each registered adapter to them: integer hertz, an input that is
// absent or different, modes from the closed list, well-formed tones, and a
// position that is in range or absent as a pair.
export function repeaterRecordProblem(record: RepeaterRecord): string {
  const positiveHz = (value: unknown) => Number.isInteger(value) && Number(value) > 0;
  if (!positiveHz(record.outputHz)) {
    return `outputHz ${record.outputHz} is not a positive integer`;
  }
  if (record.inputHz !== null && (!positiveHz(record.inputHz) || record.inputHz === record.outputHz)) {
    return `inputHz ${record.inputHz} is neither null nor a different positive integer`;
  }
  if (!Array.isArray(record.modes) || record.modes.length === 0) {
    return "modes is empty";
  }
  const unknownMode = record.modes.find((mode) => !(REPEATER_MODES as readonly string[]).includes(mode));
  if (unknownMode !== undefined) {
    return `mode ${unknownMode} is not a RepeaterMode`;
  }
  for (const [label, tone] of [["inputTone", record.inputTone], ["outputTone", record.outputTone]] as const) {
    const problem = toneProblem(tone);
    if (problem) {
      return `${label}: ${problem}`;
    }
  }
  const { latitude, longitude } = record;
  if ((latitude === null) !== (longitude === null)) {
    return "latitude and longitude must be null together";
  }
  if (latitude !== null && longitude !== null) {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
        || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      return `position ${latitude},${longitude} is out of range`;
    }
  }
  if (record.distanceKm !== null && !(Number.isFinite(record.distanceKm) && record.distanceKm >= 0)) {
    return `distanceKm ${record.distanceKm} is not a non-negative number`;
  }
  for (const field of ["name", "modeLabel", "locationName", "positionLocator", "remarks", "link", "source", "sourceId"] as const) {
    if (typeof record[field] !== "string") {
      return `${field} is not a string`;
    }
  }
  return "";
}

// Why a tone is malformed, or "" when it is well formed; split out of
// repeaterRecordProblem because both directions share the rule.
function toneProblem(tone: RepeaterTone): string {
  if (tone?.kind === "none") {
    return "";
  }
  if (tone?.kind === "ctcss") {
    return Number.isFinite(tone.hz) && tone.hz > 0 ? "" : `CTCSS ${tone.hz} is not a positive frequency`;
  }
  if (tone?.kind === "dcs") {
    return /^[0-7]{3}$/.test(tone.code) ? "" : `DCS ${tone.code} is not three octal digits`;
  }
  return "unknown tone kind";
}

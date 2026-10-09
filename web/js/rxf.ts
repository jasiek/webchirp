// RXF is the XML dialect przemienniki.net publishes and api.codeplug.org
// re-serves for every directory it fronts. This is its one parser:
// parseRxfRecords reads a response into RepeaterRecords
// (web/js/repeater-record.ts) for both readers, the bulk directory query
// (web/js/ui/repeater-sources.ts) and the per-callsign hover lookup
// (web/js/callsign-lookup.ts), so the two cannot drift apart on what a <qrg>,
// a perspective or an absent element means.

import { NO_TONE, mhzToHz } from "./repeater-record.ts";
import type { RepeaterMode, RepeaterRecord, RepeaterTone } from "./repeater-record.ts";
import type { SkippedRepeater } from "./row-power.ts";

export function parseXmlDocument(xmlText: string): XMLDocument {
  const doc = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
  const parserErrorNode = doc.querySelector("parsererror");
  if (parserErrorNode) {
    throw new Error(`Invalid XML response: ${parserErrorNode.textContent?.trim() || "parsererror"}`);
  }
  return doc;
}

export function firstText(parent: ParentNode | null | undefined, selector: string): string {
  return String(parent?.querySelector(selector)?.textContent || "").trim();
}

// Read an RXF <qrg> body as a frequency in MHz, yielding NaN for anything that
// is not a usable one. Number("") is 0 rather than NaN, so a plain
// Number(firstText(...)) turned an absent or empty element into a finite 0 that
// passed every Number.isFinite guard downstream: it defeated the
// receive/transmit fallbacks (now in rxfEntryToRecord) and turned a one-sided
// entry into a bogus multi-MHz Duplex/Offset. A literal 0 in the feed is
// rejected for the same reason -- no repeater works on 0 Hz.
export function parseQrgMhz(text: string | null | undefined): number {
  const numeric = Number(text || NaN);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
}

// Read an RXF <location> as a usable coordinate pair, or null. The rejections
// are what keep a map honest: an absent or non-numeric pair says the directory
// has no position, an out-of-range one says the feed is broken, and the
// 0.000000/0.000000 placeholder is what several sources publish for "unknown"
// (GB3IC is one) -- a map centred on the Gulf of Guinea is worse than no map.
export function parseRxfLocation(repeaterEl: ParentNode): { latitude: number; longitude: number } | null {
  return usablePosition(
    Number(firstText(repeaterEl, "location > latitude") || NaN),
    Number(firstText(repeaterEl, "location > longitude") || NaN),
  );
}

// The rule parseRxfLocation applies, on numbers rather than elements, so an
// entry read elsewhere (rxfEntryToRecord's callers) is judged the same way.
function usablePosition(latitude: unknown, longitude: unknown): { latitude: number; longitude: number } | null {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (latitude === undefined || longitude === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  if (lat === 0 && lon === 0) {
    return null;
  }
  return { latitude: lat, longitude: lon };
}

/**
 * One RXF <repeater> as its elements read, before it is normalized:
 * frequencies in MHz (NaN when absent, see parseQrgMhz), tones as published.
 */
export interface RxfEntry {
  id?: string;
  qra: string;
  mode: string;
  qrgRx?: number;
  qrgTx?: number;
  qth?: string;
  remarks?: string;
  link?: string;
  ctcssRx?: string;
  ctcssTx?: string;
  /** NaN or absent when the directory published no position. */
  latitude?: number;
  longitude?: number;
}

/** Whose side an RXF feed names rx/tx from (FINDINGS.md **rxf-perspective-governs-ctcss-not-just-qrg**). */
export type RxfPerspective = "radio" | "repeater";

// Read one <repeater> element's fields.
export function readRxfEntry(repeaterEl: ParentNode): RxfEntry {
  return {
    id: firstText(repeaterEl, "id"),
    qra: firstText(repeaterEl, "qra"),
    mode: firstText(repeaterEl, "mode"),
    qrgRx: parseQrgMhz(firstText(repeaterEl, 'qrg[type="rx"]')),
    qrgTx: parseQrgMhz(firstText(repeaterEl, 'qrg[type="tx"]')),
    qth: firstText(repeaterEl, "qth"),
    remarks: firstText(repeaterEl, "remarks"),
    link: firstText(repeaterEl, "link"),
    ctcssRx: firstText(repeaterEl, 'ctcss[type="rx"]'),
    ctcssTx: firstText(repeaterEl, 'ctcss[type="tx"]'),
    latitude: Number(firstText(repeaterEl, "location > latitude") || NaN),
    longitude: Number(firstText(repeaterEl, "location > longitude") || NaN),
  };
}

// RXF mode spellings, lower-cased, as each directory publishes them
// (FINDINGS.md **repeater-record-modes**): przemienniki.net upper-cases its
// own vocabulary (FM, DSTAR, C4FM, MOTOTRBO, APCO25, M17, TETRA, ATV);
// RepeaterBook and IRTS use fm, dstar, dmr, fusion, p25, nxdn, m17, tetra.
// echolink and fmlink are FM repeaters with a network link, kept from the
// builder's old table although no feed currently sends them.
const RXF_MODES: Readonly<Record<string, RepeaterMode>> = {
  fm: "FM",
  echolink: "FM",
  fmlink: "FM",
  dstar: "D-STAR",
  "d-star": "D-STAR",
  dmr: "DMR",
  mototrbo: "DMR",
  c4fm: "Fusion",
  fusion: "Fusion",
  apco25: "P25",
  p25: "P25",
  nxdn: "NXDN",
  m17: "M17",
  tetra: "TETRA",
  atv: "ATV",
};

// Read an RXF <ctcss> body as a tone. The element is not always a CTCSS
// frequency: RepeaterBook publishes "CSQ" for carrier squelch, "Restricted"
// for a closed repeater and DCS codes such as "D023" in the very same field
// (FINDINGS.md **rxf-ctcss-is-not-always-a-ctcss-frequency**). A positive
// number is CTCSS, a D-prefixed three-digit octal code is DCS, and anything
// else is no tone -- never a tone the row would have to invent a value for.
export function rxfTone(text: unknown): RepeaterTone {
  const value = String(text ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(value) && Number(value) > 0) {
    return { kind: "ctcss", hz: Number(value) };
  }
  const dcs = /^D([0-7]{3})$/i.exec(value);
  if (dcs) {
    return { kind: "dcs", code: dcs[1] };
  }
  return NO_TONE;
}

// Normalize one entry into a RepeaterRecord, or null when it has no usable
// frequency at all (the caller reports that as a "frequency" skip). RXF's
// <perspective> labels every rx/tx pair in the feed -- frequencies and CTCSS
// alike -- as either the user's radio's or the repeater's: under "radio", rx
// is what the radio receives; under "repeater", rx is what the repeater
// receives, which is what the radio has to transmit. A one-sided entry is
// simplex on the side it gives.
export function rxfEntryToRecord(
  entry: RxfEntry,
  { perspective, source }: { perspective: RxfPerspective; source: string },
): RepeaterRecord | null {
  const fromRadio = perspective === "radio";
  const rx = mhzToHz(entry.qrgRx);
  const tx = mhzToHz(entry.qrgTx);
  const outputHz = fromRadio ? (rx ?? tx) : (tx ?? rx);
  const inputHz = fromRadio ? (tx ?? rx) : (rx ?? tx);
  if (outputHz === null) {
    return null;
  }
  const label = String(entry.mode || "").trim().toUpperCase();
  const position = usablePosition(entry.latitude, entry.longitude);
  return {
    name: String(entry.qra || "").trim(),
    outputHz,
    inputHz: inputHz === null || inputHz === outputHz ? null : inputHz,
    modes: [RXF_MODES[label.toLowerCase()] ?? "other"],
    modeLabel: label,
    // Tones carry the same perspective as the frequencies, so a repeater that
    // publishes only an access tone (the tone the repeater receives) still
    // reaches the radio as a transmitted tone.
    inputTone: rxfTone(fromRadio ? entry.ctcssTx : entry.ctcssRx),
    outputTone: rxfTone(fromRadio ? entry.ctcssRx : entry.ctcssTx),
    locationName: String(entry.qth || "").trim(),
    latitude: position?.latitude ?? null,
    longitude: position?.longitude ?? null,
    positionApproximate: false,
    // RXF positions are coordinates. The feed's <locator> is not read: the
    // comment names a locator only when the position was decoded from one.
    positionLocator: "",
    distanceKm: null,
    remarks: String(entry.remarks || "").trim(),
    link: String(entry.link || "").trim(),
    source,
    sourceId: String(entry.id || "").trim(),
    raw: entry,
  };
}

/** An RXF response read into records. */
export interface RxfRecords {
  perspective: RxfPerspective;
  records: RepeaterRecord[];
  /** Entries with no usable frequency, reported as "frequency" skips. */
  unusable: SkippedRepeater[];
}

// The RXF parser: one response body into RepeaterRecords. `source` is the
// adapter id the records are stamped with. A bulk directory answer must say
// whose side its rx/tx are named from, so a missing or unknown <perspective>
// fails the query (FINDINGS.md **irts-api-mostly-matches-the-shared-rxf-contract**);
// the per-callsign lookup passes `defaultPerspective`, because the hover map
// compares a row against both frequencies and so does not depend on it.
export function parseRxfRecords(
  xmlText: string,
  { source, defaultPerspective = null }: { source: string; defaultPerspective?: RxfPerspective | null },
): RxfRecords {
  const xmlDoc = parseXmlDocument(xmlText);
  const stated = firstText(xmlDoc, "rxf > perspective").toLowerCase();
  let perspective: RxfPerspective;
  if (stated === "radio" || stated === "repeater") {
    perspective = stated;
  } else if (defaultPerspective) {
    perspective = defaultPerspective;
  } else if (!stated) {
    throw new Error("RXF response is missing its frequency perspective.");
  } else {
    throw new Error(`RXF response has unsupported frequency perspective: ${stated}`);
  }
  const records: RepeaterRecord[] = [];
  const unusable: SkippedRepeater[] = [];
  for (const repeaterEl of Array.from(xmlDoc.querySelectorAll("repeaters > repeater"))) {
    const entry = readRxfEntry(repeaterEl);
    const record = rxfEntryToRecord(entry, { perspective, source });
    if (record) {
      records.push(record);
    } else {
      unusable.push({ repeater: String(entry.qra || "").trim(), reason: "frequency" });
    }
  }
  return { perspective, records, unusable };
}

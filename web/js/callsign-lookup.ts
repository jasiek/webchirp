import type { RepeaterRecord } from "./repeater-record.ts";
import { parseRxfRecords } from "./rxf.ts";

// Per-callsign position lookup behind the channel grid's context map
// (web/js/ui/repeater-map.ts). Hovering a Location cell asks
// api.codeplug.org/lookup/<CALLSIGN> where that repeater is, rather than the
// map reading a coordinate the import stamped onto the row -- so a map is
// available for every channel whose name is a callsign, including ones typed
// by hand, read off a radio or loaded from a .img file, not only ones this
// session imported from a directory.
//
// The 24h cache the feature depends on is the HTTP cache, not code here: the
// endpoint sends `cache-control: public, max-age=86400` on its 404s as well as
// its 200s, so a miss is remembered for a day just as firmly as a hit and a
// re-hover costs no request. The in-memory map below is only a session-scoped
// short-circuit in front of it (see LOOKUP_CACHE).

// How a callsign is spelled, and therefore which rows are worth a request.
// Two alternatives, matching the ITU prefix forms: one or two letters then the
// area digit (GB3IC, W1AW, DB0XYZ, F5ZXX), or a digit-led prefix (2E0ABC,
// 9A0ABC). Anything else -- "PMR 1", "GMRS 3", "Marine 16", a plain frequency,
// a person's name -- never reaches the network, which is what keeps a bank of
// preset channels from spending a 404 cache entry each.
const CALLSIGN_PATTERN = /^(?:[A-Z]{1,2}[0-9]{1,2}[A-Z]{1,4}|[0-9][A-Z]{1,2}[0-9]{1,2}[A-Z]{1,4})$/;

// A row's channel name as a callsign, or "" when it is not one. Upper-cased
// because the endpoint is case-sensitive: /lookup/gb3km is a 404 where
// /lookup/GB3KM is not.
export function callsignFromName(name: unknown): string {
  const text = String(name ?? "").trim().toUpperCase();
  return CALLSIGN_PATTERN.test(text) ? text : "";
}

// The usable entries in one lookup response. A lookup answers with the same
// <repeaters> list the bulk directory query returns, so it is read by the same
// RXF parser into RepeaterRecords (parseRxfRecords, web/js/rxf.ts). A callsign
// serving several machines (W1AW has two, 2 km apart) yields several records;
// each keeps both frequencies so pickLookupEntry can tell them apart. Records
// without a position are dropped here rather than filtered later, because for
// this feature a record with no coordinates is not an answer at all.
/** A repeater the per-callsign endpoint knows, with the position it is drawn at. */
export type LookupEntry = RepeaterRecord & { latitude: number; longitude: number };

export function parseLookupXml(xmlText: string): LookupEntry[] {
  // The lookup merges directories that name rx/tx from different sides, and
  // pickLookupEntry compares against both frequencies, so a response without
  // a <perspective> is still an answer here; the bulk query refuses one.
  const { records } = parseRxfRecords(xmlText, { source: "lookup", defaultPerspective: "repeater" });
  return records.filter((record): record is LookupEntry => record.latitude !== null && record.longitude !== null);
}

// Which of several same-callsign entries this row means, decided by frequency.
//
// The row's Frequency is compared against both of an entry's frequencies and
// the smaller gap wins. Comparing both sides is deliberate: <rxf> carries a
// <perspective> saying whether rx/tx are named from the repeater's point of
// view or the radio's, and the two sources behind this endpoint disagree --
// przemienniki.net answers "repeater", RepeaterBook answers "radio" -- so the
// side that holds the output frequency depends on who answered. The nearest of
// the two is the same entry either way, which is all that has to be right for a
// map.
//
// Falls back to the first entry when the row carries no usable frequency, so a
// blank or mid-edit cell still gets the directory's primary answer.
export function pickLookupEntry(entries: readonly LookupEntry[] | null | undefined, frequencyMhz: unknown): LookupEntry | null {
  const list = Array.isArray(entries) ? entries : [];
  const target = Number(frequencyMhz);
  if (list.length === 0) {
    return null;
  }
  if (!Number.isFinite(target) || target <= 0) {
    return list[0];
  }
  let best = list[0];
  let bestGap = Infinity;
  for (const entry of list) {
    for (const hz of [entry.outputHz, entry.inputHz]) {
      if (hz === null) {
        continue;
      }
      const gap = Math.abs(hz / 1e6 - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = entry;
      }
    }
  }
  return best;
}

// Shorter than the directory queries' REPEATER_REQUEST_TIMEOUT_MS: this fires
// on a pointer movement and its whole result is a tooltip nobody asked for in
// so many words, so a stalled host should stop costing anything long before a
// user would think to wonder why no map appeared.
const LOOKUP_TIMEOUT_MS = 5000;

// Build the lookup function the map surface calls. One instance per UI, so the
// cache is shared across rows and surfaces.
//
// `fetchImpl` exists for the headless tests, which have no network and need to
// count requests to prove the cache works.
/**
 * @param lookupUrl The per-callsign endpoint (RepeaterEndpoints.lookup).
 */
export function createCallsignLookup(
  lookupUrl: string,
  { fetchImpl = (input, init) => fetch(input, init) }: { fetchImpl?: typeof fetch } = {},
) {
  // Callsign -> in-flight or settled promise of that callsign's entries. It
  // serves two purposes the HTTP cache cannot: it collapses the burst of
  // hovers a pointer crossing one cell produces into a single request, and it
  // answers a re-hover with no fetch() call at all. A rejected lookup is
  // evicted so a transient network failure is retried on the next hover, while
  // an empty result (the 404 case) is kept -- "this callsign has no position"
  // is an answer, not a failure.
  const LOOKUP_CACHE = new Map<string, Promise<LookupEntry[]>>();

  async function request(callsign: string): Promise<LookupEntry[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${lookupUrl}/${encodeURIComponent(callsign)}`, {
        signal: controller.signal,
      });
      // 404 is the documented "not in any directory" answer and the reason the
      // map simply does not appear; it is not an error and must not be logged
      // or reported as one.
      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new Error(`Callsign lookup failed with HTTP ${response.status}.`);
      }
      return parseLookupXml(await response.text());
    } finally {
      clearTimeout(timer);
    }
  }

  function lookup(callsign: string): Promise<LookupEntry[]> {
    const key = callsignFromName(callsign);
    if (!key || !lookupUrl) {
      return Promise.resolve([]);
    }
    const cached = LOOKUP_CACHE.get(key);
    if (cached) {
      return cached;
    }
    const pending = request(key).catch((error) => {
      LOOKUP_CACHE.delete(key);
      throw error;
    });
    LOOKUP_CACHE.set(key, pending);
    return pending;
  }

  return { lookup };
}

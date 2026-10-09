import { withRequestTimeout } from "./request-timeout.ts";
import { highestPowerOption } from "./row-power.ts";
import type { RowBuilderHooks } from "./row-power.ts";
import type { ChannelRow } from "./ui/channel-values.ts";
import type { City } from "./ui/query-fields.ts";
import { errorFields } from "./error-details.ts";

const PMR446_FREQUENCIES_MHZ = Array.from(
  { length: 16 },
  (_, index) => (446.00625 + (index * 0.0125)).toFixed(5),
);
const FRS_FREQUENCIES_MHZ = [
  "462.56250",
  "462.58750",
  "462.61250",
  "462.63750",
  "462.66250",
  "462.68750",
  "462.71250",
  "467.56250",
  "467.58750",
  "467.61250",
  "467.63750",
  "467.66250",
  "467.68750",
  "467.71250",
  "462.55000",
  "462.57500",
  "462.60000",
  "462.62500",
  "462.65000",
  "462.67500",
  "462.70000",
  "462.72500",
];
const GMRS_CHANNELS = [
  { name: "GMRS 1", frequency: "462.56250", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 2", frequency: "462.58750", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 3", frequency: "462.61250", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 4", frequency: "462.63750", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 5", frequency: "462.66250", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 6", frequency: "462.68750", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 7", frequency: "462.71250", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "low" },
  { name: "GMRS 8", frequency: "467.56250", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 9", frequency: "467.58750", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 10", frequency: "467.61250", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 11", frequency: "467.63750", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 12", frequency: "467.66250", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 13", frequency: "467.68750", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 14", frequency: "467.71250", duplex: "", offset: "0.000000", bandwidthKhz: 12.5, powerTier: "low" },
  { name: "GMRS 15", frequency: "462.55000", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 16", frequency: "462.57500", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 17", frequency: "462.60000", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 18", frequency: "462.62500", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 19", frequency: "462.65000", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 20", frequency: "462.67500", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 21", frequency: "462.70000", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 22", frequency: "462.72500", duplex: "", offset: "0.000000", bandwidthKhz: 25, powerTier: "high" },
  // The table lists 467 MHz repeater inputs; program receive/output frequency plus +5 MHz offset for usable memories.
  { name: "GMRS 15R", frequency: "462.55000", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 16R", frequency: "462.57500", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 17R", frequency: "462.60000", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 18R", frequency: "462.62500", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 19R", frequency: "462.65000", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 20R", frequency: "462.67500", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 21R", frequency: "462.70000", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
  { name: "GMRS 22R", frequency: "462.72500", duplex: "+", offset: "5.000000", bandwidthKhz: 25, powerTier: "high" },
];

// Base URL of the API that fronts przemienniki.net, repeaterbook.com and IRTS.
// The first two upstreams don't send browser CORS headers, so their query
// features depend on a proxy that adds them. api.codeplug.org restricts its
// CORS allowlist to this app's own production origins -- https://codeplug.org
// and https://webchirp.org, exact-match and https-only -- so forks hosted
// elsewhere can point
// this at their own proxy or leave it blank to disable those two sources. IRTS
// remains available through the default API when the override is blank.
// Overridable per-deployment via a <meta name="webchirp-repeater-api-base">
// tag (see index.html and buildRepeaterEndpoints).
const DEFAULT_REPEATER_API_BASE = "https://api.codeplug.org";

// Derive the remote-directory endpoint URLs from an API base. A blank base
// disables the two proxy-dependent directories, but IRTS remains on the
// default API: that first-party route is part of the hosted app's contract and
// a transport failure should surface to the user rather than hide the action.
/** Where one repeater directory is queried: its rows and its filter metadata. */
export type DirectoryEndpoint = {apiUrl: string, metaUrl: string};
/**
 * Every remote endpoint the app queries; a directory the deployment switched
 * off is null.
 */
export interface RepeaterEndpoints {
  przemienniki: DirectoryEndpoint | null;
  repeaterbook: DirectoryEndpoint | null;
  irts: DirectoryEndpoint;
  /** The place-name gazetteer. */
  cities: string;
  /** The per-callsign position lookup. */
  lookup: string;
}
/**
 * @param apiBase Blank switches off the proxied directories.
 */
function buildRepeaterEndpoints(apiBase: string = DEFAULT_REPEATER_API_BASE): RepeaterEndpoints {
  const base = String(apiBase ?? "").trim().replace(/\/+$/, "");
  const irtsBase = base || DEFAULT_REPEATER_API_BASE;
  return {
    przemienniki: base ? {
      apiUrl: `${base}/przemienniki`,
      metaUrl: `${base}/przemienniki/meta`,
    } : null,
    repeaterbook: base ? {
      apiUrl: `${base}/repeaterbook`,
      metaUrl: `${base}/repeaterbook/meta`,
    } : null,
    irts: {
      apiUrl: `${irtsBase}/irts`,
      metaUrl: `${irtsBase}/irts/meta`,
    },
    // The gazetteer behind the Place name autocomplete. It follows the IRTS
    // rule rather than the proxy rule: it is a first-party api.codeplug.org
    // route and it is not a directory at all -- it only turns a place name into
    // the coordinate pair every source already filters by -- so a deployment
    // that blanks the base to switch off the two proxied directories keeps its
    // city lookup.
    cities: `${irtsBase}/cities`,
    // Per-callsign position lookup for the channel grid's context map
    // (web/js/callsign-lookup.ts). Same rule as cities and IRTS: a first-party
    // api.codeplug.org route rather than a proxied directory, so a deployment
    // that blanks the base to switch off przemienniki.net and RepeaterBook
    // keeps its maps.
    lookup: `${irtsBase}/lookup`,
  };
}

const REPEATER_API_BASE_META = "webchirp-repeater-api-base";

// Resolve the repeater API base for this deployment. A
// <meta name="webchirp-repeater-api-base"> tag overrides the built-in default:
// its content (a proxy base URL, or blank to disable the online-query
// features) wins when the tag is present; without the tag the default applies.
// Shared rather than owned by the query modal, because the hover map reads the
// same deployment setting and the two must not disagree about it.
export function resolveRepeaterApiBase() {
  const meta = document.querySelector(`meta[name="${REPEATER_API_BASE_META}"]`);
  if (meta) {
    return String(meta.getAttribute("content") || "").trim();
  }
  return DEFAULT_REPEATER_API_BASE;
}

// Shorter than REPEATER_REQUEST_TIMEOUT_MS because this fires on a keystroke: a
// suggestion list that arrives after the user has finished typing is worth
// nothing, and a stalled connection would only block tile requests.
const CITY_SUGGEST_TIMEOUT_MS = 4000;

// The endpoint defaults to and caps at 20 (see FINDINGS.md), so no limit is
// sent; this is the ceiling the drop-down is sized for, not a request.
const CITY_SUGGEST_MAX = 20;

// Look up place names matching `query` in the api.codeplug.org gazetteer.
// `near` is an optional { latitude, longitude } proximity hint; the endpoint
// takes lat and lon together or not at all, so a half-known position is sent
// as no hint. Results are normalized to this app's { latitude, longitude }
// shape, and an entry without a usable coordinate pair is dropped.
export async function fetchCitySuggestions(
  citiesUrl: string,
  query: string,
  near: { latitude?: number; longitude?: number } | null = null,
) {
  const text = String(query ?? "").trim();
  if (!citiesUrl || text.length === 0) {
    return [];
  }
  const url = new URL(citiesUrl);
  url.searchParams.set("q", text);
  const latitude = Number(near?.latitude);
  const longitude = Number(near?.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
  }
  // The body is read inside the deadline for the same reason every other
  // directory request reads it there: fetch() resolves on headers alone.
  const body = await withRequestTimeout("City lookup", async (signal) => {
    const response = await fetch(url.toString(), { signal });
    if (!response.ok) {
      throw new Error(`City lookup failed: HTTP ${response.status}`);
    }
    return response.text();
  }, CITY_SUGGEST_TIMEOUT_MS);
  return parseCitySuggestions(body);
}

// Number(null) and Number("") are 0, not NaN, so a missing coordinate would
// otherwise pass the finiteness check and land the city on the equator.
function coordinate(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }
  return Number(value);
}

// Split out from the fetch so the parsing is testable without a network stub.
// The endpoint reports its own failures as { error: "..." } with HTTP 200, so
// that case is checked before the result list.
export function parseCitySuggestions(jsonText: string): City[] {
  // JSON from the gazetteer: every field is checked before it is used.
  let payload: { error?: unknown; results?: unknown } | null;
  try {
    payload = JSON.parse(String(jsonText || ""));
  } catch (error) {
    throw new Error(`City lookup returned invalid JSON: ${errorFields(error).message}`);
  }
  if (payload && typeof payload.error === "string") {
    throw new Error(`City lookup failed: ${payload.error}`);
  }
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results
    .map((entry) => ({
      id: String(entry?.id ?? ""),
      name: String(entry?.name ?? "").trim(),
      region: String(entry?.region ?? "").trim(),
      country: String(entry?.country ?? "").trim(),
      countryCode: String(entry?.cc ?? "").trim().toUpperCase(),
      latitude: coordinate(entry?.lat),
      longitude: coordinate(entry?.lon),
    }))
    .filter((entry) => entry.name.length > 0
      && Number.isFinite(entry.latitude)
      && Number.isFinite(entry.longitude))
    // Only matters if the endpoint ever raises its own cap.
    .slice(0, CITY_SUGGEST_MAX);
}

export function parsePrzemiennikiMetaJson(jsonText: string): {
  countries: string[];
  bands: string[];
  modes: Array<{ value: string; label: string; title: string }>;
} {
  // JSON from the /meta endpoint: each list is checked before it is read.
  let payload: { filters?: { country?: unknown; band?: unknown; mode?: unknown } } | null;
  try {
    payload = JSON.parse(String(jsonText || "{}"));
  } catch (error) {
    throw new Error(`Invalid meta JSON response: ${errorFields(error).message}`);
  }
  const filters = payload?.filters && typeof payload.filters === "object" ? payload.filters : {};

  const countries: string[] = Array.isArray(filters.country)
    ? filters.country
      .map((value) => String(value || "").trim().toUpperCase())
      .filter((value) => /^[A-Z]{2}$/.test(value))
    : [];

  const bands: string[] = Array.isArray(filters.band)
    ? filters.band
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length > 0)
    : [];

  const modes: Array<{ value: string; label: string; title: string }> = Array.isArray(filters.mode)
    ? filters.mode
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length > 0)
      .map((value) => ({ value, label: value, title: value }))
    : [];

  return {
    countries: Array.from(new Set(countries)).sort((a, b) => a.localeCompare(b)),
    bands: Array.from(new Set(bands)).sort((a, b) => a.localeCompare(b)),
    modes: Array.from(new Map(modes.map((entry) => [entry.value, entry])).values())
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function buildPmr446Rows({ createBlankRow, setRowValue, findEnumOption }: RowBuilderHooks): ChannelRow[] {
  return PMR446_FREQUENCIES_MHZ.map((frequency, idx) => {
    const row = createBlankRow();
    setRowValue(row, "Name", `PMR ${idx + 1}`);
    setRowValue(row, "Frequency", frequency);
    setRowValue(row, "Duplex", "");
    setRowValue(row, "Offset", "0.000000");
    setRowValue(row, "Tone", "");
    setRowValue(row, "CrossMode", "Tone->Tone");
    const modeValue = findEnumOption("Mode", ["NFM", "FMN", "FM"], false);
    if (modeValue) {
      setRowValue(row, "Mode", modeValue);
    }
    const powerValue = findEnumOption("Power", ["0.5W", "500mW", "Low"], false);
    if (powerValue) {
      setRowValue(row, "Power", powerValue);
    }
    return row;
  });
}

export function buildFrsRows({ createBlankRow, setRowValue, findEnumOption }: RowBuilderHooks): ChannelRow[] {
  return FRS_FREQUENCIES_MHZ.map((frequency, idx) => {
    const row = createBlankRow();
    setRowValue(row, "Name", `FRS ${idx + 1}`);
    setRowValue(row, "Frequency", frequency);
    setRowValue(row, "Duplex", "");
    setRowValue(row, "Offset", "0.000000");
    setRowValue(row, "Tone", "");
    setRowValue(row, "CrossMode", "Tone->Tone");
    const modeValue = findEnumOption("Mode", ["NFM", "FMN", "FM"], false);
    if (modeValue) {
      setRowValue(row, "Mode", modeValue);
    }
    const powerValue = findEnumOption("Power", ["0.5W", "500mW", "Low"], false);
    if (powerValue) {
      setRowValue(row, "Power", powerValue);
    }
    return row;
  });
}

function findBandwidthMode(findEnumOption: RowBuilderHooks["findEnumOption"], bandwidthKhz: number): string {
  if (bandwidthKhz <= 12.5) {
    return findEnumOption("Mode", ["NFM", "FMN", "Narrow", "N-FM", "FM"], true);
  }
  return findEnumOption("Mode", ["FM", "Wide", "WFM"], true);
}

function findPowerTier(findEnumOption: RowBuilderHooks["findEnumOption"], powerTier: string): string {
  if (powerTier === "high") {
    return highestPowerOption(findEnumOption);
  }
  return findEnumOption("Power", ["Low", "0.5W", "500mW", "2W", "2.0W", "5W", "5.0W"], true);
}

export function buildGmrsRows({ createBlankRow, setRowValue, findEnumOption }: RowBuilderHooks): ChannelRow[] {
  return GMRS_CHANNELS.map((channel) => {
    const row = createBlankRow();
    setRowValue(row, "Name", channel.name);
    setRowValue(row, "Frequency", channel.frequency);
    setRowValue(row, "Duplex", channel.duplex);
    setRowValue(row, "Offset", channel.offset);
    setRowValue(row, "Tone", "");
    setRowValue(row, "CrossMode", "Tone->Tone");
    const modeValue = findBandwidthMode(findEnumOption, channel.bandwidthKhz);
    if (modeValue) {
      setRowValue(row, "Mode", modeValue);
    }
    const powerValue = findPowerTier(findEnumOption, channel.powerTier);
    if (powerValue) {
      setRowValue(row, "Power", powerValue);
    }
    return row;
  });
}

export {
  DEFAULT_REPEATER_API_BASE,
  buildRepeaterEndpoints,
};

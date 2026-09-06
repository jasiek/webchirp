import { setRowGeo } from "./row-geo.js";

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
// CORS allowlist to https://codeplug.org, so forks hosted elsewhere can point
// this at their own proxy or leave it blank to disable those two sources. IRTS
// remains available through the default API when the override is blank.
// Overridable per-deployment via a <meta name="webchirp-repeater-api-base">
// tag (see index.html and buildRepeaterEndpoints).
const DEFAULT_REPEATER_API_BASE = "https://api.codeplug.org";

// Derive the remote-directory endpoint URLs from an API base. A blank base
// disables the two proxy-dependent directories, but IRTS remains on the
// default API: that first-party route is part of the hosted app's contract and
// a transport failure should surface to the user rather than hide the action.
function buildRepeaterEndpoints(apiBase = DEFAULT_REPEATER_API_BASE) {
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
  };
}

function parseXmlDocument(xmlText) {
  const doc = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
  const parserErrorNode = doc.querySelector("parsererror");
  if (parserErrorNode) {
    throw new Error(`Invalid XML response: ${parserErrorNode.textContent?.trim() || "parsererror"}`);
  }
  return doc;
}

function firstText(parent, selector) {
  return String(parent?.querySelector(selector)?.textContent || "").trim();
}

function formatFrequencyMhz(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  return numeric.toFixed(6);
}

export function parsePrzemiennikiXml(xmlText) {
  const xmlDoc = parseXmlDocument(xmlText);
  const perspective = firstText(xmlDoc, "rxf > perspective").toLowerCase();
  if (!perspective) {
    throw new Error("RXF response is missing its frequency perspective.");
  }
  if (perspective !== "radio" && perspective !== "repeater") {
    throw new Error(`RXF response has unsupported frequency perspective: ${perspective}`);
  }

  const countries = Array.from(
    new Set(
      Array.from(xmlDoc.querySelectorAll("repeaters > repeater > country"))
        .map((node) => String(node.textContent || "").trim().toUpperCase())
        .filter((code) => /^[A-Z]{2}$/.test(code)),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const bands = Array.from(
    new Set(
      Array.from(xmlDoc.querySelectorAll("dictionary > item"))
        .filter((item) => firstText(item, "type").toLowerCase() === "band")
        .map((item) => {
          const description = firstText(item, "description");
          const name = firstText(item, "name");
          return (description || name).toLowerCase();
        })
        .filter((value) => value.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const modes = Array.from(
    new Set(
      Array.from(xmlDoc.querySelectorAll("dictionary > item"))
        .filter((item) => firstText(item, "type").toLowerCase() === "mode")
        .map((item) => {
          const description = firstText(item, "description");
          const name = firstText(item, "name");
          const queryValue = (name || description).toLowerCase();
          const label = description || name || queryValue;
          return JSON.stringify({ value: queryValue, label, title: label });
        }),
    ),
  )
    .map((raw) => JSON.parse(raw))
    .sort((a, b) => a.label.localeCompare(b.label));

  const repeaters = Array.from(xmlDoc.querySelectorAll("repeaters > repeater"))
    .map((repeaterEl) => {
      return {
        qra: firstText(repeaterEl, "qra"),
        mode: firstText(repeaterEl, "mode"),
        qrgRx: Number(firstText(repeaterEl, 'qrg[type="rx"]')),
        qrgTx: Number(firstText(repeaterEl, 'qrg[type="tx"]')),
        qth: firstText(repeaterEl, "qth"),
        remarks: firstText(repeaterEl, "remarks"),
        link: firstText(repeaterEl, "link"),
        ctcssRx: firstText(repeaterEl, 'ctcss[type="rx"]'),
        ctcssTx: firstText(repeaterEl, 'ctcss[type="tx"]'),
        latitude: Number(firstText(repeaterEl, "location > latitude") || NaN),
        longitude: Number(firstText(repeaterEl, "location > longitude") || NaN),
      };
    });

  return { perspective, countries, bands, modes, repeaters };
}

export function parsePrzemiennikiMetaJson(jsonText) {
  let payload;
  try {
    payload = JSON.parse(String(jsonText || "{}"));
  } catch (error) {
    throw new Error(`Invalid meta JSON response: ${error.message}`);
  }
  const filters = payload?.filters && typeof payload.filters === "object" ? payload.filters : {};

  const countries = Array.isArray(filters.country)
    ? filters.country
      .map((value) => String(value || "").trim().toUpperCase())
      .filter((value) => /^[A-Z]{2}$/.test(value))
    : [];

  const bands = Array.isArray(filters.band)
    ? filters.band
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length > 0)
    : [];

  const modes = Array.isArray(filters.mode)
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

export function buildPmr446Rows({ createBlankRow, setRowValue, findEnumOption }) {
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

export function buildFrsRows({ createBlankRow, setRowValue, findEnumOption }) {
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

function findBandwidthMode(findEnumOption, bandwidthKhz) {
  if (bandwidthKhz <= 12.5) {
    return findEnumOption("Mode", ["NFM", "FMN", "Narrow", "N-FM", "FM"], true);
  }
  return findEnumOption("Mode", ["FM", "Wide", "WFM"], true);
}

function findPowerTier(findEnumOption, powerTier) {
  if (powerTier === "high") {
    return findEnumOption("Power", ["High", "50W", "25W", "10W", "8W", "7W"], true);
  }
  return findEnumOption("Power", ["Low", "0.5W", "500mW", "2W", "2.0W", "5W", "5.0W"], true);
}

export function buildGmrsRows({ createBlankRow, setRowValue, findEnumOption }) {
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

// Returns `{ rows, skipped }`. A repeater the selected radio cannot express is
// left out rather than written as something it is not, and `skipped` carries a
// reason per record — "frequency" (outside the driver's valid_bands) or "mode"
// (the radio advertises no Mode the repeater can be worked in) — so the caller
// can say which and why. Same contract as buildRsgbRows in web/js/rsgb.js.
export function buildPrzemiennikiRows(
  repeaters,
  { createBlankRow, setRowValue, findEnumOption },
  { perspective = "repeater" } = {},
) {
  const rows = [];
  const skipped = [];
  // RXF's <perspective> labels every rx/tx pair in the feed - frequencies and
  // CTCSS alike - as either the user's radio's or the repeater's. Under
  // "radio", rx is what the radio receives; under "repeater", rx is what the
  // repeater receives, which is what the radio has to transmit.
  const fromRadio = perspective === "radio";
  for (const repeater of repeaters) {
    const row = createBlankRow();
    // Normalize the labelled pair into a CHIRP memory's receive/transmit pair.
    const receiveFrequency = fromRadio
      ? (Number.isFinite(repeater.qrgRx) ? repeater.qrgRx : repeater.qrgTx)
      : (Number.isFinite(repeater.qrgTx) ? repeater.qrgTx : repeater.qrgRx);
    const transmitFrequency = fromRadio
      ? (Number.isFinite(repeater.qrgTx) ? repeater.qrgTx : repeater.qrgRx)
      : (Number.isFinite(repeater.qrgRx) ? repeater.qrgRx : repeater.qrgTx);
    // Tones carry the same perspective as the frequencies, so a repeater that
    // publishes only an access tone (the tone the repeater receives) still has
    // to reach the radio as rToneFreq plus a Tone mode - map it to cToneFreq
    // and the radio silently never sends it.
    const transmitTone = fromRadio ? repeater.ctcssTx : repeater.ctcssRx;
    const receiveTone = fromRadio ? repeater.ctcssRx : repeater.ctcssTx;

    setRowValue(row, "Name", repeater.qra);
    const commentParts = [repeater.qth, repeater.remarks, repeater.link].filter((part) => String(part || "").trim());
    setRowValue(row, "Comment", commentParts.join(" | "));

    if (Number.isFinite(receiveFrequency)) {
      setRowValue(row, "Frequency", formatFrequencyMhz(receiveFrequency));
    }
    // setRowValue validates against the selected radio's own column metadata
    // and keeps the previous value when a write falls outside valid_bands, so
    // a 70cm repeater on a 2m-only radio would otherwise reach the grid with a
    // blank Frequency and an accepted -7.6 MHz Offset (Offset is exempt from
    // the band check). A blank Frequency is not merely a bad row: on upload
    // _apply_rows_to_radio_instance reads it as "erase this memory".
    if (!(Number.parseFloat(String(row.Frequency ?? "")) > 0)) {
      skipped.push({ repeater: String(repeater.qra || "").trim(), reason: "frequency" });
      continue;
    }
    if (Number.isFinite(receiveFrequency) && Number.isFinite(transmitFrequency)) {
      const delta = transmitFrequency - receiveFrequency;
      if (Math.abs(delta) < 0.0000005) {
        setRowValue(row, "Duplex", "");
        setRowValue(row, "Offset", "0.000000");
      } else {
        setRowValue(row, "Duplex", delta < 0 ? "-" : "+");
        setRowValue(row, "Offset", formatFrequencyMhz(Math.abs(delta)));
      }
    }

    if (transmitTone) {
      const toneMode = findEnumOption("Tone", ["Tone", "TSQL"], true);
      if (toneMode) {
        setRowValue(row, "Tone", toneMode);
      }
      setRowValue(row, "rToneFreq", transmitTone);
    }
    if (receiveTone) {
      setRowValue(row, "cToneFreq", receiveTone);
    }

    const modeMappings = {
      FM: ["FM", "NFM", "FMN"],
      DSTAR: ["DV", "DSTAR", "D-STAR"],
      ATV: ["ATV"],
      ECHOLINK: ["ECHOLINK", "FM", "NFM", "FMN"],
      DMR: ["DMR", "MOTOTRBO"],
      MOTOTRBO: ["DMR", "MOTOTRBO"],
      APCO25: ["P25", "APCO25", "APCO-25"],
      C4FM: ["C4FM", "DN", "VW"],
      FUSION: ["DN", "C4FM", "VW"],
      FMLINK: ["FM", "NFM", "FMN"],
      TETRA: ["TETRA"],
      M17: ["M17"],
    };
    const mode = String(repeater.mode || "").trim().toUpperCase();
    const mappedMode = findEnumOption("Mode", modeMappings[mode] || [mode], true);
    if (!mappedMode) {
      skipped.push({ repeater: String(repeater.qra || "").trim(), reason: "mode", mode });
      continue;
    }
    setRowValue(row, "Mode", mappedMode);
    setRowGeo(row, repeater.latitude, repeater.longitude);
    rows.push(row);
  }
  return { rows, skipped };
}

export {
  DEFAULT_REPEATER_API_BASE,
  buildRepeaterEndpoints,
};

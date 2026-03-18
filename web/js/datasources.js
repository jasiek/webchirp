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

const PRZEMIENNIKI_API_URL = "https://api.codeplug.org/przemienniki";
const PRZEMIENNIKI_META_URL = "https://api.codeplug.org/przemienniki/meta";

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
      };
    });

  return { countries, bands, modes, repeaters };
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

export function buildPrzemiennikiRows(repeaters, { createBlankRow, setRowValue, findEnumOption }) {
  return repeaters.map((repeater) => {
    const row = createBlankRow();
    const receiveFrequency = Number.isFinite(repeater.qrgTx) ? repeater.qrgTx : repeater.qrgRx;
    const transmitFrequency = Number.isFinite(repeater.qrgRx) ? repeater.qrgRx : repeater.qrgTx;

    setRowValue(row, "Name", repeater.qra);
    const commentParts = [repeater.qth, repeater.remarks, repeater.link].filter((part) => String(part || "").trim());
    setRowValue(row, "Comment", commentParts.join(" | "));

    if (Number.isFinite(receiveFrequency)) {
      setRowValue(row, "Frequency", formatFrequencyMhz(receiveFrequency));
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

    if (repeater.ctcssTx) {
      const toneMode = findEnumOption("Tone", ["Tone", "TSQL"], true);
      if (toneMode) {
        setRowValue(row, "Tone", toneMode);
      }
      setRowValue(row, "rToneFreq", repeater.ctcssTx);
    }
    if (repeater.ctcssRx) {
      setRowValue(row, "cToneFreq", repeater.ctcssRx);
    }

    const modeMappings = {
      FM: ["FM", "NFM", "FMN"],
      DSTAR: ["DV", "DSTAR", "D-STAR"],
      ATV: ["ATV"],
      ECHOLINK: ["ECHOLINK", "FM", "NFM", "FMN"],
      MOTOTRBO: ["DMR", "MOTOTRBO", "DIG"],
      APCO25: ["P25", "APCO25", "APCO-25", "DIG"],
      C4FM: ["C4FM", "DN", "VW", "DIG"],
      FMLINK: ["FM", "NFM", "FMN"],
      TETRA: ["TETRA", "DIG"],
      M17: ["M17", "DIG"],
    };
    const mode = String(repeater.mode || "").trim().toUpperCase();
    const mappedMode = findEnumOption("Mode", modeMappings[mode] || [mode], true);
    if (mappedMode) {
      setRowValue(row, "Mode", mappedMode);
    }
    return row;
  });
}

export { PRZEMIENNIKI_API_URL, PRZEMIENNIKI_META_URL };

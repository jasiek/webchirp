const PMR446_FREQUENCIES_MHZ = Array.from(
  { length: 16 },
  (_, index) => (446.00625 + (index * 0.0125)).toFixed(5),
);

const PRZEMIENNIKI_API_URL = "https://api.codeplug.org/przemienniki";

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

export { PRZEMIENNIKI_API_URL };

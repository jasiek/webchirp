// RXF is the XML dialect przemienniki.net publishes and api.codeplug.org
// re-serves for every directory it fronts. Two readers parse it: the bulk
// directory query (web/js/datasources.js) and the per-callsign hover lookup
// (web/js/callsign-lookup.js). These are the primitives they share, kept here
// so the two cannot drift apart on what a <qrg> or an absent element means.

export function parseXmlDocument(xmlText) {
  const doc = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
  const parserErrorNode = doc.querySelector("parsererror");
  if (parserErrorNode) {
    throw new Error(`Invalid XML response: ${parserErrorNode.textContent?.trim() || "parsererror"}`);
  }
  return doc;
}

export function firstText(parent, selector) {
  return String(parent?.querySelector(selector)?.textContent || "").trim();
}

// Read an RXF <qrg> body as a frequency in MHz, yielding NaN for anything that
// is not a usable one. Number("") is 0 rather than NaN, so a plain
// Number(firstText(...)) turned an absent or empty element into a finite 0 that
// passed every Number.isFinite guard downstream: it defeated the
// receive/transmit fallbacks in buildPrzemiennikiRows and turned a one-sided
// entry into a bogus multi-MHz Duplex/Offset. A literal 0 in the feed is
// rejected for the same reason -- no repeater works on 0 Hz.
export function parseQrgMhz(text) {
  const numeric = Number(text || NaN);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
}

// Read an RXF <location> as a usable coordinate pair, or null. The rejections
// are what keep a map honest: an absent or non-numeric pair says the directory
// has no position, an out-of-range one says the feed is broken, and the
// 0.000000/0.000000 placeholder is what several sources publish for "unknown"
// (GB3IC is one) -- a map centred on the Gulf of Guinea is worse than no map.
export function parseRxfLocation(repeaterEl) {
  const latitude = Number(firstText(repeaterEl, "location > latitude") || NaN);
  const longitude = Number(firstText(repeaterEl, "location > longitude") || NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  if (latitude === 0 && longitude === 0) {
    return null;
  }
  return { latitude, longitude };
}

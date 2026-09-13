// What each channel-grid column means, in CHIRP's own words.
//
// CHIRP writes this help text once, in DEFAULT_COLUMN_HELP
// (chirp/chirp/wxui/memedit.py), keyed by the chirp_common.Memory attribute a
// column edits; the CSV header that attribute answers to is CSVRadio.ATTR_MAP
// (chirp/chirp/drivers/generic_csv.py), which is the spelling this app's rows
// and schema use. The table below is those two composed, so a description
// here is the description the desktop editor shows for the same column.
//
// It is a copy rather than a runtime read because memedit.py imports wx at
// module scope: there is no wx in Pyodide, so the runtime can never import the
// module the strings live in, and fetching its source to parse would pull
// ~118 KB over the network for sixteen sentences. tests/build/column-docs.mjs
// re-derives this table from both CHIRP files at the pinned revision and fails
// when they disagree, which is what keeps the copy from going stale.
export const CHANNEL_COLUMN_DOCS = Object.freeze({
  Name: "Memory label (stored in radio)",
  Frequency: "Receive frequency",
  Duplex: "Transmit shift, split mode, or transmit inhibit",
  Offset: "Shift amount (or transmit frequency) controlled by duplex",
  Tone: "Tone squelch mode",
  rToneFreq: "Transmit tone",
  cToneFreq: "Transmit/receive tone for TSQL mode, else receive tone",
  DtcsCode: "Transmit/receive DTCS code for DTCS mode, else transmit code",
  DtcsPolarity: "TX-RX DTCS polarity (normal or reversed)",
  RxDtcsCode: "Receive DTCS code",
  // CHIRP's own text ends "... (starts the tone mode selection wizard)". That
  // clause describes a dialog only the desktop editor has, so it is dropped
  // here; tests/build/column-docs.mjs allows this one divergence explicitly
  // and still checks the rest of the sentence against CHIRP.
  CrossMode: "Complex or non-standard tone squelch mode",
  Mode: "Transmit/receive modulation (FM, AM, SSB, etc)",
  TStep: "Frequency granularity in kHz",
  Skip: "Scan control (skip, include, priority, etc)",
  Power: "Transmit Power",
  Comment: "Human-readable comment (not stored in radio)",
});

// The description for one grid column, or "" where CHIRP documents none --
// Location (a memory slot rather than a property of the signal) and the D-STAR
// call columns, which DEFAULT_COLUMN_HELP has never carried an entry for.
export function columnDoc(header) {
  return CHANNEL_COLUMN_DOCS[header] || "";
}

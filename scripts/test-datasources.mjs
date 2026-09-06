import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REPEATER_API_BASE,
  buildPrzemiennikiRows,
  buildRepeaterEndpoints,
} from "../web/js/datasources.js";
import { rowGeo } from "../web/js/row-geo.js";

// toneModes/crossModes stand in for the driver's valid_tmodes and
// valid_cross_modes. They are separate knobs because a real driver can offer a
// full CrossMode option list while its Tone column has no "Cross" at all —
// valid_cross_modes defaults to the complete list regardless of has_cross — and
// the builder has to gate on the Tone column rather than on CrossMode.
function rowHooks({
  modeOptions = ["FM", "DV", "DMR", "DN"],
  toneModes = ["", "Tone", "TSQL", "DTCS", "Cross"],
  crossModes = ["Tone->Tone", "->Tone", "Tone->", "DTCS->", "->DTCS"],
  maxFrequencyMhz = Infinity,
} = {}) {
  const columns = [
    "Name", "Frequency", "Duplex", "Offset",
    "Tone", "rToneFreq", "cToneFreq", "CrossMode",
    "Mode", "Comment",
  ];
  return {
    createBlankRow: () => Object.fromEntries(columns.map((column) => [column, ""])),
    setRowValue: (row, column, value) => {
      if (!columns.includes(column)) {
        return;
      }
      // normalizeValue keeps the previous value when a frequency falls outside
      // the driver's valid_bands, and Offset is exempt from that check — the
      // asymmetry this builder has to notice.
      if (column === "Frequency" && Number.parseFloat(value) > maxFrequencyMhz) {
        return;
      }
      row[column] = String(value ?? "");
    },
    findEnumOption: (column, choices) => {
      const optionsByColumn = { Mode: modeOptions, Tone: toneModes, CrossMode: crossModes };
      const options = optionsByColumn[column] || [];
      return choices.find((choice) => options.includes(choice)) || "";
    },
  };
}

// Build one repeater and hand back its row, so a tone case reads as its inputs
// and its expectations rather than as scaffolding.
function toneRow(repeater, { perspective = "repeater", ...hookOptions } = {}) {
  const { rows: [row] } = buildPrzemiennikiRows(
    [{ qra: "SRTEST", mode: "fm", qrgRx: 145.0, qrgTx: 145.6, ...repeater }],
    rowHooks(hookOptions),
    { perspective },
  );
  return row;
}

test("buildRepeaterEndpoints derives every remote source URL from a base", () => {
  const endpoints = buildRepeaterEndpoints("https://proxy.example.com");
  assert.deepEqual(endpoints, {
    przemienniki: {
      apiUrl: "https://proxy.example.com/przemienniki",
      metaUrl: "https://proxy.example.com/przemienniki/meta",
    },
    repeaterbook: {
      apiUrl: "https://proxy.example.com/repeaterbook",
      metaUrl: "https://proxy.example.com/repeaterbook/meta",
    },
    irts: {
      apiUrl: "https://proxy.example.com/irts",
      metaUrl: "https://proxy.example.com/irts/meta",
    },
  });
});

test("buildRepeaterEndpoints trims whitespace and trailing slashes", () => {
  const endpoints = buildRepeaterEndpoints("  https://proxy.example.com/  ");
  assert.equal(endpoints.przemienniki.apiUrl, "https://proxy.example.com/przemienniki");
  assert.equal(endpoints.repeaterbook.metaUrl, "https://proxy.example.com/repeaterbook/meta");
  assert.equal(endpoints.irts.apiUrl, "https://proxy.example.com/irts");
});

test("a blank proxy base disables only proxy-dependent sources", () => {
  for (const value of ["", "   ", null]) {
    assert.deepEqual(buildRepeaterEndpoints(value), {
      przemienniki: null,
      repeaterbook: null,
      irts: {
        apiUrl: "https://api.codeplug.org/irts",
        metaUrl: "https://api.codeplug.org/irts/meta",
      },
    });
  }
});

test("buildRepeaterEndpoints falls back to the default base when called with no argument", () => {
  assert.deepEqual(buildRepeaterEndpoints(undefined), buildRepeaterEndpoints(DEFAULT_REPEATER_API_BASE));
});

test("the default base points at the codeplug.org proxy", () => {
  assert.equal(DEFAULT_REPEATER_API_BASE, "https://api.codeplug.org");
  const endpoints = buildRepeaterEndpoints();
  assert.equal(endpoints.przemienniki.metaUrl, "https://api.codeplug.org/przemienniki/meta");
  assert.equal(endpoints.irts.metaUrl, "https://api.codeplug.org/irts/meta");
});

test("IRTS radio-perspective frequencies build a usable CHIRP channel", () => {
  const { rows: [row], skipped } = buildPrzemiennikiRows([
    {
      qra: "EI2TRR",
      mode: "fm",
      // The IRTS route mirrors its source table: output/user RX first,
      // input/user TX second.
      qrgRx: 145.6,
      qrgTx: 145.0,
      qth: "Three Rock, Co. Dublin",
      remarks: "Channel: RV48 / (R0)",
      link: "https://www.irts.ie/cgi/repeater.cgi",
      ctcssRx: "",
      ctcssTx: "88.5",
      latitude: 53.229167,
      longitude: -6.208333,
    },
  ], rowHooks(), { perspective: "radio" });

  assert.equal(row.Name, "EI2TRR");
  assert.equal(row.Frequency, "145.600000");
  assert.equal(row.Duplex, "-");
  assert.equal(row.Offset, "0.600000");
  assert.equal(row.Tone, "Tone");
  assert.equal(row.rToneFreq, "88.5");
  assert.equal(row.Mode, "FM");
  assert.deepEqual(rowGeo(row), { latitude: 53.229167, longitude: -6.208333 });
  assert.deepEqual(skipped, []);
});

// The tone cases below assert Tone/CrossMode as well as the frequencies,
// because a tone the mode does not encode is inert: split_tone_encode reads
// rToneFreq only under "Tone", cToneFreq only under "TSQL", and both only
// under "Cross". Feed-relative rx/tx is named per case; "transmit"/"receive"
// always mean the radio's side.

test("a repeater-perspective access tone becomes the tone the radio transmits", () => {
  // przemienniki.net labels CTCSS from the repeater's side, so type="rx" is
  // the tone the repeater listens for and the radio has to send. Reading it as
  // a receive tone leaves Tone blank and the repeater never opens. 77 of the
  // 646 live Polish records have exactly this shape.
  const row = toneRow({ ctcssRx: "88.5", ctcssTx: "" });

  assert.equal(row.Frequency, "145.600000");
  assert.equal(row.Tone, "Tone");
  assert.equal(row.rToneFreq, "88.5");
  assert.equal(row.cToneFreq, "");
});

test("a repeater-perspective tone the repeater only transmits is received, not sent", () => {
  // Tone-transmitting, carrier-access repeater (live: SR7W, SR8NP). Only Cross
  // encodes a receive tone with no transmit tone; cToneFreq alone would leave
  // Tone blank and the radio would neither send nor squelch on anything.
  const row = toneRow({ ctcssRx: "", ctcssTx: "88.5" });

  assert.equal(row.Tone, "Cross");
  assert.equal(row.CrossMode, "->Tone");
  assert.equal(row.rToneFreq, "");
  assert.equal(row.cToneFreq, "88.5");
});

test("a matching tone pair becomes TSQL, which encodes both directions", () => {
  const row = toneRow({ ctcssRx: "88.5", ctcssTx: "88.5" });

  assert.equal(row.Tone, "TSQL");
  assert.equal(row.cToneFreq, "88.5");
});

test("a split repeater-perspective pair becomes Cross with both sides swapped", () => {
  const row = toneRow({ ctcssRx: "88.5", ctcssTx: "110.9" });

  assert.equal(row.Tone, "Cross");
  assert.equal(row.CrossMode, "Tone->Tone");
  assert.equal(row.rToneFreq, "88.5");
  assert.equal(row.cToneFreq, "110.9");
});

test("radio-perspective tones keep rx as receive and tx as transmit", () => {
  const row = toneRow(
    { ctcssRx: "110.9", ctcssTx: "88.5" },
    { perspective: "radio" },
  );

  assert.equal(row.Tone, "Cross");
  assert.equal(row.CrossMode, "Tone->Tone");
  assert.equal(row.rToneFreq, "88.5");
  assert.equal(row.cToneFreq, "110.9");
});

test("a radio without Cross keeps the access tone rather than the receive tone", () => {
  // The transmit half decides whether the channel works at all, so a split
  // pair collapses onto it instead of onto the receive squelch.
  const row = toneRow(
    { ctcssRx: "88.5", ctcssTx: "110.9" },
    { toneModes: ["", "Tone", "TSQL"] },
  );

  assert.equal(row.Tone, "Tone");
  assert.equal(row.rToneFreq, "88.5");
  assert.equal(row.cToneFreq, "");
});

test("a radio without Cross still gets the receive squelch through TSQL", () => {
  // Nothing to key this repeater with, so TSQL costs only an unrequested
  // transmit tone and delivers the squelch the directory advertised.
  const row = toneRow(
    { ctcssRx: "", ctcssTx: "88.5" },
    { toneModes: ["", "Tone", "TSQL"] },
  );

  assert.equal(row.Tone, "TSQL");
  assert.equal(row.cToneFreq, "88.5");
});

test("a full CrossMode list does not imply the radio can hold a split pair", () => {
  // valid_cross_modes stays fully populated even when has_cross is false, so
  // the Tone column is the only honest gate.
  const row = toneRow(
    { ctcssRx: "88.5", ctcssTx: "110.9" },
    { toneModes: ["", "Tone", "TSQL"], crossModes: ["Tone->Tone", "->Tone"] },
  );

  assert.equal(row.Tone, "Tone");
  assert.equal(row.CrossMode, "");
});

test("a radio with only TSQL still transmits a matching pair's tone", () => {
  const row = toneRow(
    { ctcssRx: "88.5", ctcssTx: "88.5" },
    { toneModes: ["", "Tone"] },
  );

  assert.equal(row.Tone, "Tone");
  assert.equal(row.rToneFreq, "88.5");
});

test("a non-CTCSS ctcss body is no tone, not a tone mode with a default tone", () => {
  // RepeaterBook puts "CSQ", "Restricted" and DTCS codes in the same element.
  // Treating them as tones sets a tone mode whose frequency setRowValue then
  // rejects, leaving the radio transmitting a default the feed never named.
  for (const value of ["CSQ", "Restricted", "D023", "0", "  "]) {
    const row = toneRow({ ctcssRx: value, ctcssTx: "" });
    assert.equal(row.Tone, "", value);
    assert.equal(row.rToneFreq, "", value);
    assert.equal(row.cToneFreq, "", value);
  }
});

test("a CSQ on one side leaves the other side as a plain single-direction tone", () => {
  const row = toneRow({ ctcssRx: "CSQ", ctcssTx: "88.5" });

  assert.equal(row.Tone, "Cross");
  assert.equal(row.CrossMode, "->Tone");
  assert.equal(row.cToneFreq, "88.5");
});

test("a one-sided entry falls back to its known frequency instead of inventing a split", () => {
  // parseQrgMhz yields NaN for an absent <qrg>, which is what makes the
  // receive/transmit fallbacks below reachable at all. When the parser handed
  // back Number("") === 0 the fallbacks were dead and the missing side was
  // treated as a real 0 MHz frequency, so a lone 145.6 tx became Duplex "-"
  // with a 145.600000 offset (radio perspective lost the row outright).
  for (const perspective of ["repeater", "radio"]) {
    const { rows: [row], skipped } = buildPrzemiennikiRows(
      [{ qra: "SRONE", mode: "fm", qrgRx: NaN, qrgTx: 145.6 }],
      rowHooks(),
      { perspective },
    );
    assert.equal(row.Frequency, "145.600000", perspective);
    assert.equal(row.Duplex, "", perspective);
    assert.equal(row.Offset, "0.000000", perspective);
    assert.deepEqual(skipped, [], perspective);
  }
});

test("an entry with neither frequency is skipped rather than written as 0 MHz", () => {
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ qra: "SRNONE", mode: "fm", qrgRx: NaN, qrgTx: NaN }],
    rowHooks(),
    { perspective: "radio" },
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [{ repeater: "SRNONE", reason: "frequency" }]);
});

test("IRTS mode names map to CHIRP's DMR and Fusion values", () => {
  const base = { qra: "EI7TEST", qrgRx: 439.5, qrgTx: 430.5 };
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ ...base, mode: "dmr" }, { ...base, mode: "fusion" }],
    rowHooks(),
    { perspective: "radio" },
  );
  assert.deepEqual(rows.map((row) => row.Mode), ["DMR", "DN"]);
  assert.deepEqual(skipped, []);
});

test("unsupported digital modes are skipped instead of retaining FM or substituting DIG", () => {
  const base = { qra: "EI7TEST", qrgRx: 439.5, qrgTx: 430.5 };
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ ...base, mode: "dmr" }, { ...base, qra: "EI7FUS", mode: "fusion" }],
    rowHooks({ modeOptions: ["FM", "DIG"] }),
    { perspective: "radio" },
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [
    { repeater: "EI7TEST", reason: "mode", mode: "DMR" },
    { repeater: "EI7FUS", reason: "mode", mode: "FUSION" },
  ]);
});

test("a repeater outside the radio's bands is skipped, not left as a blank frequency", () => {
  const { rows, skipped } = buildPrzemiennikiRows(
    [
      { qra: "SR2m", mode: "fm", qrgRx: 145.6, qrgTx: 145.0 },
      // 70cm on a 2m-only radio: the Frequency write is refused while the
      // Offset write is accepted, so an unguarded builder emits a row with no
      // frequency and a -7.6 MHz shift — which erases a memory on upload.
      { qra: "SR70cm", mode: "fm", qrgRx: 438.6, qrgTx: 431.0 },
    ],
    rowHooks({ maxFrequencyMhz: 174 }),
    { perspective: "radio" },
  );

  assert.deepEqual(rows.map((row) => row.Name), ["SR2m"]);
  assert.deepEqual(skipped, [{ repeater: "SR70cm", reason: "frequency" }]);
});

test("a repeater with no usable frequency at all is skipped", () => {
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ qra: "SR0", mode: "fm" }],
    rowHooks(),
    { perspective: "radio" },
  );

  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [{ repeater: "SR0", reason: "frequency" }]);
});

test("an out-of-band repeater is reported as frequency, not as an unusable mode", () => {
  // The frequency guard runs before the mode lookup, so a row that fails both
  // is counted once and under the reason the user can act on.
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ qra: "SRDMR", mode: "dmr", qrgRx: 1298.0, qrgTx: 1270.0 }],
    rowHooks({ modeOptions: ["FM"], maxFrequencyMhz: 470 }),
    { perspective: "radio" },
  );

  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [{ repeater: "SRDMR", reason: "frequency" }]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REPEATER_API_BASE,
  buildPrzemiennikiRows,
  buildRepeaterEndpoints,
} from "../web/js/datasources.js";
import { rowGeo } from "../web/js/row-geo.js";

function rowHooks({ modeOptions = ["FM", "DV", "DMR", "DN"], maxFrequencyMhz = Infinity } = {}) {
  const columns = ["Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Comment"];
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
      const options = column === "Mode" ? modeOptions : ["Tone", "TSQL"];
      return choices.find((choice) => options.includes(choice)) || "";
    },
  };
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
  ], rowHooks(), { qrgPerspective: "radio" });

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

test("IRTS mode names map to CHIRP's DMR and Fusion values", () => {
  const base = { qra: "EI7TEST", qrgRx: 439.5, qrgTx: 430.5 };
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ ...base, mode: "dmr" }, { ...base, mode: "fusion" }],
    rowHooks(),
    { qrgPerspective: "radio" },
  );
  assert.deepEqual(rows.map((row) => row.Mode), ["DMR", "DN"]);
  assert.deepEqual(skipped, []);
});

test("unsupported digital modes are skipped instead of retaining FM or substituting DIG", () => {
  const base = { qra: "EI7TEST", qrgRx: 439.5, qrgTx: 430.5 };
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ ...base, mode: "dmr" }, { ...base, qra: "EI7FUS", mode: "fusion" }],
    rowHooks({ modeOptions: ["FM", "DIG"] }),
    { qrgPerspective: "radio" },
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
    { qrgPerspective: "radio" },
  );

  assert.deepEqual(rows.map((row) => row.Name), ["SR2m"]);
  assert.deepEqual(skipped, [{ repeater: "SR70cm", reason: "frequency" }]);
});

test("a repeater with no usable frequency at all is skipped", () => {
  const { rows, skipped } = buildPrzemiennikiRows(
    [{ qra: "SR0", mode: "fm" }],
    rowHooks(),
    { qrgPerspective: "radio" },
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
    { qrgPerspective: "radio" },
  );

  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [{ repeater: "SRDMR", reason: "frequency" }]);
});

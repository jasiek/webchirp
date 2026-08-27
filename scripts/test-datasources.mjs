import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REPEATER_API_BASE,
  buildPrzemiennikiRows,
  buildRepeaterEndpoints,
} from "../web/js/datasources.js";
import { rowGeo } from "../web/js/row-geo.js";

function rowHooks() {
  const columns = ["Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Comment"];
  return {
    createBlankRow: () => Object.fromEntries(columns.map((column) => [column, ""])),
    setRowValue: (row, column, value) => {
      if (columns.includes(column)) {
        row[column] = String(value ?? "");
      }
    },
    findEnumOption: (column, choices) => {
      const options = column === "Mode" ? ["FM", "DV", "DMR", "DN"] : ["Tone", "TSQL"];
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

test("buildRepeaterEndpoints returns null for a blank or null base", () => {
  assert.equal(buildRepeaterEndpoints(""), null);
  assert.equal(buildRepeaterEndpoints("   "), null);
  assert.equal(buildRepeaterEndpoints(null), null);
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
  const [row] = buildPrzemiennikiRows([
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
});

test("IRTS mode names map to CHIRP's DMR and Fusion values", () => {
  const base = { qra: "EI7TEST", qrgRx: 439.5, qrgTx: 430.5 };
  const rows = buildPrzemiennikiRows(
    [{ ...base, mode: "dmr" }, { ...base, mode: "fusion" }],
    rowHooks(),
    { qrgPerspective: "radio" },
  );
  assert.deepEqual(rows.map((row) => row.Mode), ["DMR", "DN"]);
});

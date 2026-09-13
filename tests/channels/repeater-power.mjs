import assert from "node:assert/strict";
import test from "node:test";

import { buildPrzemiennikiRows } from "../../web/js/datasources.js";
import { buildRsgbRows } from "../../web/js/rsgb.js";
import { makeRowHooks } from "../support/row-hooks.mjs";

// Every repeater directory has to answer the Power column the same way: a
// channel that reaches for a distant machine takes the driver's highest tier,
// never the blank row's default. That rule lived only in web/js/rsgb.js for a
// while, so przemienniki.net, repeaterbook.com and IRTS imports (all of them
// built by buildPrzemiennikiRows in web/js/datasources.js) arrived on whatever
// the driver happened to list first. These cases pin it for both builders, so
// a directory added later cannot quietly drop back to that.

// Low first, as roughly half of CHIRP's drivers order them, so an unwritten
// Power column is visible as "Low" rather than as the value we wanted anyway.
function rowHooks({ powerOptions = ["Low", "High"] } = {}) {
  return makeRowHooks({
    optionsByColumn: {
      Mode: ["FM", "NFM", "DV", "DMR"],
      Tone: ["", "Tone", "TSQL", "Cross"],
      Power: powerOptions,
    },
    caseInsensitive: true,
  });
}

// One plain 2m repeater, in the shape przemienniki.net/RepeaterBook/IRTS are
// normalized into before the builder sees them.
function repeater(overrides = {}) {
  return { qra: "SR5WA", mode: "fm", qrgRx: 145.0125, qrgTx: 145.6125, ...overrides };
}

// The matching RSGB record, so both builders are asked the same question.
function rsgbRecord(overrides = {}) {
  return {
    id: 199,
    status: "OPERATIONAL",
    town: "HERNE BAY",
    modeCodes: ["A"],
    tx: 145662500,
    rx: 145062500,
    txbw: 12.5,
    band: "2M",
    repeater: "GB3KI",
    locator: "JO01NI",
    ...overrides,
  };
}

test("a przemienniki-shaped repeater row carries the driver's highest power", () => {
  const { rows: [row] } = buildPrzemiennikiRows([repeater()], rowHooks());
  assert.equal(row.Power, "High");
});

test("both repeater builders resolve the same driver's power to the same value", () => {
  // The two directories share one ranked list (web/js/row-power.js). Drivers
  // spell the tiers differently enough that a second, drifting copy of it
  // would show up here as a disagreement.
  for (const powerOptions of [
    ["Low", "High"],
    ["High", "Low"],
    ["L", "M", "H"],
    ["Lo", "Hi"],
    ["0.5W", "5W"],
    ["1W", "8W", "25W"],
  ]) {
    const { rows: [fromPrzemienniki] } = buildPrzemiennikiRows([repeater()], rowHooks({ powerOptions }));
    const { rows: [fromRsgb] } = buildRsgbRows([rsgbRecord()], rowHooks({ powerOptions }));
    assert.equal(
      fromPrzemienniki.Power,
      fromRsgb.Power,
      `options ${powerOptions.join("/")} resolved differently per directory`,
    );
    assert.notEqual(fromPrzemienniki.Power, "", `options ${powerOptions.join("/")} resolved to nothing`);
  }
});

test("a driver that advertises none of the known tiers keeps its own default", () => {
  // Handing a radio a level it never published is worse than leaving the
  // column alone: the upload preflight rejects the whole row for it.
  const { rows: [row] } = buildPrzemiennikiRows([repeater()], rowHooks({ powerOptions: ["L1", "L2"] }));
  assert.equal(row.Power, "", "no tier was recognised, so nothing may be written");
});

test("a radio with no Power column at all still imports repeaters", () => {
  // Plenty of drivers publish no power levels. The write has to no-op rather
  // than cost the channel.
  const hooks = makeRowHooks({
    columns: ["Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Comment"],
    optionsByColumn: { Mode: ["FM"], Tone: ["", "Tone", "TSQL", "Cross"] },
    caseInsensitive: true,
  });
  const { rows, skipped } = buildPrzemiennikiRows([repeater()], hooks);
  assert.equal(rows.length, 1);
  assert.deepEqual(skipped, []);
  assert.equal(rows[0].Power, undefined);
});

test("every przemienniki row the builder emits gets the power write, whatever the record", () => {
  // The cases above pin how the level resolves on one record. This pins the
  // invariant: no shape of repeater may reach the grid on Low.
  const corpus = [
    repeater({ qra: "SR1", mode: "fm" }),
    repeater({ qra: "SR2", mode: "dstar" }),
    repeater({ qra: "SR3", mode: "dmr" }),
    repeater({ qra: "SR4", ctcssTx: 103.5 }),
    repeater({ qra: "SR5", ctcssRx: 88.5, ctcssTx: 88.5 }),
    repeater({ qra: "SR6", qrgTx: 145.0125 }),
    repeater({ qra: "SR7", latitude: 52.2, longitude: 21.0 }),
  ];
  const { rows } = buildPrzemiennikiRows(corpus, rowHooks());
  assert.ok(rows.length >= 5, `expected most of the corpus to build, got ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.Power, "High", `row ${row.Name} was not High`);
  }
});

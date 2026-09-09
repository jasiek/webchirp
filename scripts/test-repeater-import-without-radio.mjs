// Repeater directory imports with no radio selected.
//
// Startup leaves the grid on the generic CHIRP CSV schema (loadEmptySchema in
// web/js/ui/codeplug-io.js): state.currentHeaders carries every CSV_FORMAT
// column while state.radioMetadata is still empty, which is a supported
// editing state — a channel can be hand-inserted, and a CSV can be loaded,
// before any radio is picked.
//
// The row builders (web/js/datasources.js, web/js/rsgb.js) drop a repeater the
// selected radio cannot express, and they decide that from the hooks
// channel-table.js hands them. Both hooks therefore have to read an absent
// column metadata entry the same way — as "nothing constrains this" — or the
// builders read "no radio has spoken" as "the radio refuses it" and skip every
// record: a przemienniki.net query fetched 377 repeaters and inserted 0,
// reporting them as needing a mode or a tone "the selected radio" could not
// use while no radio was selected at all.
//
// These tests drive the real createChannelTable() hooks against the real
// builders, because the defect lived in the seam between them and neither
// side's own unit tests could see it.

import assert from "node:assert/strict";
import test from "node:test";

import { CSV_FORMAT_HEADERS } from "../web/js/clipboard.js";
import { buildPrzemiennikiRows, buildPmr446Rows } from "../web/js/datasources.js";
import { buildRsgbRows } from "../web/js/rsgb.js";
import { FakeElement, installFakeDom } from "./test-support/fake-dom.mjs";

// The grid as it stands before a radio is chosen, or with the driver metadata
// a caller passes in. `columns` undefined is the startup schema itself.
async function tableWithMetadata(columns) {
  installFakeDom();
  const { createChannelTable } = await import("../web/js/ui/channel-table.js");
  const dom = {
    tableHead: new FakeElement("thead"),
    tableBody: new FakeElement("tbody"),
    tableScrollEl: new FakeElement("div"),
    channelEmptyStateEl: new FakeElement("div"),
  };
  const state = {
    currentHeaders: CSV_FORMAT_HEADERS.slice(),
    currentRows: [],
    radioMetadata: columns ? { headers: CSV_FORMAT_HEADERS.slice(), columns } : {},
  };
  return createChannelTable({
    dom,
    state,
    log: { setStatus() {}, logDebug() {} },
    actions: {},
  });
}

// A przemienniki.net record: repeater perspective, so `qrgRx` is the repeater's
// input (what the radio transmits) and `ctcssRx` its access tone.
const SR4X = {
  qra: "SR4X",
  mode: "fm",
  qrgRx: 145.0,
  qrgTx: 145.6,
  ctcssRx: "88.5",
  ctcssTx: "",
  qth: "Olsztyn",
};

test("a przemienniki query with no radio selected inserts its repeaters", async () => {
  const table = await tableWithMetadata();

  const { rows, skipped } = buildPrzemiennikiRows([SR4X], table.rowBuilderHooks());

  assert.deepEqual(skipped, [], "nothing constrains the row, so nothing may be dropped");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Name, "SR4X");
  assert.equal(rows[0].Frequency, "145.600000");
  assert.equal(rows[0].Duplex, "-");
  assert.equal(rows[0].Offset, "0.600000");
  // The access tone and the mode that encodes it: the enum lookups that used
  // to return "" here are what emptied the whole import.
  assert.equal(rows[0].Tone, "Tone");
  assert.equal(rows[0].rToneFreq, "88.5");
  assert.equal(rows[0].Mode, "FM");
});

test("an RSGB query with no radio selected inserts its repeaters", async () => {
  const table = await tableWithMetadata();

  const { rows, skipped } = buildRsgbRows(
    [{
      record: {
        repeater: "GB3XP", tx: 145687500, rx: 145087500,
        ctcss: 77, mode: "A", band: "2M", locator: "IO91VJ", status: "OPERATIONAL",
      },
      distanceKm: 12,
    }],
    table.rowBuilderHooks(),
    { modes: ["A"] },
  );

  assert.deepEqual(skipped, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Frequency, "145.687500");
  assert.equal(rows[0].Tone, "Tone");
  assert.equal(rows[0].rToneFreq, "77.0");
  // The record carries no txbw, which findRsgbMode reads as narrow, so its
  // analogue ranking starts at NFM — the first choice, as everywhere else here.
  assert.equal(rows[0].Mode, "NFM");
});

test("a band-plan preset with no radio selected still gets its mode", async () => {
  const table = await tableWithMetadata();

  const rows = buildPmr446Rows(table.rowBuilderHooks());

  assert.equal(rows.length, 16);
  assert.equal(rows[0].Mode, "NFM", "the first choice the preset ranks");
});

test("a selected radio still constrains what an import may write", async () => {
  // The fix must not turn the driver check off: this radio's tables are the
  // ones that decide, and they lack both the repeater's mode and its tone.
  const table = await tableWithMetadata({
    Frequency: { kind: "freq", editable: true, bands: [[144000000, 148000000]] },
    Tone: { kind: "enum", editable: true, options: ["", "Tone", "TSQL", "Cross"] },
    rToneFreq: { kind: "enum", editable: true, options: ["67.0", "94.8"] },
    Mode: { kind: "enum", editable: true, options: ["DV"] },
  });

  const { rows, skipped } = buildPrzemiennikiRows([SR4X], table.rowBuilderHooks());

  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, [{ repeater: "SR4X", reason: "tone", tone: "88.5" }]);
});

test("a driver that publishes an empty option list still means 'cannot'", async () => {
  // The distinction the fix rests on: an absent metadata entry is a radio that
  // has said nothing, while an entry carrying an empty options array is the
  // driver itself advertising no choices. Only the first is unconstrained.
  const table = await tableWithMetadata({
    Mode: { kind: "enum", editable: true, options: [] },
  });

  assert.equal(table.findEnumOption("Mode", ["FM", "NFM"], true), "");
  assert.equal(table.findEnumOption("Tone", ["Tone"], true), "Tone", "no entry at all");
});

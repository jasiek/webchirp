import assert from "node:assert/strict";
import test from "node:test";

import {
  RSGB_BANDS,
  RSGB_MODES,
  buildRsgbRows,
  decodeMaidenheadBox,
  dedupeRsgbRecords,
  distanceToBoxKm,
  encodeMaidenhead,
  fetchRsgbRecords,
  filterRsgbRecords,
  haversineKm,
  isRepeaterRecord,
  parseRsgbPayload,
  rsgbLocatorUrl,
  squaresForRadius,
} from "../web/js/rsgb.js";

// Herne Bay: the API places GB3KI at JO01NI, 145.6625 out / 145.0625 in.
const HERNE_BAY = { latitude: 51.3704, longitude: 1.1289 };

function record(overrides = {}) {
  return {
    id: 199,
    status: "OPERATIONAL",
    keeperCallsign: "G4TKR",
    town: "HERNE BAY",
    modeCodes: ["A", "D"],
    tx: 145662500,
    rx: 145062500,
    ctcss: 103.5,
    txbw: 12.5,
    band: "2M",
    repeater: "GB3KI",
    locator: "JO01NI",
    ...overrides,
  };
}

// Row hooks matching channel-table.js's rowBuilderHooks(), with a column set
// wide enough to exercise every field the builder writes.
function rowHooks(options = {}) {
  const modeOptions = options.modeOptions || ["FM", "NFM", "DV", "DMR", "C4FM", "P25", "NXDN", "M17"];
  const columns = [
    "Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Comment",
  ];
  return {
    createBlankRow: () => Object.fromEntries(columns.map((column) => [column, ""])),
    setRowValue: (row, column, value) => {
      if (columns.includes(column)) {
        row[column] = String(value ?? "");
      }
    },
    // Choice order decides, exactly as channel-table.js's findEnumOption does:
    // the caller's list is a priority ranking, not a set.
    findEnumOption: (column, choices) => {
      const options = column === "Tone" ? ["Tone", "TSQL"] : column === "Mode" ? modeOptions : [];
      for (const choice of choices) {
        const match = options.find((option) => option.toLowerCase() === String(choice).toLowerCase());
        if (match) {
          return match;
        }
      }
      return "";
    },
  };
}

test("encodeMaidenhead round-trips a known repeater square", () => {
  assert.equal(encodeMaidenhead(HERNE_BAY.latitude, HERNE_BAY.longitude, 6), "JO01NI");
  assert.equal(encodeMaidenhead(HERNE_BAY.latitude, HERNE_BAY.longitude, 4), "JO01");
  // A locator's own centre must re-encode to itself.
  const box = decodeMaidenheadBox("IO91WM");
  assert.equal(encodeMaidenhead(box.latitude, box.longitude, 6), "IO91WM");
});

test("decodeMaidenheadBox handles every precision the directory carries", () => {
  const four = decodeMaidenheadBox("IO92");
  assert.equal(four.precision, 4);
  assert.equal(four.north - four.south, 1);
  assert.ok(Math.abs((four.east - four.west) - 2) < 1e-9);

  const six = decodeMaidenheadBox("JO01NI");
  assert.equal(six.precision, 6);
  assert.ok(Math.abs(six.latitude - 51.3542) < 0.001);
  assert.ok(Math.abs(six.longitude - 1.125) < 0.001);

  // GB3OD is stored at 8 characters; it must land inside its own 6-char parent.
  const eight = decodeMaidenheadBox("IO83DC20");
  const parent = decodeMaidenheadBox("IO83DC");
  assert.equal(eight.precision, 8);
  assert.ok(eight.latitude >= parent.south && eight.latitude <= parent.north);
  assert.ok(eight.longitude >= parent.west && eight.longitude <= parent.east);

  // GB3XL's 5-character locator is not valid Maidenhead; keeping its 4-char
  // prefix is what stops the record from vanishing from every result.
  const five = decodeMaidenheadBox("IO39X");
  assert.equal(five.precision, 4);
  assert.deepEqual(
    { south: five.south, west: five.west },
    { south: decodeMaidenheadBox("IO39").south, west: decodeMaidenheadBox("IO39").west },
  );

  assert.equal(decodeMaidenheadBox(""), null);
  assert.equal(decodeMaidenheadBox("ZZ99"), null);
  assert.equal(decodeMaidenheadBox("IO9"), null);
});

test("a 6-character square measures 4.6 km by 5.2-6.0 km over the UK", () => {
  for (const [locator, expectedEwKm] of [["IO70AA", 5.98], ["IO91WM", 5.79], ["IO85AA", 5.34]]) {
    const box = decodeMaidenheadBox(locator);
    const nsKm = haversineKm(box.south, box.longitude, box.north, box.longitude);
    const ewKm = haversineKm(box.latitude, box.west, box.latitude, box.east);
    assert.ok(Math.abs(nsKm - 4.63) < 0.05, `${locator} N-S was ${nsKm}`);
    assert.ok(Math.abs(ewKm - expectedEwKm) < 0.15, `${locator} E-W was ${ewKm}`);
  }
});

test("distanceToBoxKm is zero inside the box and a lower bound outside", () => {
  const box = decodeMaidenheadBox("JO01NI");
  assert.equal(distanceToBoxKm(box.latitude, box.longitude, box), 0);
  const outside = distanceToBoxKm(box.latitude + 1, box.longitude, box);
  const centre = haversineKm(box.latitude + 1, box.longitude, box.latitude, box.longitude);
  assert.ok(outside > 0);
  assert.ok(outside < centre, "nearest-point distance must be shorter than centre distance");
});

test("squaresForRadius fans out over 4-character squares, nearest first", () => {
  const small = squaresForRadius(HERNE_BAY.latitude, HERNE_BAY.longitude, 10);
  assert.deepEqual(small.squares, ["JO01"]);
  assert.equal(small.truncated, false);

  // London sits on the IO/JO field boundary at longitude 0, so a 30 km radius
  // there genuinely spans two squares — the case the fan-out exists for.
  const london = { latitude: 51.5072, longitude: -0.1276 };
  const wide = squaresForRadius(london.latitude, london.longitude, 30);
  assert.equal(wide.squares[0], "IO91", "the home square must be queried first");
  assert.ok(wide.squares.includes("JO01"));
  assert.ok(wide.squares.every((locator) => locator.length === 4));
  assert.equal(new Set(wide.squares).size, wide.squares.length, "no square twice");

  // Every square in the plan must actually reach the radius: a square whose
  // nearest corner is outside it can only contribute rows the filter drops.
  for (const locator of wide.squares) {
    const box = decodeMaidenheadBox(locator);
    assert.ok(distanceToBoxKm(london.latitude, london.longitude, box) <= 30);
  }

  const capped = squaresForRadius(HERNE_BAY.latitude, HERNE_BAY.longitude, 2000, { maxSquares: 4 });
  assert.equal(capped.squares.length, 4);
  assert.equal(capped.truncated, true);
  assert.ok(capped.considered > 4);

  assert.deepEqual(squaresForRadius(51, 1, 0).squares, []);
  assert.deepEqual(squaresForRadius(Number.NaN, 1, 30).squares, []);
});

test("parseRsgbPayload treats a null data field as an empty result", () => {
  // An unknown locator is HTTP 200 with {"data":null}, not an HTTP error.
  assert.deepEqual(parseRsgbPayload({ data: null }), []);
  assert.deepEqual(parseRsgbPayload({}), []);
  assert.equal(parseRsgbPayload({ data: [record()] }).length, 1);
  assert.throws(() => parseRsgbPayload({ data: "nope" }), /non-array/);
});

test("fetchRsgbRecords queries each square without tripping a CORS preflight", async () => {
  const calls = [];
  const records = await fetchRsgbRecords({
    squares: ["JO01", "JO02"],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => (url.endsWith("JO01") ? { data: [record()] } : { data: null }),
      };
    },
  });
  assert.equal(records.length, 1);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api-beta.rsgb.online/locator/JO01",
    "https://api-beta.rsgb.online/locator/JO02",
  ]);
  // Any custom header would force an OPTIONS preflight, which the API answers
  // with 405 — so the request must carry no init at all.
  assert.ok(calls.every((call) => call.init === undefined));
});

test("fetchRsgbRecords surfaces a transport failure", async () => {
  await assert.rejects(
    fetchRsgbRecords({
      squares: ["JO01"],
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    }),
    /HTTP 502/,
  );
});

test("rsgbLocatorUrl normalises the locator and base", () => {
  assert.equal(rsgbLocatorUrl("jo01"), "https://api-beta.rsgb.online/locator/JO01");
  assert.equal(rsgbLocatorUrl("JO01", "http://localhost:8080/"), "http://localhost:8080/locator/JO01");
});

test("dedupeRsgbRecords keys on id and keeps distinct ports of one callsign", () => {
  const deduped = dedupeRsgbRecords([
    record({ id: 199 }),
    record({ id: 199 }),
    record({ id: 5997, repeater: "GB7BSK", band: "4M", tx: 70312500, rx: 70312500 }),
    record({ id: 6849, repeater: "GB7BSK", band: "2M", tx: 144925000, rx: 144925000 }),
  ]);
  assert.equal(deduped.length, 3);
  assert.equal(deduped.filter((entry) => entry.repeater === "GB7BSK").length, 2);

  // Records with no usable id fall back to a callsign/band/frequency key.
  const noIds = dedupeRsgbRecords([record({ id: null }), record({ id: null })]);
  assert.equal(noIds.length, 1);
});

test("filterRsgbRecords applies distance, band, mode and status", () => {
  const records = [
    record({ id: 1, locator: "JO01NI", band: "2M", modeCodes: ["A", "D"] }),
    record({ id: 2, locator: "JO01NI", band: "70CM", modeCodes: ["M:1"] }),
    record({ id: 3, locator: "IO70AA", band: "2M", modeCodes: ["A"] }),
    record({ id: 4, locator: "JO01NI", band: "2M", modeCodes: ["A"], status: "NOT OPERATIONAL" }),
    record({ id: 5, locator: "", band: "2M", modeCodes: ["A"] }),
  ];
  const base = { ...HERNE_BAY, radiusKm: 30 };

  const near = filterRsgbRecords(records, base);
  assert.deepEqual(near.map((entry) => entry.record.id), [1, 2]);

  assert.deepEqual(
    filterRsgbRecords(records, { ...base, bands: ["2M"] }).map((entry) => entry.record.id),
    [1],
  );
  // "M:1" is DMR with colour code 1; the filter matches on the flag alone.
  assert.deepEqual(
    filterRsgbRecords(records, { ...base, modes: ["M"] }).map((entry) => entry.record.id),
    [2],
  );
  assert.deepEqual(
    filterRsgbRecords(records, { ...base, onlyOperational: false }).map((entry) => entry.record.id),
    [1, 2, 4],
  );
  // No band or mode selected means no band or mode filter.
  assert.equal(filterRsgbRecords(records, { ...base, bands: [], modes: [] }).length, 2);
});

test("every returned record is inside the radius, coarse ones included", () => {
  // A record pinned only to IO91 could be anywhere in ~111 x 130 km, and its
  // box reaches within 78 km of Herne Bay — but its centre is ~148 km away, so
  // a 100 km search must not return it. Judging by the nearest corner instead
  // produced rows reading 148 km in a 100 km list.
  const coarse = record({ id: 9, locator: "IO91" });
  assert.equal(filterRsgbRecords([coarse], { ...HERNE_BAY, radiusKm: 100 }).length, 0);

  const reached = filterRsgbRecords([coarse], { ...HERNE_BAY, radiusKm: 200 });
  assert.equal(reached.length, 1);
  assert.equal(reached[0].approximate, true, "a square-only position is an estimate");

  const precise = filterRsgbRecords([record()], { ...HERNE_BAY, radiusKm: 30 });
  assert.equal(precise[0].approximate, false);

  for (const radiusKm of [10, 30, 100, 200]) {
    for (const entry of filterRsgbRecords([coarse, record()], { ...HERNE_BAY, radiusKm })) {
      assert.ok(entry.distanceKm <= radiusKm, `${entry.record.id} exceeded ${radiusKm} km`);
    }
  }
});

test("a station inside the searched square does not outrank a measured one", () => {
  // The query point sits inside IO91, so the coarse record's nearest-corner
  // distance is 0 — ranking on that floated an anywhere-in-130 km station above
  // repeaters measured at 13 km.
  const london = { latitude: 51.5072, longitude: -0.1276 };
  const entries = filterRsgbRecords([
    record({ id: 1, locator: "IO91" }),
    record({ id: 2, locator: "IO91VJ" }),
  ], { ...london, radiusKm: 100 });
  assert.deepEqual(entries.map((entry) => entry.record.id), [2, 1]);
});

test("filterRsgbRecords sorts nearest first", () => {
  const entries = filterRsgbRecords([
    record({ id: 1, locator: "JO01PA" }),
    record({ id: 2, locator: "JO01NI" }),
  ], { ...HERNE_BAY, radiusKm: 100 });
  assert.deepEqual(entries.map((entry) => entry.record.id), [2, 1]);
  assert.ok(entries[0].distanceKm < entries[1].distanceKm);
});

test("buildRsgbRows maps the repeater's tx/rx onto a CHIRP channel", () => {
  const entries = filterRsgbRecords([record()], { ...HERNE_BAY, radiusKm: 30 });
  const [row] = buildRsgbRows(entries, rowHooks());
  assert.equal(row.Name, "GB3KI");
  // The radio listens on the repeater's tx and transmits on its rx.
  assert.equal(row.Frequency, "145.662500");
  assert.equal(row.Duplex, "-");
  assert.equal(row.Offset, "0.600000");
  assert.equal(row.Tone, "Tone");
  assert.equal(row.rToneFreq, "103.5");
  assert.equal(row.Mode, "NFM");
  assert.match(row.Comment, /^HERNE BAY \| JO01NI \| \d+\.\d km$/);
});

test("only repeaters survive the filter — not gateways, hotspots or beacons", () => {
  const gateway = record({ id: 233, repeater: "MB6BH", tx: 144825000, rx: 144825000 });
  // Every beacon in the directory is transmit-only and reports rx as 0, so a
  // bare tx !== rx test would admit all 36 as duplex repeaters.
  const beacon = record({ id: 500, repeater: "GB3ANG", tx: 144430000, rx: 0, modeCodes: ["B"] });
  const repeater = record();

  assert.equal(isRepeaterRecord(repeater), true);
  assert.equal(isRepeaterRecord(gateway), false);
  assert.equal(isRepeaterRecord(beacon), false);
  assert.equal(isRepeaterRecord({ tx: 145000000 }), false);

  const entries = filterRsgbRecords([gateway, beacon, repeater], { ...HERNE_BAY, radiusKm: 30 });
  assert.deepEqual(entries.map((entry) => entry.record.repeater), ["GB3KI"]);
});

test("buildRsgbRows treats ctcss 0 as no tone", () => {
  const toneless = record({ ctcss: 0, modeCodes: ["D", "F"] });
  const [row] = buildRsgbRows(
    filterRsgbRecords([toneless], { ...HERNE_BAY, radiusKm: 30 }),
    rowHooks(),
  );
  assert.equal(row.Tone, "");
  assert.equal(row.rToneFreq, "");
  assert.equal(row.Mode, "DV");
});

test("buildRsgbRows prefers analogue on a mixed-mode repeater and falls back by bandwidth", () => {
  const hooks = rowHooks();
  const mixed = filterRsgbRecords([record({ modeCodes: ["A", "M:3"] })], { ...HERNE_BAY, radiusKm: 30 });
  assert.equal(buildRsgbRows(mixed, hooks)[0].Mode, "NFM");

  const wide = filterRsgbRecords([record({ modeCodes: ["A"], txbw: 25 })], { ...HERNE_BAY, radiusKm: 30 });
  assert.equal(buildRsgbRows(wide, hooks)[0].Mode, "FM");

  // A radio whose Mode enum has no digital entries still gets a usable channel.
  const dmrOnly = filterRsgbRecords([record({ modeCodes: ["M:1"] })], { ...HERNE_BAY, radiusKm: 30 });
  assert.equal(buildRsgbRows(dmrOnly, rowHooks({ modeOptions: ["FM", "NFM"] }))[0].Mode, "NFM");
});

test("buildRsgbRows notes a non-operational status and marks an estimated distance", () => {
  const [row] = buildRsgbRows(
    filterRsgbRecords([record({ locator: "IO91", status: "REDUCED OUTPUT" })], {
      ...HERNE_BAY,
      radiusKm: 200,
      onlyOperational: false,
    }),
    rowHooks(),
  );
  assert.match(row.Comment, /~\d+\.\d km \| REDUCED OUTPUT$/);
});

test("a repeater the radio cannot tune is dropped, not inserted half-built", () => {
  // GB3EN is a 1312 MHz ATV repeater. On a 2m/70cm radio setRowValue refuses
  // the frequency but accepts the -63 MHz offset, so the row that reaches the
  // grid has no frequency and a nonsense shift.
  const atv = record({ id: 779, repeater: "GB3EN", tx: 1312000000, rx: 1249000000, band: "23CM", txbw: 2000 });
  const entries = filterRsgbRecords([atv, record()], { ...HERNE_BAY, radiusKm: 30 });
  assert.equal(entries.length, 2, "the filter is not what excludes it");

  const handheld = rowHooks();
  // A radio whose Frequency column rejects anything above 470 MHz.
  handheld.setRowValue = (row, column, value) => {
    if (column === "Frequency" && Number.parseFloat(value) > 470) {
      return;
    }
    row[column] = String(value ?? "");
  };
  const rows = buildRsgbRows(entries, handheld);
  assert.deepEqual(rows.map((row) => row.Name), ["GB3KI"]);
  assert.equal(entries.length - rows.length, 1, "the caller can count what was left out");

  // A radio that can tune it keeps it.
  assert.equal(buildRsgbRows(entries, rowHooks()).length, 2);
});

test("the option lists cover the bands and every repeater-carrying mode", () => {
  assert.ok(RSGB_BANDS.includes("2M") && RSGB_BANDS.includes("70CM") && RSGB_BANDS.includes("24GHZ"));
  assert.equal(new Set(RSGB_BANDS).size, RSGB_BANDS.length);

  const flags = RSGB_MODES.map((mode) => mode.value);
  for (const mode of ["A", "D", "E", "M", "F", "P", "7", "N"]) {
    assert.ok(flags.includes(mode), `missing repeater mode ${mode}`);
  }
  // Station classes that are never repeaters must not be offerable: selecting
  // one could only ever return nothing, since isRepeaterRecord drops them all.
  for (const nonRepeater of ["X", "B", "PX"]) {
    assert.ok(!flags.includes(nonRepeater), `${nonRepeater} is not a repeater mode`);
  }
  assert.equal(new Set(flags).size, flags.length);
});

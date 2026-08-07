import assert from "node:assert/strict";
import test from "node:test";

import {
  RSGB_API_BASE,
  RSGB_BANDS,
  RSGB_DEFAULT_BANDS,
  RSGB_DEFAULT_MODES,
  RSGB_MODES,
  buildRsgbRows,
  isRepeaterRecord,
  parseRsgbPayload,
} from "../web/js/rsgb.js";

// Contract tests against the live RSGB/ETCC API. Deliberately NOT part of
// `npm test` — they need the network and a third party's uptime, so a red run
// here is not necessarily a red build. Run them with `npm run test:api` when
// touching the RSGB code, and on a schedule if the feature starts mattering.
//
// The rest of the suite runs on fixtures transcribed from this API, which means
// it stays green if the upstream changes shape underneath us. These tests are
// the only thing that catches that, so they assert the specific behaviours the
// code depends on rather than just "a request succeeded":
//   - the CORS header that lets a browser call this at all
//   - a miss reported as 200 + {"data":null} instead of an HTTP error
//   - /locator prefix-matching at 4 characters and matching exactly at 6
//   - the field names, units and types buildRsgbRows() reads
//   - that the curated band and mode lists still describe the live data
//
// Failures are meant to be read, not muted: each one names the assumption in
// the source that just stopped being true.

const TIMEOUT_MS = 30_000;

// One full download of the directory, shared by every test that needs the whole
// corpus — 555 KB raw, ~73 KB gzipped, so this is the cheap way to do it.
let allRecordsPromise = null;

async function getJson(path) {
  const response = await fetch(`${RSGB_API_BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  assert.equal(response.ok, true, `GET ${path} returned HTTP ${response.status}`);
  return { response, payload: await response.json() };
}

function allRecords() {
  if (!allRecordsPromise) {
    allRecordsPromise = getJson("/all/systems").then(({ payload }) => parseRsgbPayload(payload));
  }
  return allRecordsPromise;
}

test("the API is reachable and sends the CORS header the browser needs", async () => {
  const { response } = await getJson("/locator/IO91");
  // Without this the feature cannot work from a page at all, and unlike
  // przemienniki/repeaterbook there is no proxy in front of it to add one.
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("content-type") || "", /application\/json/);
});

test("a miss is HTTP 200 with a null data field, not an HTTP error", async () => {
  // parseRsgbPayload() exists for this: status alone cannot tell hit from miss.
  const { response, payload } = await getJson("/locator/AA00");
  assert.equal(response.status, 200);
  assert.equal(payload.data, null);
  assert.deepEqual(parseRsgbPayload(payload), []);
});

test("/locator prefix-matches at 4 characters", async () => {
  // The whole fan-out design rests on this: squaresForRadius() emits 4-char
  // squares because they are the only length that returns a square's contents.
  const { payload } = await getJson("/locator/IO91");
  const records = parseRsgbPayload(payload);
  assert.ok(records.length > 50, `IO91 returned only ${records.length} records`);
  for (const record of records) {
    assert.ok(
      String(record.locator || "").toUpperCase().startsWith("IO91"),
      `IO91 returned a record at ${record.locator}`,
    );
  }
  // It must be a real prefix match, not exact-match on 4-char records only.
  assert.ok(
    records.some((record) => String(record.locator || "").length > 4),
    "IO91 returned no sub-square records, so it is no longer a prefix match",
  );
});

test("/locator matches exactly at 6 characters, and not at 2 or 5", async () => {
  const { payload } = await getJson("/locator/IO91WM");
  for (const record of parseRsgbPayload(payload)) {
    // Exact equality, so a 6-char query cannot reach a record filed at 4 — the
    // reason the fan-out never queries the user's own 6-char square.
    assert.equal(String(record.locator || "").toUpperCase(), "IO91WM");
  }
  for (const unsupported of ["/locator/IO", "/locator/IO91W"]) {
    const { payload: miss } = await getJson(unsupported);
    assert.equal(miss.data, null, `${unsupported} unexpectedly returned data`);
  }
});

test("records carry the fields, types and units buildRsgbRows reads", async () => {
  const records = await allRecords();
  assert.ok(records.length > 1000, `only ${records.length} records in /all`);

  for (const record of records) {
    const where = `record ${record.id} (${record.repeater})`;
    assert.equal(typeof record.id, "number", `${where}: id is the only unique key`);
    assert.equal(typeof record.repeater, "string", `${where}: callsign`);
    assert.equal(typeof record.band, "string", `${where}: band`);
    assert.equal(typeof record.status, "string", `${where}: status`);
    assert.equal(typeof record.locator, "string", `${where}: locator is the only position source`);
    assert.equal(typeof record.tx, "number", `${where}: tx`);
    assert.equal(typeof record.rx, "number", `${where}: rx`);
    assert.equal(typeof record.ctcss, "number", `${where}: ctcss`);
    // modeCodes is genuinely nullable — two records carry null.
    assert.ok(
      record.modeCodes === null || Array.isArray(record.modeCodes),
      `${where}: modeCodes must be an array or null`,
    );
  }

  // Frequencies are in Hz. If they ever became MHz every row would be built
  // a million times too low, and nothing else in the suite would notice.
  const tuned = records.filter((record) => record.tx > 0);
  assert.ok(tuned.length > 1000);
  for (const record of tuned) {
    assert.ok(record.tx > 1e6, `record ${record.id} tx=${record.tx} is not Hz`);
  }

  // No coordinates anywhere: the locator maths is not an optimisation.
  const positional = records.find((record) => "latitude" in record || "lat" in record);
  assert.equal(positional, undefined, "the API now carries coordinates — use them instead of locators");
});

test("beacons are transmit-only, so rx === 0 still means 'not a repeater'", async () => {
  const records = await allRecords();
  const beacons = records.filter((record) => (record.modeCodes || []).includes("B"));
  assert.ok(beacons.length > 0, "no beacons found — the B mode flag may have changed");
  for (const beacon of beacons) {
    assert.equal(beacon.rx, 0, `beacon ${beacon.repeater} now reports rx=${beacon.rx}`);
    assert.equal(isRepeaterRecord(beacon), false);
  }
});

test("locators come at mixed precision, so decoding must tolerate it", async () => {
  const records = await allRecords();
  const lengths = new Set(records.map((record) => String(record.locator || "").length));
  // 4 and 6 are the bulk; the point is that assuming a single length is wrong.
  assert.ok(lengths.has(4) && lengths.has(6), `locator lengths seen: ${[...lengths].join(", ")}`);
});

test("every offered band still holds a repeater", async () => {
  const records = await allRecords();
  const repeaterBands = new Set(records.filter(isRepeaterRecord).map((record) => String(record.band).toUpperCase()));
  for (const band of RSGB_BANDS) {
    assert.ok(repeaterBands.has(band), `${band} is offered but now holds no repeater — drop it from RSGB_BANDS`);
  }
});

test("no omitted band has gained a repeater", async () => {
  // The counterpart to the test above, and the one that will actually fire:
  // 4m, 13cm, 6cm, 24GHz and SHF were excluded on a 2026-07-31 snapshot of a
  // live directory. If ETCC coordinates a repeater on one, it stops being
  // filterable and this says so.
  const records = await allRecords();
  const offered = new Set(RSGB_BANDS);
  const gained = new Map();
  for (const record of records.filter(isRepeaterRecord)) {
    const band = String(record.band).toUpperCase();
    if (!offered.has(band)) {
      gained.set(band, (gained.get(band) || 0) + 1);
    }
  }
  assert.deepEqual(
    Object.fromEntries(gained),
    {},
    "these bands now hold repeaters and should be added to RSGB_BANDS",
  );
});

test("every offered mode still appears on a repeater", async () => {
  const records = await allRecords();
  const flags = new Set();
  for (const record of records.filter(isRepeaterRecord)) {
    for (const code of record.modeCodes || []) {
      flags.add(String(code).split(":")[0].toUpperCase());
    }
  }
  for (const mode of RSGB_MODES) {
    assert.ok(flags.has(mode.value), `mode ${mode.value} (${mode.label}) no longer appears on any repeater`);
  }
  // DMR colour codes are why comparisons drop everything after the colon.
  const withColourCode = records.some((record) => (record.modeCodes || []).some((code) => /^M:\d+$/.test(code)));
  assert.ok(withColourCode, "no M:<colour code> flags found — the access-code suffix may be gone");
});

test("the default filters return a usable set of repeaters", async () => {
  const records = await allRecords();
  const bands = new Set(RSGB_DEFAULT_BANDS);
  const modes = new Set(RSGB_DEFAULT_MODES);
  const matching = records.filter((record) => (
    isRepeaterRecord(record)
    && String(record.status).toUpperCase() === "OPERATIONAL"
    && bands.has(String(record.band).toUpperCase())
    && (record.modeCodes || []).some((code) => modes.has(String(code).split(":")[0].toUpperCase()))
  ));
  // A modal that opens on filters matching almost nothing would be worse than
  // one that opens on none at all.
  assert.ok(matching.length > 200, `the default filters match only ${matching.length} repeaters nationwide`);
});

// A stand-in radio that advertises Low first — the ordering roughly half of
// CHIRP's drivers use, and the one under which an unset Power column shows
// "Low". Wide open otherwise, so the corpus is judged on Power alone.
function permissiveRowHooks() {
  const columns = ["Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Power", "Comment"];
  const optionsFor = {
    Tone: ["Tone", "TSQL"],
    Mode: ["FM", "NFM", "DV", "DN", "DMR", "P25", "NXDN", "M17", "TETRA"],
    Power: ["Low", "High"],
  };
  return {
    createBlankRow: () => Object.fromEntries(columns.map((column) => [column, ""])),
    setRowValue: (row, column, value) => {
      if (columns.includes(column)) {
        row[column] = String(value ?? "");
      }
    },
    findEnumOption: (column, choices) => {
      const options = optionsFor[column] || [];
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

test("every repeater the live API serves builds a channel on High", async () => {
  // The unit suite checks this invariant over a corpus I wrote, which can only
  // contain record shapes I thought of. This runs it over every repeater the
  // directory actually holds — ~850 of them, with whatever field combinations
  // ETCC has in there today.
  const records = await allRecords();
  const repeaters = records.filter(isRepeaterRecord);
  assert.ok(repeaters.length > 500, `only ${repeaters.length} repeaters to check`);

  const { rows, skipped } = buildRsgbRows(repeaters, permissiveRowHooks());
  assert.ok(rows.length > 500, `only ${rows.length} rows built from ${repeaters.length} repeaters`);

  const notHigh = rows.filter((row) => row.Power !== "High");
  assert.deepEqual(
    notHigh.map((row) => `${row.Name}: ${row.Power || "(unset)"}`),
    [],
    "these repeaters would be programmed at low power",
  );

  // Whatever this radio could not build must be a stated reason, not a silent
  // gap — the same guarantee the grid relies on to report its skips.
  for (const entry of skipped) {
    assert.ok(["frequency", "mode"].includes(entry.reason), `unknown skip reason ${entry.reason}`);
  }
});

test("a locator query and the full dump agree", async () => {
  // Cross-checks the two endpoints the feature could be built on, so a
  // divergence shows up here rather than as missing rows in the grid.
  const records = await allRecords();
  const expected = records.filter((record) => String(record.locator || "").toUpperCase().startsWith("JO01"));
  const { payload } = await getJson("/locator/JO01");
  const actual = parseRsgbPayload(payload);
  assert.deepEqual(
    actual.map((record) => record.id).sort((a, b) => a - b),
    expected.map((record) => record.id).sort((a, b) => a - b),
  );
});

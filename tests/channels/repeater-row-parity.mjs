// Parity between the two per-source row builders the repeater record retired
// (buildPrzemiennikiRows in web/js/datasources.ts and buildRsgbRows in
// web/js/rsgb.ts, until 2026-10-09) and the one that replaced them: each
// source's parser into RepeaterRecord (web/js/repeater-record.ts) plus
// buildRepeaterRows (web/js/repeater-rows.ts).
//
// tests/support/fixtures/repeater-rows-expected.json is what the retired
// builders produced from the fixtures, captured while both paths still ran
// side by side. This runs the one builder through the grid's real buildRows
// (web/js/ui/channel-table.ts) against the real runtime, so every write gets
// the verdict the app would give it, for several real drivers: the startup
// schema (CHIRP's generic CSV driver), the grid before any schema arrives, a
// UV-5R (FM/NFM, Cross, 2m and 70cm), an ID-51 (D-STAR, no Cross), a TH-D74
// (D-STAR, wide coverage) and a TK-690 (narrow FM only). The fixtures in
// tests/support/fixtures are written to the shapes each live directory sends
// (see their headers).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CSV_FORMAT_HEADERS } from "../../web/js/clipboard.ts";
import { buildRepeaterRows } from "../../web/js/repeater-rows.ts";
import {
  dedupeRsgbRecords,
  filterRsgbRecords,
  parseRsgbPayload,
  rsgbPreferredModes,
  rsgbToRepeaterRecord,
} from "../../web/js/rsgb.ts";
import { parseRxfRecords } from "../../web/js/rxf.ts";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import { installIndexPage, pageElement } from "../support/index-page.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

function fixture(name) {
  return readFileSync(path.join(repoRoot, "tests", "support", "fixtures", name), "utf8");
}

const RXF_FIXTURES = [
  { source: "przemienniki", file: "rxf-przemienniki.xml" },
  { source: "repeaterbook", file: "rxf-repeaterbook.xml" },
  { source: "irts", file: "rxf-irts.xml" },
];

// Shrewsbury, inside the squares the RSGB fixture covers.
const RSGB_CENTRE = { latitude: 52.708, longitude: -2.754 };

// Every query shape the RSGB modal can send, plus the unfiltered one the old
// builder also accepted: the form's analogue default, D-STAR, both, and none.
const RSGB_QUERIES = [
  { modes: ["A"], onlyOperational: true },
  { modes: ["D"], onlyOperational: true },
  { modes: ["A", "D"], onlyOperational: false },
  { modes: [], onlyOperational: false },
];

// The radios: a label, and how to get the session and column metadata.
const RADIOS = [
  { label: "startup schema (no radio selected)", module: null },
  { label: "no schema yet", module: null, noMetadata: true },
  { label: "Baofeng UV-5R", module: "uv5r", cls: "BaofengUV5RGeneric" },
  { label: "Icom ID-51", module: "id51", cls: "ID51Radio" },
  { label: "Kenwood TH-D74", module: "thd74", cls: "THD74Radio" },
  { label: "Kenwood TK-690", module: "tk690", cls: "TK690Radio" },
];

// What the grid holds for one radio: its session id (blank with no radio) and
// the state members selecting it sets.
async function radioState(radio) {
  const harness = await sharedHarness();
  let sessionId = "";
  let schema;
  if (radio.module) {
    await ensureModule(harness, radio.module);
    sessionId = await harness.session(radio.module, radio.cls);
    schema = await harness.runPythonJson("json.dumps(get_radio_column_metadata(_sid))", { _sid: sessionId });
  } else {
    schema = await harness.runPythonJson("json.dumps(get_default_schema())");
  }
  const headers = schema.headers?.length ? schema.headers : CSV_FORMAT_HEADERS.slice();
  return {
    currentHeaders: headers.slice(),
    radioMetadata: radio.noMetadata ? {} : { headers: headers.slice(), columns: schema.columns },
    radioSession: sessionId ? { id: sessionId } : null,
  };
}

// The grid for one radio, its writes checked by the real runtime through the
// harness -- the same wiring tests/channels/no-radio-schema.mjs uses, with a
// selected radio's session when the case has one. `beforeAnswer` runs before
// each runtime answer is handed back, so a test can change the radio while a
// builder awaits its verdicts.
async function gridFor(radio, { beforeAnswer = async () => {} } = {}) {
  const harness = await sharedHarness();
  const selected = await radioState(radio);
  installIndexPage();
  const { createChannelTable } = await import("../../web/js/ui/channel-table.ts");
  const state = {
    ...selected,
    currentRows: [],
    runtimeApi: {
      normalizeAndValidateRows: async ({ sessionId: id, rows }) => {
        const answer = await harness.rpc("normalize_and_validate_rows", { session_id: id, rows });
        await beforeAnswer(state);
        return answer;
      },
    },
  };
  const table = createChannelTable({
    dom: {
      tableHead: pageElement("tableHead"),
      tableBody: pageElement("tableBody"),
      tableScrollEl: pageElement("tableScrollEl"),
      channelEmptyStateEl: pageElement("channelEmptyStateEl"),
    },
    state,
    log: { setStatus() {}, logDebug() {} },
    actions: { channelSelectionChanged() {} },
    session: {
      idOf: async (handle) => handle?.id ?? "",
      isCurrent: (handle) => state.radioSession === handle,
    },
  });
  return { table, state };
}

// Just the grid, for the cases where the radio stays put.
async function tableFor(radio) {
  return (await gridFor(radio)).table;
}

// Skips compared as a set, and a tone by its value: the record path reports
// unusable entries before the builder's own skips, and spells a published
// "110" as "110.0", the way the radio's tone table does.
function skipKey(entry) {
  return JSON.stringify({ ...entry, ...(entry.tone ? { tone: Number(entry.tone) } : {}) });
}
function sameSkips(actual, expected, message) {
  assert.deepEqual(actual.map(skipKey).sort(), expected.map(skipKey).sort(), message);
}

// What the retired builders produced, keyed "<radio> | <fixture or query>",
// with each row reduced to the columns it fills.
const EXPECTED = JSON.parse(fixture("repeater-rows-expected.json"));

// A row as the snapshot stores it: blank columns left out. Every row in one
// table has the same columns, so this loses nothing a comparison needs.
function compact(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== ""));
}

// The retired builders' result for one case, failing loudly if the snapshot
// does not have it rather than comparing against nothing.
function expectedFor(key) {
  const expected = EXPECTED[key];
  assert.ok(expected, `no snapshot for ${key}`);
  return expected;
}

// Where the one builder deliberately parts from the two it replaces, by radio
// and repeater (FINDINGS.md **one-repeater-row-builder**). Each is asserted in
// both directions -- what the old builder did and what the new one does --
// and only then left out of the row-for-row comparison, so a difference that
// is not on this list still fails.
const rowOf = (result, name) => result.rows.find((row) => row.Name === name);
const skipOf = (result, name) => result.skipped.find((entry) => entry.repeater === name);
const KNOWN_DIFFERENCES = {
  // Before any schema arrives every enum lookup answers with its first
  // choice. The old RXF table put "C4FM" first for przemienniki.net's
  // spelling, a Mode no driver offers, so the runtime refused it and the row
  // kept a blank Mode; Fusion now ranks CHIRP's "DN" first for every source,
  // as RSGB's table already did. Unreachable from the modal, which only
  // queries fm and dstar.
  "no schema yet": {
    SR9YS(before, after) {
      // The snapshot leaves blank columns out.
      assert.equal(rowOf(before, "SR9YS").Mode ?? "", "");
      assert.equal(rowOf(after, "SR9YS").Mode, "DN");
    },
  },
  // A D-STAR repeater with an access tone the radio's table lacks, on a radio
  // without DV: it fails twice, and the one builder checks the tone first
  // (the RXF builder's order, which SR9TL keeps), where buildRsgbRows checked
  // the mode first.
  "Baofeng UV-5R": {
    GB7TZ(before, after) {
      assert.deepEqual(skipOf(before, "GB7TZ"), { repeater: "GB7TZ", reason: "mode" });
      assert.deepEqual(skipOf(after, "GB7TZ"), { repeater: "GB7TZ", reason: "tone", tone: "159.0" });
    },
  },
  "Kenwood TK-690": {
    // A 25 kHz analogue RSGB repeater on a narrow-only radio. buildRsgbRows
    // offered a wide channel only FM/WFM and skipped it; analogue FM now takes
    // NFM as the fallback for every source, as the RXF builder always did --
    // a narrow radio works a wide repeater at reduced deviation.
    GB3UA(before, after) {
      assert.deepEqual(skipOf(before, "GB3UA"), { repeater: "GB3UA", reason: "mode" });
      assert.equal(rowOf(after, "GB3UA").Mode, "NFM");
    },
  },
};

// Assert this radio's known differences wherever the repeater appears, and
// return both results without those repeaters.
function settleKnownDifferences(radio, before, after) {
  const known = KNOWN_DIFFERENCES[radio.label] ?? {};
  const present = Object.keys(known).filter((name) => rowOf(before, name) || skipOf(before, name));
  for (const name of present) {
    known[name](before, after);
  }
  const without = ({ rows, skipped }) => ({
    rows: rows.filter((row) => !present.includes(row.Name)),
    skipped: skipped.filter((entry) => !present.includes(entry.repeater)),
  });
  return { expected: without(before), actual: without(after) };
}

for (const radio of RADIOS) {
  test(`RXF rows are unchanged on ${radio.label}`, async () => {
    const table = await tableFor(radio);
    for (const { source, file } of RXF_FIXTURES) {
      const parsed = parseRxfRecords(fixture(file), { source });
      const built = await table.buildRows((hooks) => buildRepeaterRows(parsed.records, hooks));
      const after = { rows: built.rows.map(compact), skipped: [...parsed.unusable, ...built.skipped] };
      const before = expectedFor(`${radio.label} | ${file}`);
      assert.ok(before.rows.length + before.skipped.length > 0, `${file} built nothing at all`);
      const { expected, actual } = settleKnownDifferences(radio, before, after);
      assert.deepEqual(actual.rows, expected.rows, `${file} rows on ${radio.label}`);
      sameSkips(actual.skipped, expected.skipped, `${file} skips on ${radio.label}`);
    }
  });

  test(`RSGB rows are unchanged on ${radio.label}`, async () => {
    const table = await tableFor(radio);
    const records = dedupeRsgbRecords(parseRsgbPayload(JSON.parse(fixture("rsgb-locator.json"))));
    for (const query of RSGB_QUERIES) {
      const entries = filterRsgbRecords(records, { ...RSGB_CENTRE, radiusKm: 200, ...query });
      const name = `rsgb modes ${query.modes.join("/") || "any"}`;
      const built = await table.buildRows((hooks) => buildRepeaterRows(
        entries.map((entry) => rsgbToRepeaterRecord(entry)).filter((record) => record !== null),
        hooks,
        { preferredModes: rsgbPreferredModes(query.modes) },
      ));
      const after = { rows: built.rows.map(compact), skipped: built.skipped };
      const before = expectedFor(`${radio.label} | ${name}`);
      assert.ok(entries.length > 0, `nothing matched ${name}`);
      const { expected, actual } = settleKnownDifferences(radio, before, after);
      assert.deepEqual(actual.rows, expected.rows, `rows for ${name} on ${radio.label}`);
      sameSkips(actual.skipped, expected.skipped, `skips for ${name} on ${radio.label}`);
    }
  });
}

test("a radio changed while an import awaits its verdicts gets rows built for it", async () => {
  // buildRows (web/js/ui/channel-table.ts) drops an answer that arrives for a
  // radio no longer selected and reruns the builder against the one that is.
  // The repeater builder is a pure function of its records and the hooks, so
  // the rerun has to land exactly on what a fresh import on the new radio
  // builds: przemienniki.net's D-STAR entries are mode skips on a UV-5R and
  // DV rows on an ID-51.
  const uv5r = RADIOS.find((radio) => radio.module === "uv5r");
  const id51 = RADIOS.find((radio) => radio.module === "id51");
  const next = await radioState(id51);
  let switched = false;
  const { table } = await gridFor(uv5r, {
    beforeAnswer: async (state) => {
      if (!switched) {
        switched = true;
        Object.assign(state, next);
      }
    },
  });
  const parsed = parseRxfRecords(fixture("rxf-przemienniki.xml"), { source: "przemienniki" });
  const built = await table.buildRows((hooks) => buildRepeaterRows(parsed.records, hooks));

  assert.ok(switched, "the radio never changed under the builder");
  const expected = expectedFor(`${id51.label} | rxf-przemienniki.xml`);
  assert.deepEqual(built.rows.map(compact), expected.rows);
  sameSkips([...parsed.unusable, ...built.skipped], expected.skipped, "skips for the radio now selected");
  assert.equal(built.rows.find((row) => row.Name === "SR9DS")?.Mode, "DV");
});

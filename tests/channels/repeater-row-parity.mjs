// Parity between the two per-source row builders (buildPrzemiennikiRows in
// web/js/datasources.ts, buildRsgbRows in web/js/rsgb.ts) and the one that
// replaces them: each source's parser into RepeaterRecord
// (web/js/repeater-record.ts) plus buildRepeaterRows (web/js/repeater-rows.ts).
//
// Both paths run through the grid's real buildRows (web/js/ui/channel-table.ts)
// against the real runtime, so every write gets the verdict the app would give
// it, for several real drivers: the startup schema (CHIRP's generic CSV
// driver), the grid before any schema arrives, a UV-5R (FM/NFM, Cross, 2m and
// 70cm), an ID-51 (D-STAR, no Cross), a TH-D74 (D-STAR, wide coverage) and a
// TK-690 (narrow FM only). The fixtures in tests/support/fixtures are written
// to the shapes each live directory sends (see their headers).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CSV_FORMAT_HEADERS } from "../../web/js/clipboard.ts";
import { buildPrzemiennikiRows, parsePrzemiennikiXml } from "../../web/js/datasources.ts";
import { buildRepeaterRows } from "../../web/js/repeater-rows.ts";
import {
  buildRsgbRows,
  dedupeRsgbRecords,
  filterRsgbRecords,
  parseRsgbPayload,
  rsgbPreferredModes,
  rsgbToRepeaterRecord,
} from "../../web/js/rsgb.ts";
import { parseRxfRecords } from "../../web/js/rxf.ts";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import { FakeElement, installFakeDom } from "../support/fake-dom.mjs";
import { fakeXmlGlobals } from "../support/fake-xml.mjs";
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

// The grid for one radio, its writes checked by the real runtime through the
// harness -- the same wiring tests/channels/no-radio-schema.mjs uses, with a
// selected radio's session when the case has one.
async function tableFor(radio) {
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
  installFakeDom({ globals: fakeXmlGlobals() });
  const { createChannelTable } = await import("../../web/js/ui/channel-table.ts");
  const headers = schema.headers?.length ? schema.headers : CSV_FORMAT_HEADERS.slice();
  const state = {
    currentHeaders: headers.slice(),
    currentRows: [],
    radioMetadata: radio.noMetadata ? {} : { headers: headers.slice(), columns: schema.columns },
    radioSession: sessionId ? { id: sessionId } : null,
    runtimeApi: {
      normalizeAndValidateRows: ({ sessionId: id, rows }) =>
        harness.rpc("normalize_and_validate_rows", { session_id: id, rows }),
    },
  };
  return createChannelTable({
    dom: {
      tableHead: new FakeElement("thead"),
      tableBody: new FakeElement("tbody"),
      tableScrollEl: new FakeElement("div"),
      channelEmptyStateEl: new FakeElement("div"),
    },
    state,
    log: { setStatus() {}, logDebug() {} },
    actions: { channelSelectionChanged() {} },
    session: { idOf: async (handle) => handle?.id ?? "" },
  });
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

// Build both ways and hand back the two results.
async function bothWays(table, oldBuild, newBuild) {
  const before = await table.buildRows(oldBuild);
  const after = await table.buildRows(newBuild);
  return { before, after };
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
      assert.equal(rowOf(before, "SR9YS").Mode, "");
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
      const xml = fixture(file);
      const old = parsePrzemiennikiXml(xml);
      const parsed = parseRxfRecords(xml, { source });
      const { before, after } = await bothWays(
        table,
        (hooks) => buildPrzemiennikiRows(old.repeaters, hooks, { perspective: old.perspective }),
        (hooks) => {
          const built = buildRepeaterRows(parsed.records, hooks);
          return { rows: built.rows, skipped: [...parsed.unusable, ...built.skipped] };
        },
      );
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
      const label = `modes ${query.modes.join("/") || "any"} on ${radio.label}`;
      const { before, after } = await bothWays(
        table,
        (hooks) => buildRsgbRows(entries, hooks, { modes: query.modes }),
        (hooks) => buildRepeaterRows(
          entries.map((entry) => rsgbToRepeaterRecord(entry)).filter((record) => record !== null),
          hooks,
          { preferredModes: rsgbPreferredModes(query.modes) },
        ),
      );
      assert.ok(entries.length > 0, `nothing matched ${label}`);
      const { expected, actual } = settleKnownDifferences(radio, before, after);
      assert.deepEqual(actual.rows, expected.rows, `rows for ${label}`);
      sameSkips(actual.skipped, expected.skipped, `skips for ${label}`);
    }
  });
}

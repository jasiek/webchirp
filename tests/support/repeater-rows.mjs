// A directory's own record shape to channel rows, the way an import does it:
// the source's half of the parser into RepeaterRecord (web/js/rxf.ts,
// web/js/rsgb.ts), then the one row builder (buildRepeaterRows,
// web/js/repeater-rows.ts). For tests that pin how one directory's records
// become rows, written as that directory's fields rather than as records.
//
// These replace the per-source builders the record type retired
// (buildPrzemiennikiRows, buildRsgbRows), with the same `{ rows, skipped }`
// result in the same order, so a test reads as it did.

import { buildRepeaterRows } from "../../web/js/repeater-rows.ts";
import { rsgbPreferredModes, rsgbToRepeaterRecord } from "../../web/js/rsgb.ts";
import { rxfEntryToRecord } from "../../web/js/rxf.ts";

// Build rows from records one at a time, so an entry that never became a
// record keeps its place among the skips.
function rowsInOrder(entries, toRecord, nameOf, hooks, options) {
  const rows = [];
  const skipped = [];
  for (const entry of entries) {
    const record = toRecord(entry);
    if (!record) {
      skipped.push({ repeater: nameOf(entry), reason: "frequency" });
      continue;
    }
    const built = buildRepeaterRows([record], hooks, options);
    rows.push(...built.rows);
    skipped.push(...built.skipped);
  }
  return { rows, skipped };
}

// RXF entries ({ qra, mode, qrgRx, qrgTx, ctcssRx, ctcssTx, ... }, MHz) under
// the feed's perspective.
export function rxfRows(entries, hooks, { perspective = "repeater" } = {}) {
  return rowsInOrder(
    entries,
    (entry) => rxfEntryToRecord(entry, { perspective, source: "test" }),
    (entry) => String(entry?.qra || "").trim(),
    hooks,
  );
}

// RSGB records or filterRsgbRecords() entries, with the query's mode flags.
export function rsgbRows(entries, hooks, { modes = [] } = {}) {
  return rowsInOrder(
    entries,
    (entry) => rsgbToRepeaterRecord(entry),
    (entry) => String((entry?.record ?? entry)?.repeater || "").trim(),
    hooks,
    { preferredModes: rsgbPreferredModes(modes) },
  );
}

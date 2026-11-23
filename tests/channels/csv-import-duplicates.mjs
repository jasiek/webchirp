// Issue #319: CHIRP's CSV driver stores each line it parses at its Location,
// so of two lines naming the same Location the later one silently replaced
// the earlier. Importing a CSV must lose no line: both reach the grid, in the
// file's order, and the upload preflight flags the duplicate as #89 intends.
import assert from "node:assert/strict";
import test from "node:test";

import { ensureModule, sharedHarness } from "../support/chirp.mjs";

const RADIO = { module: "uv5r", className: "BaofengUV5R" };

const DUPLICATE_CSV = [
  "Location,Name,Frequency",
  "5,FIRST,146.520000",
  "2,OTHER,145.500000",
  "5,SECOND,446.000000",
].join("\n");

test("a CSV listing one Location twice keeps both lines", async (t) => {
  const harness = await sharedHarness();
  await ensureModule(harness, RADIO.module);
  const sessionId = await harness.session(RADIO.module, RADIO.className);

  await t.test("parse_csv returns every line, in memory order and then file order", async () => {
    const parsed = await harness.rpc("parse_csv", { csv_text: DUPLICATE_CSV, session_id: "" });
    assert.deepEqual(
      parsed.rows.map((row) => [row.Location, row.Name, row.Frequency]),
      [
        ["2", "OTHER", "145.500000"],
        ["5", "FIRST", "146.520000"],
        ["5", "SECOND", "446.000000"],
      ],
    );
    assert.deepEqual(parsed.errors, []);
  });

  await t.test("the upload preflight flags the later of the two", async () => {
    const parsed = await harness.rpc("parse_csv", { csv_text: DUPLICATE_CSV, session_id: sessionId });
    const result = await harness.rpc("validate_rows_for_upload", { rows: parsed.rows, session_id: sessionId });
    assert.equal(result.valid, false);
    const locationIssues = result.issues
      .filter((issue) => issue.column === "Location")
      .map((issue) => [issue.rowIndex, issue.message]);
    assert.equal(locationIssues.length, 1, JSON.stringify(result.issues));
    assert.equal(locationIssues[0][0], 2);
    assert.match(locationIssues[0][1], /Location 5 is already used by row 2/);
  });

  await t.test("lines CHIRP rejects are still reported, not stored", async () => {
    const csv = [
      "Location,Name,Frequency",
      "1,GOOD,146.520000",
      "1,BAD,not-a-number",
      "1,ZERO,0",
    ].join("\n");
    const parsed = await harness.rpc("parse_csv", { csv_text: csv, session_id: "" });
    assert.deepEqual(parsed.rows.map((row) => row.Name), ["GOOD"]);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0], /^Line 3: /);
  });
});

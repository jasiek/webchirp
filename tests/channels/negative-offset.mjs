// A negative Offset or Frequency never reaches the radio (issue #337).
//
// chirp_common.parse_freq() adds the fraction to a negative whole part
// (FINDINGS parse-freq-negative-defect), so a CSV Offset of -5.600000 came in
// as -4.4 MHz, showed as -4.600000, passed the upload preflight and was
// written as Duplex + 3.4 MHz. The grid already refuses a typed sign; the CSV
// import now warns about one, and the row path refuses it, so the preflight
// marks the cell and the export stops instead of writing it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { isPythonError } from "../../web/js/runtime-errors.ts";
import { ensureModule, sharedHarness } from "../support/chirp.mjs";
import { chirpImagesDir } from "../support/repo-paths.mjs";

const HEADER = "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,TStep,Skip,Comment";
const NEGATIVE_OFFSET_CSV = `${HEADER}\n1,NEG,146.520000,-,-5.600000,,88.5,88.5,023,NN,FM,5.00,,\n`;

// The rejection a runtime call ends in, or null when it succeeds.
function rejectionOf(promise) {
  return promise.then(() => null, (error) => error);
}

// A UV-5R session opened from the image CHIRP ships, which the export writes to.
async function uv5rSession(harness) {
  await ensureModule(harness, "uv5r");
  const image = readFileSync(path.join(chirpImagesDir, "Baofeng_UV-5R.img"));
  const { sessionId } = await harness.rpc("load_image_base64", { image_b64: image.toString("base64") });
  return sessionId;
}

test("a CSV's negative Offset is reported at import and stopped at upload", async (t) => {
  const harness = await sharedHarness();
  const sessionId = await uv5rSession(harness);

  // The harness prints the runtime's debug panel lines to stdout.
  const logged = t.mock.method(console, "log", () => {});
  const parsed = await harness.rpc("parse_csv", { csv_text: NEGATIVE_OFFSET_CSV, session_id: sessionId });
  logged.mock.restore();
  assert.deepEqual(parsed.errors, [
    "Channel 1: Offset cannot be negative; enter its size and set the direction in Duplex",
  ]);
  assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes("CSV IMPORT Channel 1: Offset")));
  // The row keeps what CHIRP's CSV driver made of it, for the preflight to mark.
  const [row] = parsed.rows;
  assert.equal(row.Offset, "-4.600000");

  const preflight = await harness.rpc("validate_rows_for_upload", { session_id: sessionId, rows: [row] });
  assert.equal(preflight.valid, false);
  assert.deepEqual(preflight.issues, [
    { rowIndex: 0, column: "Offset", message: "Offset cannot be negative" },
  ]);

  const error = await rejectionOf(
    harness.rpc("export_image_base64", { session_id: sessionId, rows: [row], settings_groups: [] }),
  );
  assert.ok(isPythonError(error, "RuntimeUnsupportedError"));
  assert.match(error.message, /Offset cannot be negative/);
});

test("a negative Frequency is marked on its own cell", async () => {
  const harness = await sharedHarness();
  const sessionId = await uv5rSession(harness);
  const preflight = await harness.rpc("validate_rows_for_upload", {
    session_id: sessionId,
    rows: [{ Location: "1", Name: "NEG", Frequency: "-146.520000", Offset: "0.600000", Duplex: "-", Mode: "FM" }],
  });
  assert.deepEqual(preflight.issues, [
    { rowIndex: 0, column: "Frequency", message: "Frequency cannot be negative" },
  ]);
});

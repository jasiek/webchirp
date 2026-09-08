import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCellValue, normalizeValue } from "../web/js/ui/channel-values.js";

// The column metadata the Python runtime reports, trimmed to what each case
// needs. CTCSS tables are the interesting enums: every driver publishes its
// own, and 67.0 leads nearly all of them, so a rejected write is invisible in
// the row unless normalizeCellValue says it was rejected (issue #104).
const TONE_TABLE = { kind: "enum", options: ["67.0", "88.5", "110.9", "127.3"] };
const TWO_METRES = { kind: "freq", bands: [[144_000_000, 148_000_000]] };

test("an enum value the driver does not offer is reported as rejected", () => {
  const result = normalizeCellValue("rToneFreq", "141.3", TONE_TABLE, "67.0");

  // The value still falls back, as it always did — a cell may not hold
  // something the driver cannot encode. The flag is what is new.
  assert.equal(result.value, "67.0");
  assert.equal(result.accepted, false);
});

test("an offered enum value, padded or not, is accepted", () => {
  assert.deepEqual(
    normalizeCellValue("rToneFreq", "110.9", TONE_TABLE, "67.0"),
    { value: "110.9", accepted: true },
  );
  // A spreadsheet's unpadded "88.50" is the driver's "88.5", not a rejection.
  assert.deepEqual(
    normalizeCellValue("rToneFreq", "88.50", TONE_TABLE, "67.0"),
    { value: "88.5", accepted: true },
  );
});

test("a column with no option list validates nothing and accepts everything", () => {
  // Generic-CSV mode: with no radio selected there are no options to check.
  assert.deepEqual(
    normalizeCellValue("rToneFreq", "141.3", { kind: "enum", options: [] }, ""),
    { value: "141.3", accepted: true },
  );
});

test("out-of-band and unparsable frequencies are rejected, in-band ones accepted", () => {
  assert.deepEqual(
    normalizeCellValue("Frequency", "1312.000000", TWO_METRES, "145.000000"),
    { value: "145.000000", accepted: false },
  );
  assert.deepEqual(
    normalizeCellValue("Frequency", "not a frequency", TWO_METRES, "145.000000"),
    { value: "145.000000", accepted: false },
  );
  assert.deepEqual(
    normalizeCellValue("Frequency", "145.500000", TWO_METRES, "145.000000"),
    { value: "145.500000", accepted: true },
  );
  // Offset is exempt from the band check, as a shift is not a frequency.
  assert.deepEqual(
    normalizeCellValue("Offset", "600.000000", TWO_METRES, "0.000000"),
    { value: "600.000000", accepted: true },
  );
});

test("an int outside the driver's range is clamped and reported as not accepted", () => {
  const location = { kind: "int", min: 1, max: 128 };

  assert.deepEqual(normalizeCellValue("Location", "300", location, "1"), { value: "128", accepted: false });
  assert.deepEqual(normalizeCellValue("Location", "abc", location, "7"), { value: "7", accepted: false });
  assert.deepEqual(normalizeCellValue("Location", "42", location, "1"), { value: "42", accepted: true });
});

test("a read-only column rejects unless the caller is a row builder", () => {
  const tuningStep = { kind: "enum", options: ["5.00", "6.25"], editable: false };

  assert.deepEqual(normalizeCellValue("TStep", "6.25", tuningStep, "5.00"), { value: "5.00", accepted: false });
  assert.deepEqual(
    normalizeCellValue("TStep", "6.25", tuningStep, "5.00", { allowReadOnly: true }),
    { value: "6.25", accepted: true },
  );
});

test("text coercion keeps the caller's value, so it counts as accepted", () => {
  const name = { kind: "text", validChars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", maxLength: 6 };

  assert.deepEqual(normalizeCellValue("Name", "GB3KI!!!", name, ""), { value: "GB3KI", accepted: true });
});

test("normalizeValue is the value half of the same call", () => {
  // Every existing call site takes the value alone; it must not have moved.
  assert.equal(normalizeValue("rToneFreq", "141.3", TONE_TABLE, "67.0"), "67.0");
  assert.equal(normalizeValue("rToneFreq", "110.9", TONE_TABLE, "67.0"), "110.9");
});

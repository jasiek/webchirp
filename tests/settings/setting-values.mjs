import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettingValue } from "../../web/js/ui/setting-values.js";

// The value metadata the Python runtime reports for a CHIRP RadioSetting,
// trimmed to what each case needs. Squelch Level on the iRadio UV-5118 is the
// shape issue #116 was reported against: a small integer range where a
// truncated parse lands on a real, writable value and so leaves no trace.
const SQUELCH = { type: "integer", mutable: true, min: 0, max: 9 };
const WIDE_INTEGER = { type: "integer", mutable: true, min: 1, max: 200 };

test("a fractional entry is rejected rather than truncated", () => {
  // Number.parseInt("1.5") is 1, which is inside 0-9 and a setting the radio
  // would happily accept -- the user's mistake would have been written back as
  // a deliberate-looking change.
  assert.deepEqual(
    normalizeSettingValue(SQUELCH, "1.5", 3),
    { value: "1.5", error: "Enter an integer." },
  );
});

test("exponent notation is read whole, not as its leading digit", () => {
  assert.deepEqual(
    normalizeSettingValue(WIDE_INTEGER, "1e2", 1),
    { value: 100, error: "" },
  );
});

test("an integer entry with trailing text is rejected", () => {
  assert.deepEqual(
    normalizeSettingValue(SQUELCH, "5abc", 3),
    { value: "5abc", error: "Enter an integer." },
  );
});

test("blank and non-numeric integer entries are still rejected", () => {
  // Number("") is 0, so blank has to be caught before the coercion; without
  // that guard an emptied control would silently store the minimum.
  for (const raw of ["", "   ", "abc", "Infinity", null]) {
    assert.equal(normalizeSettingValue(SQUELCH, raw, 3).error, "Enter an integer.");
  }
});

test("a plain integer is accepted, padded or signed", () => {
  assert.deepEqual(normalizeSettingValue(SQUELCH, " 7 ", 3), { value: 7, error: "" });
  assert.deepEqual(normalizeSettingValue(SQUELCH, "0", 3), { value: 0, error: "" });
  assert.deepEqual(normalizeSettingValue(WIDE_INTEGER, "+42", 1), { value: 42, error: "" });
});

test("range and step checks run on the value the user typed", () => {
  assert.deepEqual(
    normalizeSettingValue(SQUELCH, "12", 3),
    { value: 12, error: "Value must be at most 9." },
  );
  assert.deepEqual(
    normalizeSettingValue(SQUELCH, "-1", 3),
    { value: -1, error: "Value must be at least 0." },
  );
  // 1e2 used to truncate to 1, which is a legal step from min; the whole-string
  // parse is what lets the step check see 100.
  assert.deepEqual(
    normalizeSettingValue({ type: "integer", mutable: true, min: 0, max: 200, step: 30 }, "1e2", 0),
    { value: 100, error: "Value must increment by 30." },
  );
});

test("float settings keep accepting fractions", () => {
  const meta = { type: "float", mutable: true, min: 0, max: 10 };
  assert.deepEqual(normalizeSettingValue(meta, "1.5", 0), { value: 1.5, error: "" });
  assert.deepEqual(normalizeSettingValue(meta, "x", 0), { value: "x", error: "Enter a number." });
});

test("immutable settings ignore the entry entirely", () => {
  assert.deepEqual(
    normalizeSettingValue({ type: "integer", mutable: false, min: 0, max: 9 }, "1.5", 4),
    { value: 4, error: "" },
  );
});

test("enum and string rules are unchanged by the move", () => {
  const tone = { type: "enum", mutable: true, options: ["67.0", "88.5"] };
  assert.deepEqual(normalizeSettingValue(tone, "88.5", "67.0"), { value: "88.5", error: "" });
  assert.deepEqual(
    normalizeSettingValue(tone, "141.3", "67.0"),
    { value: "67.0", error: "Select one of the supported values." },
  );
  assert.deepEqual(
    normalizeSettingValue({ type: "string", mutable: true, maxLength: 3 }, "abcd", ""),
    { value: "abcd", error: "Value must be at most 3 characters." },
  );
});

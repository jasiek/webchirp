import assert from "node:assert/strict";
import test from "node:test";

import { buildExportFileName } from "../../web/js/ui.js";

const FIXED_DATE = new Date(2023, 11, 18); // 2023-12-18

// Each case is one call and the name it must produce; the test name says which
// rule of the <brand>_<model>_<date>.<format> scheme it pins.
const CASES = [
  {
    name: "builds <brand>_<model>_<date>.<format> for binary exports",
    args: ["Baofeng", "BF-888", "img", FIXED_DATE],
    expected: "Baofeng_BF-888_20231218.img",
  },
  {
    name: "builds <brand>_<model>_<date>.<format> for CSV exports",
    args: ["Yaesu", "FT-60", "csv", FIXED_DATE],
    expected: "Yaesu_FT-60_20231218.csv",
  },
  {
    name: "zero-pads single-digit month and day",
    args: ["Baofeng", "UV-5R", "img", new Date(2024, 0, 5)],
    expected: "Baofeng_UV-5R_20240105.img",
  },
  {
    name: "sanitizes characters that are unsafe in file names",
    args: ["Radioddity & Co", "GA-510 (v2)", "img", FIXED_DATE],
    expected: "Radioddity_Co_GA-510_v2_20231218.img",
  },
  {
    name: "falls back to 'radio' for empty vendor or model",
    args: ["", null, "csv", FIXED_DATE],
    expected: "radio_radio_20231218.csv",
  },
];

for (const { name, args, expected } of CASES) {
  test(name, () => {
    assert.equal(buildExportFileName(...args), expected);
  });
}

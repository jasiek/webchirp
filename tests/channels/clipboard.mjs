import assert from "node:assert/strict";
import test from "node:test";

import {
  CSV_FORMAT_HEADERS,
  buildRowsFromClipboardText,
  computeMovedRowOrder,
  looksLikeChannelTsv,
  parseTsv,
  rowLooksNonEmpty,
  serializeRowsToTsv,
} from "../../web/js/clipboard.js";

function makeRow(values = {}) {
  const row = {};
  for (const header of CSV_FORMAT_HEADERS) {
    row[header] = "";
  }
  return Object.assign(row, values);
}

const buildHelpers = {
  createBlankRow: () => makeRow(),
  setRowValue: (row, column, value) => {
    row[column] = String(value ?? "");
  },
};

test("serializeRowsToTsv emits the canonical 21-column header", () => {
  const tsv = serializeRowsToTsv([]);
  assert.equal(tsv, `${CSV_FORMAT_HEADERS.join("\t")}\n`);
  assert.equal(CSV_FORMAT_HEADERS.length, 21);
  assert.equal(CSV_FORMAT_HEADERS[0], "Location");
  assert.equal(CSV_FORMAT_HEADERS[20], "DVCODE");
});

test("serializeRowsToTsv blanks columns missing from row objects", () => {
  // Rows from a non-DV radio have no URCALL/RPT1CALL/RPT2CALL/DVCODE keys.
  const row = { Location: "0", Name: "Simplex1", Frequency: "146.520000" };
  const tsv = serializeRowsToTsv([row]);
  const dataLine = tsv.split("\n")[1];
  const fields = dataLine.split("\t");
  assert.equal(fields.length, 21);
  assert.equal(fields[0], "0");
  assert.equal(fields[1], "Simplex1");
  assert.equal(fields[2], "146.520000");
  assert.deepEqual(fields.slice(17), ["", "", "", ""]);
});

test("serializeRowsToTsv quotes fields containing tab, quote, or newline", () => {
  const row = makeRow({ Name: 'a"b', Comment: "line1\nline2\twide" });
  const tsv = serializeRowsToTsv([row]);
  assert.ok(tsv.includes('"a""b"'));
  assert.ok(tsv.includes('"line1\nline2\twide"'));
});

test("parseTsv handles quoting, CRLF, and trailing newline", () => {
  const records = parseTsv('a\t"b""c"\t"d\ne"\r\nf\tg\th\n');
  assert.deepEqual(records, [
    ["a", 'b"c', "d\ne"],
    ["f", "g", "h"],
  ]);
});

test("TSV round trip preserves row values via header mapping", () => {
  const rows = [
    makeRow({ Location: "0", Name: "Simplex1", Frequency: "146.520000", Power: "5.0W" }),
    makeRow({ Location: "1", Name: 'Odd"Name', Frequency: "446.000000", Comment: "a\tb" }),
  ];
  const built = buildRowsFromClipboardText(serializeRowsToTsv(rows), buildHelpers);
  assert.equal(built.usedHeader, true);
  assert.equal(built.rows.length, 2);
  // Location is intentionally skipped (rows are renumbered on paste).
  assert.equal(built.rows[0].Location, "");
  assert.equal(built.rows[0].Name, "Simplex1");
  assert.equal(built.rows[0].Power, "5.0W");
  assert.equal(built.rows[1].Name, 'Odd"Name');
  assert.equal(built.rows[1].Comment, "a\tb");
});

test("header detection is case-insensitive and tolerates reordered subset columns", () => {
  const text = "frequency\tname\tlocation\n146.520000\tSimplex1\t5\n";
  const built = buildRowsFromClipboardText(text, buildHelpers);
  assert.equal(built.usedHeader, true);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].Frequency, "146.520000");
  assert.equal(built.rows[0].Name, "Simplex1");
  assert.equal(built.rows[0].Location, "");
});

test("unknown columns are passed to setRowValue and can be ignored by the caller", () => {
  const seen = [];
  const text = "Location\tFrequency\tBogus\n0\t146.520000\tx\n";
  const built = buildRowsFromClipboardText(text, {
    createBlankRow: () => makeRow(),
    setRowValue: (row, column, value) => {
      seen.push(column);
      if (column in row) {
        row[column] = String(value ?? "");
      }
    },
  });
  assert.equal(built.rows[0].Frequency, "146.520000");
  assert.ok(seen.includes("Bogus"));
  assert.ok(!("Bogus" in built.rows[0]));
});

test("header subsets that omit Location map by name without column shift", () => {
  const text = "Name\tFrequency\nSimplex1\t146.520000\nRepeaterA\t446.000000\n";
  const built = buildRowsFromClipboardText(text, buildHelpers);
  assert.equal(built.usedHeader, true);
  // The header row itself must not be imported as a channel.
  assert.equal(built.rows.length, 2);
  assert.equal(built.rows[0].Name, "Simplex1");
  assert.equal(built.rows[0].Frequency, "146.520000");
  assert.equal(built.rows[1].Name, "RepeaterA");
  assert.equal(built.rows[1].Frequency, "446.000000");
});

test("header subsets without Location or Frequency still map by name", () => {
  const text = "Name\tTone\tPower\tComment\nSimplex1\tTSQL\t5.0W\tcalling\n";
  const built = buildRowsFromClipboardText(text, buildHelpers);
  assert.equal(built.usedHeader, true);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].Name, "Simplex1");
  assert.equal(built.rows[0].Tone, "TSQL");
  assert.equal(built.rows[0].Power, "5.0W");
  assert.equal(built.rows[0].Comment, "calling");
});

test("a data row with a single cell matching a column name stays positional", () => {
  // First record is data whose Name cell is literally "Tone"; one known name
  // is not enough to call it a header.
  const text = "7\tTone\t146.520000\n8\tSimplex2\t446.000000\n";
  const built = buildRowsFromClipboardText(text, buildHelpers);
  assert.equal(built.usedHeader, false);
  assert.equal(built.rows.length, 2);
  assert.equal(built.rows[0].Name, "Tone");
  assert.equal(built.rows[0].Frequency, "146.520000");
});

test("a first record dominated by unknown fields stays positional", () => {
  const text = "Simplex1\tName\t146.520000\tsomething\n";
  const built = buildRowsFromClipboardText(text, buildHelpers);
  assert.equal(built.usedHeader, false);
  assert.equal(built.rows.length, 1);
});

test("headerless TSV maps positionally in CSV_FORMAT order", () => {
  const fields = ["7", "PasteMe", "446.000000", "", "0.000000", "", "88.5"];
  const built = buildRowsFromClipboardText(`${fields.join("\t")}\n`, buildHelpers);
  assert.equal(built.usedHeader, false);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].Location, "");
  assert.equal(built.rows[0].Name, "PasteMe");
  assert.equal(built.rows[0].Frequency, "446.000000");
  assert.equal(built.rows[0].rToneFreq, "88.5");
});

test("blank lines are skipped and non-TSV text returns null", () => {
  const built = buildRowsFromClipboardText("a\tb\n\n\t\nc\td\n", buildHelpers);
  assert.equal(built.rows.length, 2);
  assert.equal(looksLikeChannelTsv("plain text"), false);
  assert.equal(buildRowsFromClipboardText("plain text", buildHelpers), null);
});

test("rowLooksNonEmpty distinguishes real channels from blanks", () => {
  assert.equal(rowLooksNonEmpty(makeRow()), false);
  assert.equal(rowLooksNonEmpty(makeRow({ Frequency: "146.520000" })), true);
  assert.equal(rowLooksNonEmpty(makeRow({ Name: "X" })), true);
  assert.equal(rowLooksNonEmpty(makeRow({ Frequency: "0.000000" })), false);
});

test("computeMovedRowOrder moves a single row up and down", () => {
  assert.deepEqual(computeMovedRowOrder(3, [1], -1), {
    order: [1, 0, 2],
    selected: [0],
    moved: true,
  });
  assert.deepEqual(computeMovedRowOrder(3, [1], 1), {
    order: [0, 2, 1],
    selected: [2],
    moved: true,
  });
});

test("computeMovedRowOrder moves a contiguous block preserving order", () => {
  const { order, selected, moved } = computeMovedRowOrder(4, [1, 2], -1);
  assert.deepEqual(order, [1, 2, 0, 3]);
  assert.deepEqual(selected, [0, 1]);
  assert.equal(moved, true);
});

test("computeMovedRowOrder clamps blocked rows in non-contiguous selections", () => {
  // {0,2} up: 0 clamps at the top, 2 moves to 1.
  const up = computeMovedRowOrder(4, [0, 2], -1);
  assert.deepEqual(up.order, [0, 2, 1, 3]);
  assert.deepEqual(up.selected, [0, 1]);
  assert.equal(up.moved, true);
});

test("computeMovedRowOrder reports moved:false when fully clamped", () => {
  const top = computeMovedRowOrder(3, [0, 1], -1);
  assert.deepEqual(top.order, [0, 1, 2]);
  assert.deepEqual(top.selected, [0, 1]);
  assert.equal(top.moved, false);
  const bottom = computeMovedRowOrder(3, [1, 2], 1);
  assert.deepEqual(bottom.order, [0, 1, 2]);
  assert.deepEqual(bottom.selected, [1, 2]);
  assert.equal(bottom.moved, false);
});

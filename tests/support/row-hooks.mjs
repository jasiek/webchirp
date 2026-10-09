// Row hooks standing in for the ones buildRows() in web/js/ui/channel-table.ts
// hands a builder, for tests that drive a repeater-directory row builder
// without a grid or a runtime. Every builder test
// needs the same three callbacks — a blank row, a guarded column write, and an
// enum lookup that treats the caller's choices as a priority ranking — and
// differs only in which columns exist, which options each enum column offers,
// and how strictly options are matched.

// The columns a repeater row builder writes; wide enough to exercise every
// field an RSGB record's row touches (buildRepeaterRows,
// web/js/repeater-rows.ts), and the default when a test needs no others.
export const REPEATER_COLUMNS = [
  "Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Power", "Comment",
];

// Build the hooks.
//   columns         - the columns the row has; writes to any other are dropped,
//                     as the grid drops writes to columns the driver lacks.
//   optionsByColumn - enum options per column, e.g. { Mode: ["FM", "NFM"] }.
//                     A column not listed offers nothing, so every lookup
//                     against it returns "".
//   caseInsensitive - match options ignoring case. web/js/ui/channel-table.ts does; a
//                     test that wants to pin the exact strings a driver
//                     advertises leaves this off, so it is an explicit choice.
//   maxFrequencyMhz - reject Frequency writes above this, the way the runtime
//                     keeps the previous value when a frequency falls outside
//                     valid_bands (normalize_cell in
//                     web/python/webchirp_bridge/row_normalization.py; Offset
//                     is exempt from that check, which is the asymmetry some
//                     builders must notice).
//
// setRowValue reports acceptance as the grid's does, from the runtime's
// verdict: false when the column is absent, the frequency is out of band, or
// the value is not one of the column's options. A column with no options
// listed is not an enum, so anything can be written to it — matching the
// runtime, which only validates against a non-empty option list.
export function makeRowHooks({
  columns = REPEATER_COLUMNS,
  optionsByColumn = {},
  caseInsensitive = false,
  maxFrequencyMhz = Infinity,
} = {}) {
  const sameOption = caseInsensitive
    ? (option, choice) => option.toLowerCase() === String(choice).toLowerCase()
    : (option, choice) => option === choice;
  return {
    createBlankRow: () => Object.fromEntries(columns.map((column) => [column, ""])),
    setRowValue: (row, column, value) => {
      if (!columns.includes(column)) {
        return false;
      }
      if (column === "Frequency" && Number.parseFloat(value) > maxFrequencyMhz) {
        return false;
      }
      const options = optionsByColumn[column];
      if (Array.isArray(options) && options.length > 0
          && !options.some((option) => sameOption(option, value))) {
        // As in the grid: a rejected enum leaves a valid-looking value behind
        // (the driver's first option), so only the return value tells a caller
        // its write did not take.
        row[column] = String(options[0]);
        return false;
      }
      row[column] = String(value ?? "");
      return true;
    },
    // Choice order decides, exactly as web/js/ui/channel-table.ts's findEnumOption does:
    // the first choice the column offers wins, whatever its position there.
    findEnumOption: (column, choices) => {
      const options = optionsByColumn[column] || [];
      for (const choice of choices) {
        const match = options.find((option) => sameOption(option, choice));
        if (match) {
          return match;
        }
      }
      return "";
    },
  };
}

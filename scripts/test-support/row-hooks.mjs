// Row hooks matching channel-table.js's rowBuilderHooks(), for tests that
// drive a repeater-directory row builder without a grid. Every builder test
// needs the same three callbacks — a blank row, a guarded column write, and an
// enum lookup that treats the caller's choices as a priority ranking — and
// differs only in which columns exist, which options each enum column offers,
// and how strictly options are matched.

// The columns a repeater row builder writes; wide enough to exercise every
// field buildRsgbRows() touches, and the default when a test needs no others.
export const REPEATER_COLUMNS = [
  "Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Power", "Comment",
];

// Build the hooks.
//   columns         - the columns the row has; writes to any other are dropped,
//                     as the grid drops writes to columns the driver lacks.
//   optionsByColumn - enum options per column, e.g. { Mode: ["FM", "NFM"] }.
//                     A column not listed offers nothing, so every lookup
//                     against it returns "".
//   caseInsensitive - match options ignoring case. channel-table.js does; a
//                     test that wants to pin the exact strings a driver
//                     advertises leaves this off, so it is an explicit choice.
//   maxFrequencyMhz - reject Frequency writes above this, the way
//                     normalizeValue keeps the previous value when a frequency
//                     falls outside valid_bands (Offset is exempt from that
//                     check, which is the asymmetry some builders must notice).
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
        return;
      }
      if (column === "Frequency" && Number.parseFloat(value) > maxFrequencyMhz) {
        return;
      }
      row[column] = String(value ?? "");
    },
    // Choice order decides, exactly as channel-table.js's findEnumOption does:
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

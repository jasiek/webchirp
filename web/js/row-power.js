// The transmit power a directory import writes into a channel row.
//
// Power is the one column whose vocabulary is private to a driver: "High",
// "Hi", "L3" and "0.1W" all name the same kind of thing in different words,
// so a builder cannot write a literal. It asks the column's own option list
// for the first spelling it offers, which is what findEnumOption in
// web/js/ui/channel-table.js ranks for it.
//
// This lives beside the builders rather than inside one of them because every
// repeater directory wants the same answer: web/js/rsgb.js and
// web/js/datasources.js both build repeater rows, and a ranked list that
// existed in only one of them left przemienniki.net, repeaterbook.com and IRTS
// imports on whatever the driver happened to list first.

// Ranked highest-first. "Hi"/"H" are in the list because 38 driver classes
// spell it that way; the watt figures cover drivers that publish levels only
// as numbers, in descending order so the strongest available one wins.
const HIGHEST_FIRST = ["High", "Hi", "H", "50W", "25W", "10W", "8W", "7W", "5W", "5.0W"];

// Write the highest power tier the selected driver advertises, for a channel
// that has to reach a distant repeater. Without this the column keeps the blank
// row's value, which is whatever the driver lists first (defaultValueForColumn
// in web/js/ui/channel-table.js takes options[0]) — and drivers disagree:
// anytone.py starts at High, anytone778uv.py at Low. A driver whose labels
// match none of these keeps its own default, which is no worse than before.
export function setHighestPower(row, { setRowValue, findEnumOption }) {
  const power = highestPowerOption(findEnumOption);
  if (power) {
    setRowValue(row, "Power", power);
  }
  return power;
}

// The same lookup without the write, for a builder that chooses between tiers
// and only sometimes wants the top one (findPowerTier in
// web/js/datasources.js). Returns "" when the driver advertises none of them.
export function highestPowerOption(findEnumOption) {
  return findEnumOption("Power", HIGHEST_FIRST, true);
}

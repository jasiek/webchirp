// The transmit power a directory import writes into a channel row.
//
// Power is the one column whose vocabulary is private to a driver: "High",
// "Hi", "L3" and "0.1W" all name the same kind of thing in different words,
// so a builder cannot write a literal. It asks the column's own option list
// for the first spelling it offers, which is what findEnumOption in
// web/js/ui/channel-table.ts ranks for it.
//
// This lives apart from the builders because more than one wants it: the
// repeater row builder (web/js/repeater-rows.ts) writes the top tier for every
// directory, and the GMRS band plan (web/js/datasources.ts) picks between
// tiers. A ranked list that once existed only in the RSGB builder left
// przemienniki.net, repeaterbook.com and IRTS imports on whatever the driver
// happened to list first.

import type { ChannelRow, ColumnMeta } from "./ui/channel-values.ts";

/** One of the Power column's options and the wattage the driver gives it. */
export interface PowerOption {
  label: string;
  watts: number;
}

/**
 * The grid's row-building calls a directory importer is handed
 * (buildRows() in web/js/ui/channel-table.ts, which answers each write with
 * the runtime's verdict and so runs a builder until it asks nothing new: a
 * builder must be a pure function of its input and these hooks).
 */
export interface RowBuilderHooks {
  /** A blank row for the selected radio, every column at its default. */
  createBlankRow: () => ChannelRow;
  /**
   * A write checked by the radio's own rules (normalize_cell in
   * web/python/webchirp_bridge/row_normalization.py); returns whether the row
   * now holds the value.
   */
  setRowValue: (row: ChannelRow, column: string, value: unknown) => boolean;
  /**
   * The first of a ranked list of choices the column offers, or "" when it
   * offers none of them.
   */
  findEnumOption: (column: string, choices: readonly string[], caseInsensitive?: boolean) => string;
  /**
   * The Power column's options with their wattages (powerOptionsOf), or []
   * when the radio publishes none.
   */
  powerOptions: () => readonly PowerOption[];
}

/** Why a directory record did not become a channel row. */
export interface SkippedRepeater {
  /** The record's own name for the repeater. */
  repeater: string;
  reason: "frequency" | "mode" | "tone";
  /** The access tone the radio cannot send, for reason "tone". */
  tone?: string;
  /** The repeater's mode, for reason "mode". */
  mode?: string;
}

/** What a directory row builder returns. */
export interface RepeaterRowsResult {
  rows: ChannelRow[];
  skipped: SkippedRepeater[];
}

// Ranked highest-first. "Hi"/"H" are in the list because 38 driver classes
// spell it that way; the watt figures cover drivers that publish levels only
// as numbers, in descending order so the strongest available one wins.
const HIGHEST_FIRST = ["High", "Hi", "H", "50W", "25W", "10W", "8W", "7W", "5W", "5.0W"];

// Write the highest power tier the selected driver advertises, for a channel
// that has to reach a distant repeater. Without this the column keeps the blank
// row's value, which is whatever the driver lists first (defaultValueForColumn
// in web/js/ui/channel-table.ts takes options[0]) — and drivers disagree:
// anytone.py starts at High, anytone778uv.py at Low. A driver whose labels
// match none of these keeps its own default, which is no worse than before.
export function setHighestPower(
  row: ChannelRow,
  { setRowValue, findEnumOption }: Pick<RowBuilderHooks, "setRowValue" | "findEnumOption">,
): string {
  const power = highestPowerOption(findEnumOption);
  if (power) {
    setRowValue(row, "Power", power);
  }
  return power;
}

// The same lookup without the write, for a builder that chooses between tiers
// and only sometimes wants the top one (findPowerTier in
// web/js/datasources.ts). Returns "" when the driver advertises none of them.
export function highestPowerOption(findEnumOption: RowBuilderHooks["findEnumOption"]): string {
  return findEnumOption("Power", HIGHEST_FIRST, true);
}

// A watt figure as CHIRP writes one ("0.5W", "50W"), or NaN for a label that
// is not one ("High", "L1").
function parseWatts(text: string): number {
  const match = /^\s*(\d+(?:\.\d*)?)\s*W?\s*$/i.exec(text);
  return match ? Number.parseFloat(match[1] ?? "") : Number.NaN;
}

// The Power column's options with the wattage each stands for. A driver's
// labels say nothing reliable about rank -- "L", "Lo", "L1", "Low1" and "Low"
// all name a low tier, and some drivers list Low first -- but every level it
// advertises is a CHIRP PowerLevel with a wattage, which the column metadata
// carries as optionWatts (a label that is already a watt figure is left out of
// that map and read as itself). An option with neither is left out.
export function powerOptionsOf(meta: ColumnMeta | undefined): PowerOption[] {
  const options = Array.isArray(meta?.options) ? meta.options.map(String) : [];
  const watts = meta?.optionWatts ?? {};
  return options.flatMap((label) => {
    const value = parseWatts(watts[label] ?? label);
    return Number.isFinite(value) ? [{ label, watts: value }] : [];
  });
}

// The level for a channel on a band with a transmit limit (PMR446 0.5 W,
// MURS 2 W): the strongest the driver offers within the limit, or its weakest
// when none is. Chosen by wattage, so it holds for every driver whatever its
// labels. A radio that publishes no wattages gets the limit itself as a watt
// figure if its column takes one -- with no radio selected that is what
// adoptPowerLevels in web/js/ui/channel-table.ts later turns into the chosen
// radio's closest level -- and "" otherwise.
export function powerAtMost(
  { powerOptions, findEnumOption }: Pick<RowBuilderHooks, "powerOptions" | "findEnumOption">,
  maxWatts: number,
): string {
  const levels = powerOptions();
  if (levels.length === 0) {
    // CHIRP's own spelling of a watt figure (AutoNamedPowerLevel).
    const figure = maxWatts >= 10 ? `${Math.trunc(maxWatts)}W` : `${maxWatts.toFixed(1)}W`;
    return findEnumOption("Power", [figure], true);
  }
  const within = levels.filter((level) => level.watts <= maxWatts);
  const pick = within.length > 0
    ? within.reduce((best, level) => (level.watts > best.watts ? level : best))
    : levels.reduce((best, level) => (level.watts < best.watts ? level : best));
  return pick.label;
}

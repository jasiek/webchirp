// The shapes of a channel row and of the column metadata the Python runtime
// reports for the selected radio. Types only: what a value written into a
// cell becomes is decided by the runtime (normalize_cell in
// web/python/webchirp_bridge/row_normalization.py, reached through
// normalize_and_validate_rows), never here. The grid reads this metadata to
// build its editors -- option lists, read-only cells, a name's length -- and
// to pick a row builder's spelling of an option, not to judge a value.

/**
 * One channel in the grid: CHIRP CSV header -> cell text. Rows read from a
 * radio or an image may also carry the driver's per-channel extras under the
 * "__extra" sidecar key (web/js/row-extra.ts), which no header names.
 */
export type ChannelRow = Record<string, unknown>;

/**
 * What the grid knows about one column, as _column_metadata_for_radio
 * (web/python/webchirp_bridge/column_metadata.py) reports it. `kind` decides
 * which of the other fields apply.
 */
export interface ColumnMeta {
  kind: "text" | "int" | "freq" | "enum";
  /** False renders the cell read-only. */
  editable?: boolean;
  /** text: the driver's name length. */
  maxLength?: number;
  /** text: every character the driver accepts. */
  validChars?: string;
  /** int: the lowest memory number. */
  min?: number;
  /** int: the highest; absent for unbounded radios. */
  max?: number;
  /** freq: [low, high) in Hz. */
  bands?: Array<[number, number]>;
  /** enum: the driver's values, in its order. */
  options?: string[];
  /** enum: CHIRP's starting value, when listed. */
  default?: string;
  /**
   * Power: option label ->
   * its wattage, spelled as an exported CSV spells it ("5.0W").
   */
  optionWatts?: Record<string, string>;
}

/**
 * The grid's schema for the selected radio (get_radio_column_metadata) or
 * for none (get_default_schema).
 */
export interface RadioMetadata {
  /** The CSV columns this radio has, in order. */
  headers: string[];
  columns: Record<string, ColumnMeta>;
}

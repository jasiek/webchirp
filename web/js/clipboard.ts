// Channel clipboard + reorder helpers, kept DOM-free so they can be unit
// tested in plain Node. The clipboard text format mirrors CHIRP desktop:
// tab-separated values with the canonical CSV header row, so copied channels
// paste straight into Google Sheets/Excel (and back), other webchirp tabs,
// and desktop CHIRP itself.
import type { ChannelRow } from "./ui/channel-values.ts";

// Canonical CHIRP CSV column order; must match Memory.CSV_FORMAT in
// chirp/chirp/chirp_common.py.
export const CSV_FORMAT_HEADERS = [
  "Location",
  "Name",
  "Frequency",
  "Duplex",
  "Offset",
  "Tone",
  "rToneFreq",
  "cToneFreq",
  "DtcsCode",
  "DtcsPolarity",
  "RxDtcsCode",
  "CrossMode",
  "Mode",
  "TStep",
  "Skip",
  "Power",
  "Comment",
  "URCALL",
  "RPT1CALL",
  "RPT2CALL",
  "DVCODE",
];

const HEADER_BY_LOWERCASE = new Map(
  CSV_FORMAT_HEADERS.map((header) => [header.toLowerCase(), header]),
);

function escapeTsvField(value: unknown): string {
  const text = String(value ?? "");
  if (/[\t"\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

// Serialize rows (objects keyed by header name) to spreadsheet-compatible
// TSV: header line + one line per row, always emitting all canonical columns
// (blank for columns the current radio does not expose, e.g. DV-only ones).
export function serializeRowsToTsv(rows: readonly (ChannelRow | null | undefined)[]): string {
  const lines = [CSV_FORMAT_HEADERS.join("\t")];
  for (const row of rows) {
    lines.push(
      CSV_FORMAT_HEADERS.map((header) => escapeTsvField(row?.[header] ?? "")).join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

// Minimal RFC-4180-style parser with a tab delimiter: quoted fields may
// contain tabs/newlines, doubled quotes escape a quote, CRLF/LF both accepted.
export function parseTsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  const source = String(text ?? "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === "\t") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") {
        i += 1;
      }
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Drop a trailing-newline artifact record.
  if (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") {
      records.pop();
    }
  }
  return records;
}

// Desktop CHIRP uses a ">10 tabs" heuristic to tell grid pastes apart from
// single-cell text; webchirp's paste handler never fires while a cell editor
// is focused, so any tab at all signals tabular channel data.
export function looksLikeChannelTsv(text: unknown): boolean {
  return String(text ?? "").includes("\t");
}

function recordIsBlank(record: string[]): boolean {
  return record.every((field) => field.trim() === "");
}

// Build channel rows from pasted TSV text. If the first record looks like a
// CHIRP header row, columns map by name; otherwise fall back to positional
// CSV_FORMAT order (same behavior as desktop's mems_from_clipboard, which
// prepends the default header). Location is skipped: rows are renumbered by
// the caller. Unknown columns no-op via the injected setRowValue.
export function buildRowsFromClipboardText(
  text: string,
  { createBlankRow, setRowValue }: {
    createBlankRow: () => ChannelRow;
    setRowValue: (row: ChannelRow, header: string, value: string) => unknown;
  },
): { rows: ChannelRow[]; usedHeader: boolean } | null {
  if (!looksLikeChannelTsv(text)) {
    return null;
  }
  const records = parseTsv(text).filter((record) => !recordIsBlank(record));
  if (records.length === 0) {
    return { rows: [], usedHeader: false };
  }
  const candidateHeaders = records[0].map(
    (field) => HEADER_BY_LOWERCASE.get(field.trim().toLowerCase()) ?? field.trim(),
  );
  // The first record is a header when known column names dominate it — any
  // subset qualifies (e.g. "Name\tFrequency" from a spreadsheet), no single
  // column is required, and extra unknown columns are tolerated as long as
  // they don't outnumber the recognized ones. Requiring at least two matches
  // keeps a data row whose one cell happens to equal a column name (a channel
  // named "Tone") positional.
  const nonEmptyFields = records[0].filter((field) => field.trim() !== "");
  const knownFields = nonEmptyFields.filter((field) =>
    HEADER_BY_LOWERCASE.has(field.trim().toLowerCase()),
  );
  const usedHeader =
    knownFields.length >= 2 && knownFields.length * 2 >= nonEmptyFields.length;
  const headers = usedHeader ? candidateHeaders : CSV_FORMAT_HEADERS;
  const dataRecords = usedHeader ? records.slice(1) : records;
  const rows = dataRecords.map((record) => {
    const row = createBlankRow();
    headers.forEach((header, idx) => {
      if (header === "Location" || idx >= record.length) {
        return;
      }
      setRowValue(row, header, record[idx]);
    });
    return row;
  });
  return { rows, usedHeader };
}

// A row counts as non-empty (for the paste-overwrite confirmation) when it
// has a usable frequency or a name.
export function rowLooksNonEmpty(row: ChannelRow | null | undefined): boolean {
  const frequency = Number.parseFloat(String(row?.Frequency ?? ""));
  if (Number.isFinite(frequency) && frequency > 0) {
    return true;
  }
  return String(row?.Name ?? "").trim() !== "";
}

// Compute the row permutation for moving the selected rows by one position.
// Each selected row moves by exactly 1 in `direction` preserving relative
// order; rows blocked by the edge (or by an already-clamped selected
// neighbor) stay put. Returns the new order (new index -> old index), the
// selected indexes after the move, and whether anything actually moved.
export function computeMovedRowOrder(
  rowCount: number,
  selectedIndexes: Iterable<number>,
  direction: number,
): { order: number[]; selected: number[]; moved: boolean } {
  const order = Array.from({ length: rowCount }, (_, idx) => idx);
  const selected = [...selectedIndexes]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < rowCount)
    .sort((a, b) => a - b);
  const nextSelected: number[] = [];
  let moved = false;
  if (direction < 0) {
    let limit = 0;
    for (const idx of selected) {
      if (idx > limit) {
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        nextSelected.push(idx - 1);
        moved = true;
      } else {
        nextSelected.push(idx);
        limit = idx + 1;
      }
    }
  } else if (direction > 0) {
    let limit = rowCount - 1;
    for (const idx of [...selected].reverse()) {
      if (idx < limit) {
        [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
        nextSelected.push(idx + 1);
        moved = true;
      } else {
        nextSelected.push(idx);
        limit = idx - 1;
      }
    }
    nextSelected.reverse();
  } else {
    nextSelected.push(...selected);
  }
  return { order, selected: nextSelected, moved };
}

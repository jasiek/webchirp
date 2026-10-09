import {
  buildFrsRows,
  buildGmrsRows,
  buildPmr446Rows,
} from "../datasources.ts";
import {
  buildRowsFromClipboardText,
  computeMovedRowOrder,
  looksLikeChannelTsv,
  rowLooksNonEmpty,
  serializeRowsToTsv,
} from "../clipboard.ts";
import { rowExtras } from "../row-extra.ts";
import { requireRuntimeApi } from "./state.ts";
import { errorDetails } from "./format.ts";
import { callsignFromName } from "../callsign-lookup.ts";
import { radioEventParams, trackEvent } from "./analytics.ts";
import type { UiContext } from "../types/ui-context.js";
import type { ChannelRow, ColumnMeta, RadioMetadata } from "./channel-values.ts";
import type { RowBuilderHooks } from "../row-power.ts";
import type {
  RowEdit,
  RowEditRequest,
  RowEditResult,
  RowIssue,
} from "../runtime-rpc.ts";
import type { RadioSessionHandle } from "./state.ts";

/** A grid cell's editor: a button (Location, Extra), a select or a text input. */
type CellEditor = HTMLButtonElement | HTMLSelectElement | HTMLInputElement;

/** Which channel and column a grid cell shows. */
interface CellReference {
  rowIdx: number;
  column: string;
}

// The editable channel grid: rendering, row selection, the row operations
// (insert/remove/move/copy/cut/paste), the band-plan presets, and the
// invalid-cell highlighting the upload preflight drives. Owns the selection
// and invalid-cell state; the rows themselves live in the shared state so
// export, upload and import paths can read them.
export function createChannelTable(ctx: UiContext) {
  const { dom, state, log, actions } = ctx;
  let selectedRowIndexes = new Set<number>();
  let selectionAnchorIndex: number | null = null;
  const invalidCellKeys = new Set<string>();
  // What the runtime said about a cell, for its tooltip: the driver's
  // objection, or what normalizing the value did ("truncated to 7
  // characters"). Keyed like invalidCellKeys and cleared with them.
  const cellNotes = new Map<string, string>();

  // --- Edits checked by the runtime ---------------------------------------
  // The grid applies no column rules of its own. Every value written into a
  // row -- a committed cell, a paste, a bulk edit, a row builder's write --
  // goes to normalize_and_validate_rows
  // (web/python/webchirp_bridge/row_validation.py), which stores it by the
  // radio's own rules and runs the driver's check on the row. That call waits
  // its turn in the runtime's FIFO queue, behind a clone or a driver sweep if
  // one is running, so a committed cell shows what was typed at once, marked
  // pending, and takes the runtime's answer when it arrives.
  //
  // A row's version counts the writes made to it through the table; a
  // response is applied only while the row is still at the version it was
  // sent at and the radio session it was checked against is still
  // state.radioSession. A second edit of the row, or a change of radio,
  // discards the older answer.
  const rowVersions = new WeakMap<ChannelRow, number>();
  // The edits a row is waiting on, by column: the edit as sent, and what the
  // cell held before it, which is the fallback a rejected edit keeps and what
  // the row is sent with so a resend applies every pending edit again.
  const pendingEdits = new WeakMap<ChannelRow, Map<string, { edit: RowEdit; base: unknown }>>();
  // How many checks are in flight per row, so a row rewritten while one is
  // can be checked again as it now stands (rowsRewritten).
  const checksInFlight = new WeakMap<ChannelRow, number>();
  // How many runtime calls buildRows() may make before giving up on a builder
  // whose branches keep asking new questions. Each call answers every write a
  // run made, so a builder settles in one or two; this only stops a loop.
  const MAX_BUILD_ROUNDS = 6;
  // What a cell whose check failed says on hover.
  const UNCHECKED_NOTE = "Could not be checked against the radio's rules; see Debug Output.";

  // --- Grid rendering -----------------------------------------------------
  // This grid is the heaviest DOM in the app: every enum cell carries a full
  // CHIRP option list (tone, DTCS, mode), so a 500-channel codeplug is ~190k
  // elements and building it from scratch takes 2-3 seconds. Each row
  // operation used to pay exactly that. Three things keep the cost
  // proportional to what the user can see instead of to the codeplug:
  //   * only the rows overlapping the viewport (plus overscan) are in the DOM,
  //     with spacer rows standing in for the rest;
  //   * row elements are recycled — scrolling or editing rebinds the existing
  //     inputs and selects to different channels, which is what avoids
  //     rebuilding those option lists;
  //   * cell events are delegated to the tbody, so a recycled row needs no
  //     listener rebinding and no row carries per-cell closures.
  // Rows outside the window are still fully present in state.currentRows; only
  // their elements are absent. The trade-off is that browser find-in-page and
  // Tab only reach the rendered rows.
  const OVERSCAN_ROWS = 8;
  const ESTIMATED_ROW_HEIGHT = 30;

  // Headers the grid abbreviates, keyed by CHIRP's own column name. "Location"
  // is what CHIRP calls a channel's memory slot, and it stays the key that rows,
  // CSV files, metadata and preflight messages all use -- only the header cell
  // is shortened, because the column holds a slot number two or three digits
  // wide and the spelled-out word was what made it wide. renderHeader() keeps
  // the full name reachable from the header's tooltip and accessible name.
  const COLUMN_LABELS = new Map([["Location", "#"]]);

  // The grid's one synthetic column, appended after Comment: driver-specific
  // per-channel settings have no CSV header and no fixed shape, so the cell
  // holds a button that opens the editor (web/js/ui/channel-extra.ts) rather
  // than a value. It is not part of state.currentHeaders, which stays CHIRP's
  // own column list -- everything that serializes a row reads that, and a
  // header no CSV knows would have to be filtered back out everywhere.
  const EXTRA_COLUMN = "Extra";

  // Show the column only once something in the grid actually carries extras,
  // which is to say once a codeplug has been read from a radio or an image: a
  // driver's extras arrive with the memories it decoded. Rows typed in the grid
  // or imported from CSV have none, and neither does a radio whose driver
  // exposes no extras at all -- in both cases the column would be a button that
  // opens an empty dialog.
  function extraColumnVisible() {
    return state.currentRows.some((row) => rowExtras(row));
  }

  // The columns the grid renders: CHIRP's own, plus Extra when it applies.
  function gridColumns() {
    const columns = state.currentHeaders.slice();
    if (extraColumnVisible()) {
      columns.push(EXTRA_COLUMN);
    }
    return columns;
  }

  // The schema the current row elements were built for; a change to either
  // invalidates every editor.
  let renderedColumns: string[] = [];
  let renderedMetadata: RadioMetadata | null = null;
  let locationColumnIndex = -1;
  // The window: rowElements[i] shows channel windowStart + i.
  let rowElements: HTMLTableRowElement[] = [];
  let spacers: { above: SpacerRow; below: SpacerRow } | null = null;
  let windowStart = 0;
  let measuredRowHeight = 0;
  let windowUpdateHandle = 0;
  let isRemeasuring = false;

  function sortedSelectedRowIndexes() {
    return Array.from(selectedRowIndexes)
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < state.currentRows.length)
      .sort((a, b) => a - b);
  }

  function selectedRowsForOperations() {
    const indexes = sortedSelectedRowIndexes();
    if (indexes.length === 0) {
      return state.currentRows;
    }
    return indexes.map((idx) => state.currentRows[idx]).filter(Boolean);
  }

  // The rows the user actually selected, and only those -- never the
  // select-nothing-means-all-rows fallback above. Anything that writes to the
  // selection has to read it this way: the bulk editor asked for "the selected
  // channels" through the fallback would silently rewrite the whole codeplug.
  function selectedChannelRows() {
    return sortedSelectedRowIndexes().map((idx) => state.currentRows[idx]).filter(Boolean);
  }

  // Tell the controls that gate on a selection that it moved. The selection
  // lives here, so every path that touches it reports through this one call --
  // the click handler below, and every row operation by way of render().
  function notifySelectionChanged() {
    actions.channelSelectionChanged();
  }

  function resetRowSelection() {
    selectedRowIndexes.clear();
    selectionAnchorIndex = null;
    notifySelectionChanged();
  }

  function invalidCellKey(rowIdx: number, column: string): string {
    return `${Number(rowIdx)}:${String(column || "")}`;
  }

  function clearInvalidHighlights() {
    invalidCellKeys.clear();
    cellNotes.clear();
  }

  function clearInvalidCell(rowIdx: number, column: string): void {
    const key = invalidCellKey(rowIdx, column);
    const hadNote = cellNotes.delete(key);
    if (!invalidCellKeys.has(key) && !hadNote) {
      return;
    }
    invalidCellKeys.delete(key);
    const td = cellElement(Number(rowIdx), String(column || "")) as HTMLElement | null;
    td?.classList.remove("is-invalid");
    if (td) {
      showCellNote(td, "");
    }
  }

  // Show what the runtime said about a cell where the user hovers. The editor
  // fills its cell and may carry a title of its own -- the power legend, the
  // read-only explanation, the Extra button's label -- which the browser shows
  // in preference to the cell's, so the note goes on the editor, ahead of that
  // title, as well as on the cell. An empty note gives the editor back its own
  // title, which matters because editors are recycled across channels.
  function showCellNote(td: HTMLElement, note: string): void {
    td.title = note;
    const editor = td.children[0] as HTMLElement | undefined;
    if (!editor) {
      return;
    }
    const own = editor.dataset.ownTitle ?? "";
    editor.title = note && own ? `${note}\n\n${own}` : note || own;
  }

  // Drop the preflight highlight from the given columns of the given rows and
  // leave every other flagged cell marked. For a caller that rewrites part of
  // the grid rather than replacing it: the bulk editor (web/js/ui/channel-bulk-edit.ts)
  // writes a few columns across a selection, and clearing the whole set there
  // would take the markers off cells whose values it never touched, leaving
  // them invalid but no longer visibly so until the next upload attempt.
  function clearInvalidHighlightsForCells(
    rows: readonly ChannelRow[],
    columns: readonly string[] | null | undefined,
  ): void {
    const columnList = (columns || []).map((column) => String(column || ""));
    if (columnList.length === 0) {
      return;
    }
    for (const row of rows || []) {
      const rowIdx = state.currentRows.indexOf(row);
      if (rowIdx < 0) {
        continue;
      }
      for (const column of columnList) {
        clearInvalidCell(rowIdx, column);
      }
    }
  }

  // Selection is a per-row class, so it can be repainted without rebinding the
  // cells. Only the rows currently in the window need touching; rows outside it
  // pick the class up from bindRowElement when they scroll back in.
  function applyRowSelectionVisuals() {
    rowElements.forEach((tr, offset) => {
      const rowIdx = windowStart + offset;
      const isSelected = selectedRowIndexes.has(rowIdx);
      tr.classList.toggle("is-selected", isSelected);
      const locationButton = locationButtonIn(tr);
      if (locationButton) {
        locationButton.setAttribute("aria-pressed", isSelected ? "true" : "false");
      }
    });
  }

  function selectRowRange(fromIdx: number, toIdx: number, addToExisting: boolean): void {
    const start = Math.max(0, Math.min(fromIdx, toIdx));
    const end = Math.min(state.currentRows.length - 1, Math.max(fromIdx, toIdx));
    const next = addToExisting ? new Set(selectedRowIndexes) : new Set<number>();
    for (let idx = start; idx <= end; idx += 1) {
      next.add(idx);
    }
    selectedRowIndexes = next;
  }

  function updateRowSelectionFromLocationClick(
    event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey">,
    rowIdx: number,
  ): void {
    const wantsToggle = event.metaKey || event.ctrlKey;
    const anchor = selectionAnchorIndex;
    const wantsRange = event.shiftKey && anchor !== null && Number.isInteger(anchor);

    if (wantsRange) {
      selectRowRange(anchor, rowIdx, wantsToggle);
    } else if (wantsToggle) {
      if (selectedRowIndexes.has(rowIdx)) {
        selectedRowIndexes.delete(rowIdx);
      } else {
        selectedRowIndexes.add(rowIdx);
      }
      selectionAnchorIndex = rowIdx;
    } else {
      selectedRowIndexes = new Set([rowIdx]);
      selectionAnchorIndex = rowIdx;
    }

    applyRowSelectionVisuals();
    notifySelectionChanged();
  }

  function defaultValueForColumn(column: string): string {
    if (column === "Location") {
      return "";
    }
    const meta: Partial<ColumnMeta> = state.radioMetadata.columns?.[column] || {};
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      // CHIRP's own starting value for the column when the driver offers it
      // (get_radio_column_metadata publishes it from chirp_common.Memory()),
      // and only then the first option. options[0] is a poor default: it is
      // 67.0 on every CTCSS table and WFM on the full mode list, neither of
      // which is what CHIRP calls a new channel.
      return String(meta.default ?? meta.options[0]);
    }
    if (meta.kind === "int" && Number.isFinite(meta.min)) {
      return String(meta.min);
    }
    return "";
  }

  // The driver's memory_bounds, surfaced as the Location column's int range by
  // get_radio_column_metadata(). 147 of CHIRP's driver call sites number
  // memories from 1 rather than 0 (against 65 from 0), so nothing may assume a
  // 0 floor. With no radio selected (the generic-CSV schema) there are no
  // bounds and 0.. applies.
  function locationBounds() {
    const meta: Partial<ColumnMeta> = state.radioMetadata.columns?.Location || {};
    return {
      lo: Number.isFinite(meta.min) ? Number(meta.min) : 0,
      hi: Number.isFinite(meta.max) ? Number(meta.max) : Number.POSITIVE_INFINITY,
    };
  }

  function parsedLocation(row: ChannelRow | null | undefined): number | null {
    const value = Number.parseInt(String(row?.Location ?? "").trim(), 10);
    return Number.isInteger(value) ? value : null;
  }

  // Give every row a memory slot without disturbing the slots rows already
  // hold. A Location is data, not a row index: it says which memory the
  // channel occupies, and a codeplug read from a radio is routinely sparse
  // (the UV-5R test image fills 37 of its 128 slots, at 0-1, 25-31, 50-66,
  // 80-86 and 124-127). Renumbering to the array index used to move every
  // channel on any edit, which uploads then wrote to the wrong memories.
  // Rows keep any in-bounds Location no earlier row has claimed; the rest —
  // blank inserts, pasted rows past the end, imported rows colliding with
  // what is already loaded — take the lowest free slot.
  function assignFreeLocations() {
    if (!state.currentHeaders.includes("Location")) {
      return;
    }
    const { lo, hi } = locationBounds();
    const claimed = new Set<number>();
    const needsSlot: ChannelRow[] = [];
    for (const row of state.currentRows) {
      const location = parsedLocation(row);
      if (location === null || location < lo || location > hi || claimed.has(location)) {
        needsSlot.push(row);
        continue;
      }
      claimed.add(location);
    }
    let next = lo;
    const relocated: ChannelRow[] = [];
    for (const row of needsSlot) {
      while (claimed.has(next)) {
        next += 1;
      }
      // A full codeplug leaves the surplus rows without a slot. Blanking is
      // what keeps that visible: the upload preflight flags an empty Location
      // rather than the runtime rejecting an out-of-bounds one mid-transfer.
      const location = next > hi ? "" : String(next);
      if (row.Location !== location) {
        relocated.push(row);
      }
      row.Location = location;
      claimed.add(next);
    }
    rowsRewritten(relocated);
  }

  // The grid is a view of the radio's memories, so its order is the radio's
  // order: row N is whatever sits in the Nth occupied memory. Before the
  // Location fix that held for free, because Location *was* the row index.
  // Now that a channel keeps its own slot, an inserted row can be handed
  // memory 11 while sitting at the end of the array, so the ordering has to
  // be restored explicitly.
  function sortRowsByLocation() {
    if (!state.currentHeaders.includes("Location")) {
      return;
    }
    const keyed = state.currentRows.map((row, index) => ({
      row,
      index,
      location: parsedLocation(row),
    }));
    keyed.sort((a, b) => {
      // A row with no usable Location has no place in memory order; it sorts
      // last, keeping the order it arrived in, and the upload preflight is
      // what tells the user about it.
      if (a.location === null || b.location === null) {
        if (a.location === b.location) {
          return a.index - b.index;
        }
        return a.location === null ? 1 : -1;
      }
      return a.location - b.location || a.index - b.index;
    });
    state.currentRows = keyed.map((entry) => entry.row);
  }

  // The call every *editing* operation makes after mutating state.currentRows:
  // give slots to rows that need one, then put the list back in memory order.
  // Loading is different and calls sortRowsByLocation() alone — a file's own
  // Locations are the user's data, and a duplicate or out-of-bounds one is for
  // the upload preflight to report, not for this to silently reassign.
  function reconcileLocations() {
    assignFreeLocations();
    sortRowsByLocation();
  }

  // Row operations know which row objects they touched, not where those rows
  // end up once the list is reordered. Resolve identity to position here.
  function selectRowsByIdentity(rows: readonly ChannelRow[]): number[] {
    const positionOf = new Map(state.currentRows.map((row, index) => [row, index]));
    const indexes = rows
      .map((row) => positionOf.get(row))
      .filter((index) => index !== undefined);
    selectedRowIndexes = new Set(indexes);
    selectionAnchorIndex = indexes.length > 0 ? Math.min(...indexes) : null;
    return indexes;
  }

  function createBlankChannelRow(): ChannelRow {
    const row: ChannelRow = {};
    for (const column of state.currentHeaders) {
      row[column] = defaultValueForColumn(column);
    }
    return row;
  }

  function rowVersion(row: ChannelRow): number {
    return rowVersions.get(row) ?? 0;
  }

  // Record a write to a row, which makes any answer still in flight for it
  // stale.
  function bumpRowVersion(row: ChannelRow): number {
    const version = rowVersion(row) + 1;
    rowVersions.set(row, version);
    return version;
  }

  // What to send the runtime for a row: the row as last confirmed -- each
  // pending column back at the value it held before its edit -- and every
  // pending edit, so one answer covers them all however many were made while
  // an earlier one was in flight.
  function editRequestFor(row: ChannelRow, extra: readonly RowEdit[] = []): RowEditRequest {
    const confirmed: ChannelRow = { ...row };
    const edits: RowEdit[] = [];
    for (const [column, { edit, base }] of pendingEdits.get(row) ?? []) {
      confirmed[column] = base;
      edits.push(edit);
    }
    return { row: confirmed, edits: [...edits, ...extra] };
  }

  // Record that rows were changed outside the check path: a move or a slot
  // assignment gave them another Location, a radio change cleared a Power, an
  // extras editor rewrote their sidecar. The driver's findings depend on all
  // of that, so an answer in flight for one of these rows describes a row
  // that no longer exists and its version moves on. A row with edits still
  // pending, or with a check in flight, is checked again as it now stands --
  // otherwise it would stay pending, or lose findings the dropped answer
  // carried.
  /**
   * @param rows The rows that were rewritten.
   */
  function rowsRewritten(rows: Iterable<ChannelRow>): void {
    const recheck: ChannelRow[] = [];
    for (const row of new Set(rows)) {
      bumpRowVersion(row);
      if ((pendingEdits.get(row)?.size ?? 0) > 0 || (checksInFlight.get(row) ?? 0) > 0) {
        recheck.push(row);
      }
    }
    void checkRows(recheck);
  }

  // One normalize_and_validate_rows call for the session a handle names, or
  // for no radio.
  async function runRowCheck(handle: RadioSessionHandle | null, requests: RowEditRequest[]) {
    const sessionId = await ctx.session.idOf(handle);
    return requireRuntimeApi(state).normalizeAndValidateRows({ sessionId, rows: requests });
  }

  // Take the runtime's answer for one row: the values its edits stored, and
  // what the driver said about the row, which replaces whatever was said
  // before -- except about Location, whose duplicate check needs every row
  // and is the upload preflight's alone.
  function applyRowResult(row: ChannelRow, result: RowEditResult | undefined): void {
    for (const cell of result?.cells ?? []) {
      row[cell.column] = cell.value;
    }
    pendingEdits.delete(row);
    const rowIdx = state.currentRows.indexOf(row);
    if (rowIdx < 0 || !result) {
      return;
    }
    const channel = row.Location ?? rowIdx;
    for (const column of [...state.currentHeaders, EXTRA_COLUMN]) {
      if (column !== "Location") {
        invalidCellKeys.delete(invalidCellKey(rowIdx, column));
        cellNotes.delete(invalidCellKey(rowIdx, column));
      }
    }
    for (const cell of result.cells) {
      if (cell.note) {
        cellNotes.set(invalidCellKey(rowIdx, cell.column), cell.note);
        log.logDebug(`ROW CHECK channel=${channel} column=${cell.column}: ${cell.note}`);
      }
    }
    for (const warning of result.warnings) {
      if (warning.column) {
        cellNotes.set(invalidCellKey(rowIdx, warning.column), warning.message);
      }
      log.logDebug(`ROW CHECK WARNING channel=${channel} column=${warning.column || "?"}: ${warning.message}`);
    }
    for (const issue of result.issues) {
      if (issue.column) {
        invalidCellKeys.add(invalidCellKey(rowIdx, issue.column));
        cellNotes.set(invalidCellKey(rowIdx, issue.column), issue.message);
      }
      log.logDebug(`ROW CHECK INVALID channel=${channel} column=${issue.column || "?"}: ${issue.message}`);
    }
  }

  // A check for these rows has answered, or failed.
  function settleInFlight(rows: readonly ChannelRow[]): void {
    for (const row of rows) {
      checksInFlight.set(row, Math.max(0, (checksInFlight.get(row) ?? 1) - 1));
    }
  }

  // Put a failed row check in Debug Output in full -- for a runtime failure
  // errorDetails() is the Python traceback, not the one-line message -- and
  // say so in the status line, which stays short.
  function reportRowCheckFailure(error: unknown): void {
    log.logError(`ROW CHECK ERROR\n${errorDetails(error)}`);
    log.setStatus("Channel values could not be checked (see Debug Output).");
  }

  // Send rows to the runtime and apply each answer that is still current.
  // One call for the whole batch. An answer for a session that is no longer
  // state.radioSession is dropped, and the rows still waiting on it are sent
  // again for the radio now selected, so a radio change never leaves a cell
  // pending or normalized by the wrong driver. A failed call is reported with
  // its traceback and settles the cells it was for: each keeps the value as
  // typed, is no longer pending, and says on hover that it was not checked,
  // so the upload preflight is what will judge it.
  async function checkRows(rows: readonly ChannelRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const handle = state.radioSession;
    const versions = rows.map(rowVersion);
    const stillWaiting = () => rows.filter((row, index) => rowVersion(row) === versions[index]);
    for (const row of rows) {
      checksInFlight.set(row, (checksInFlight.get(row) ?? 0) + 1);
    }
    let response: Awaited<ReturnType<typeof runRowCheck>> | null = null;
    try {
      response = await runRowCheck(handle, rows.map((row) => editRequestFor(row)));
    } catch (error) {
      settleInFlight(rows);
      if (state.radioSession !== handle) {
        return checkRows(stillWaiting());
      }
      reportRowCheckFailure(error);
      for (const row of stillWaiting()) {
        const rowIdx = state.currentRows.indexOf(row);
        for (const column of pendingEdits.get(row)?.keys() ?? []) {
          if (rowIdx >= 0) {
            cellNotes.set(invalidCellKey(rowIdx, column), UNCHECKED_NOTE);
          }
        }
        pendingEdits.delete(row);
      }
      renderRowWindow();
      return;
    }
    settleInFlight(rows);
    if (state.radioSession !== handle) {
      return checkRows(stillWaiting());
    }
    rows.forEach((row, index) => {
      if (rowVersion(row) === versions[index]) {
        applyRowResult(row, response?.rows?.[index]);
      }
    });
    renderRowWindow();
  }

  // Write edits into rows at once, as typed, and have the runtime check them.
  // Each row shows its typed values marked pending until its answer arrives.
  // base gives the value a column held before the edit, for a caller that has
  // already written the typed value into the row (paste builds its rows that
  // way); otherwise the row's current value is it.
  /**
   * @param requests Each row with the edits to apply to it, in order.
   */
  function submitRowEdits(
    requests: ReadonlyArray<{ row: ChannelRow; edits: readonly RowEdit[]; base?: ChannelRow }>,
  ): Promise<void> {
    for (const { row, edits, base } of requests) {
      const pending = pendingEdits.get(row) ?? new Map<string, { edit: RowEdit; base: unknown }>();
      for (const edit of edits) {
        const previous = pending.has(edit.column)
          ? pending.get(edit.column)?.base
          : (base && Object.hasOwn(base, edit.column) ? base[edit.column] : row[edit.column]);
        // Delete first so the column moves to the end: edits apply in the
        // order they were made.
        pending.delete(edit.column);
        pending.set(edit.column, { edit, base: previous });
        row[edit.column] = edit.value;
      }
      if (pending.size > 0) {
        pendingEdits.set(row, pending);
      }
      bumpRowVersion(row);
    }
    renderRowWindow();
    return checkRows(requests.map(({ row }) => row));
  }

  // Check edits without writing them, for a caller that must know every value
  // is acceptable before it changes anything (the bulk editor). One call.
  // Resolves to null when the call failed; otherwise to the answers and an
  // apply() that writes them -- refusing, and returning false, if any row was
  // written or the radio changed since.
  /**
   * @param requests Each row with the edits it would take, in order.
   */
  async function previewRowEdits(
    requests: ReadonlyArray<{ row: ChannelRow; edits: readonly RowEdit[] }>,
  ): Promise<{ results: RowEditResult[]; apply: () => boolean } | null> {
    const handle = state.radioSession;
    const rows = requests.map(({ row }) => row);
    const versions = rows.map(rowVersion);
    let response: Awaited<ReturnType<typeof runRowCheck>>;
    try {
      response = await runRowCheck(handle, requests.map(({ row, edits }) => editRequestFor(row, edits)));
    } catch (error) {
      reportRowCheckFailure(error);
      return null;
    }
    const results = rows.map((_row, index) => response?.rows?.[index] ?? { cells: [], issues: [], warnings: [] });
    return {
      results,
      apply() {
        if (state.radioSession !== handle || rows.some((row, index) => rowVersion(row) !== versions[index])) {
          return false;
        }
        rows.forEach((row, index) => {
          bumpRowVersion(row);
          applyRowResult(row, results[index]);
        });
        return true;
      },
    };
  }

  // Run a row builder (web/js/repeater-rows.ts, web/js/datasources.ts) against
  // the runtime's rules. A builder decides as it writes -- a repeater whose access
  // tone the radio cannot send is left out, a tone mode is committed only once
  // its tone was taken -- so it needs each write's verdict on the spot, and
  // those come from Python. So the builder is run, writes it has no verdict
  // for are taken as typed and sent in one call per round, and it is run again
  // with the answers, until a run asks for nothing new. A builder is a pure
  // function of its input and these hooks, so a rerun builds afresh; most
  // imports settle after one call, and a branch a rejection opened takes one
  // more. Verdicts are only good for the radio they came from: an answer that
  // arrives after the selection moved on is dropped with every verdict
  // gathered so far, and the builder starts over against the radio now
  // selected -- as a pending cell edit is sent again (checkRows).
  /**
   * @param build The builder, given the grid's row hooks.
   * @returns Whatever the last run of build returned.
   */
  async function buildRows<T>(build: (hooks: RowBuilderHooks) => T): Promise<T> {
    // Verdict per (column, value, previous): what the row held decides what a
    // rejected write leaves behind.
    const verdicts = new Map<string, { value: string; accepted: boolean }>();
    const verdictKey = (column: string, value: string, previous: unknown) =>
      JSON.stringify([column, value, previous === undefined ? null : String(previous)]);
    let handle = state.radioSession;
    for (let round = 0; ; round += 1) {
      // Per row the builder created this run: the blank row it started from
      // and every write it made, in order, so the runtime replays them with
      // the same fallbacks.
      const writes = new Map<ChannelRow, { base: ChannelRow; edits: RowEdit[]; missed: boolean }>();
      const hooks: RowBuilderHooks = {
        createBlankRow() {
          const row = createBlankChannelRow();
          writes.set(row, { base: { ...row }, edits: [], missed: false });
          return row;
        },
        setRowValue(row, column, value) {
          if (!state.currentHeaders.includes(column)) {
            return false;
          }
          const text = String(value ?? "");
          let record = writes.get(row);
          if (!record) {
            record = { base: { ...row }, edits: [], missed: false };
            writes.set(row, record);
          }
          record.edits.push({ column, value: text, allowReadOnly: true });
          const known = verdicts.get(verdictKey(column, text, row[column]));
          if (known) {
            row[column] = known.value;
            return known.accepted;
          }
          record.missed = true;
          row[column] = text;
          return true;
        },
        findEnumOption,
      };
      const built = build(hooks);
      const asked = [...writes.values()].filter((record) => record.missed);
      if (asked.length === 0) {
        return built;
      }
      if (round >= MAX_BUILD_ROUNDS) {
        throw new Error(`Row builder did not settle after ${MAX_BUILD_ROUNDS} runtime checks`);
      }
      let response: Awaited<ReturnType<typeof runRowCheck>>;
      try {
        response = await runRowCheck(handle, asked.map(({ base, edits }) => ({ row: base, edits })));
      } catch (error) {
        // A handle closed under the call fails in idOf(); that is the same
        // radio change as a stale answer, not a failed check.
        if (!ctx.session.isCurrent(handle)) {
          verdicts.clear();
          handle = state.radioSession;
          continue;
        }
        throw error;
      }
      if (!ctx.session.isCurrent(handle)) {
        verdicts.clear();
        handle = state.radioSession;
        continue;
      }
      asked.forEach(({ base, edits }, index) => {
        const current: ChannelRow = { ...base };
        (response?.rows?.[index]?.cells ?? []).forEach((cell, editIndex) => {
          const edit = edits[editIndex];
          if (!edit) {
            return;
          }
          verdicts.set(verdictKey(edit.column, edit.value, current[edit.column]), {
            value: cell.value,
            accepted: cell.accepted,
          });
          current[edit.column] = cell.value;
        });
      });
    }
  }

  // Resolve a caller's ranked list of choices against the column's own option
  // list, returning the first one the driver offers (or "" when it offers
  // none). The ranking is the point: a repeater builder asks for
  // ["FM", "NFM", "FMN"] and takes whichever spelling this driver uses.
  function findEnumOption(column: string, choices: readonly string[], caseInsensitive = false): string {
    if (!state.currentHeaders.includes(column)) {
      return "";
    }
    const meta = state.radioMetadata.columns?.[column];
    // A column with no driver metadata behind it is unconstrained, not
    // unsupported. Until a radio is selected the grid runs on the startup
    // schema (loadEmptySchema in web/js/ui/codeplug-io.ts), which seeds
    // CHIRP's generic CSV headers with no columns behind them, and the
    // runtime checks a write then against the permissive default schema. This
    // has to agree with it: reading the absent option list as "the radio refuses
    // this" made every repeater builder skip every record it was given, so a
    // directory query fetched hundreds of repeaters and inserted none, blaming
    // a selected radio that did not exist.
    if (!meta) {
      return String(choices[0] ?? "");
    }
    const options = Array.isArray(meta.options) ? meta.options.map(String) : [];
    if (caseInsensitive) {
      const normalized = new Map(options.map((option) => [option.toLowerCase(), option]));
      for (const choice of choices) {
        const match = normalized.get(String(choice || "").toLowerCase());
        if (match) {
          return match;
        }
      }
      return "";
    }
    for (const choice of choices) {
      if (options.includes(choice)) {
        return choice;
      }
    }
    return "";
  }


  // Clear any Power the newly selected driver does not advertise, and report
  // how many rows that touched.
  //
  // Power is the one column whose vocabulary is private to a driver: "High",
  // "Hi", "L3" and "0.1W" all name the same kind of thing in different words,
  // while Mode "FM" and Tone "TSQL" come from lists CHIRP shares across every
  // radio. So a Power carried over from another schema -- a channel built
  // before a radio was selected, or under a different driver -- is not a value
  // the new driver disagrees with, it is a word it does not speak, and the
  // upload preflight rejects the whole row for it ("Power '0.1W' is not
  // supported by this radio"). Clearing it means "no level chosen", which is
  // what a new CHIRP memory holds and what the runtime already writes as the
  // driver's own default (_resolve_power_level in
  // web/python/webchirp_bridge/power_levels.py).
  function dropUnsupportedPowerValues() {
    if (!state.currentHeaders.includes("Power")) {
      return 0;
    }
    const options = state.radioMetadata.columns?.Power?.options;
    // No option list is a driver that has published nothing about power, so
    // there is nothing to measure a row against.
    if (!Array.isArray(options) || options.length === 0) {
      return 0;
    }
    const spoken = new Set(options.map(String));
    const cleared: ChannelRow[] = [];
    for (const row of state.currentRows) {
      const value = String(row.Power ?? "");
      if (value !== "" && !spoken.has(value)) {
        row.Power = "";
        cleared.push(row);
      }
    }
    rowsRewritten(cleared);
    return cleared.length;
  }

  // A row counts as a real channel when it has a usable frequency or a name;
  // blank inserted rows should not trigger the data-loss prompt.
  function hasRealChannels() {
    return state.currentRows.some((row) => {
      const frequency = Number.parseFloat(String(row?.Frequency ?? ""));
      if (Number.isFinite(frequency) && frequency > 0) {
        return true;
      }
      return String(row?.Name ?? "").trim() !== "";
    });
  }

  function insertNewChannelRow() {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }

    // Where the row is spliced no longer decides anything: it takes the
    // lowest free memory and then sorts into place by that.
    const inserted = createBlankChannelRow();
    state.currentRows.push(inserted);
    reconcileLocations();
    clearInvalidHighlights();

    selectRowsByIdentity([inserted]);
    render();
    log.setStatus(`Inserted new channel at memory ${inserted.Location || "(none free)"}.`);
  }

  function insertRowsAtSelectionOrEnd(rowsToInsert: ChannelRow[], label: string): boolean {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return false;
    }
    if (!Array.isArray(rowsToInsert) || rowsToInsert.length === 0) {
      log.setStatus(`No ${label} entries to insert.`);
      return false;
    }
    state.currentRows.push(...rowsToInsert);
    // Every bulk insert lands here — repeater queries, RSGB queries, band-plan
    // presets — and each one makes the codeplug no longer purely whatever it
    // was read from. Reporting an upload of that as "radio" would answer the
    // provenance question wrongly on exactly the path it exists for.
    state.codeplugSource = "mixed";
    reconcileLocations();
    clearInvalidHighlights();

    selectRowsByIdentity(rowsToInsert);
    render();
    const firstLocation = rowsToInsert[0]?.Location;
    log.setStatus(
      firstLocation
        ? `Inserted ${rowsToInsert.length} ${label} channel(s) from memory ${firstLocation}.`
        : `Inserted ${rowsToInsert.length} ${label} channel(s).`,
    );
    // The builder already applied the column rules; now that the rows have
    // memories, one call has the driver judge them where they landed.
    void checkRows(rowsToInsert);
    return true;
  }

  // Remove exactly these row objects. Identity-based so a removal captured
  // before an await (Cut's clipboard write) deletes the rows that were
  // serialized even if the selection or row order changed while it was
  // pending. Returns how many rows were actually removed.
  function removeChannelRows(rowsToRemove: Iterable<ChannelRow>): number {
    const identity = new Set(rowsToRemove);
    const firstIndex = state.currentRows.findIndex((row) => identity.has(row));
    const before = state.currentRows.length;
    state.currentRows = state.currentRows.filter((row) => !identity.has(row));
    const removed = before - state.currentRows.length;
    if (removed === 0) {
      return 0;
    }
    // No reassignment: removing a channel frees its memory and leaves every
    // surviving channel where it was.
    clearInvalidHighlights();

    resetRowSelection();
    if (state.currentRows.length > 0) {
      const nextIndex = Math.min(firstIndex, state.currentRows.length - 1);
      selectedRowIndexes = new Set([nextIndex]);
      selectionAnchorIndex = nextIndex;
    }
    render();
    return removed;
  }

  function removeSelectedChannelRows() {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      log.setStatus("Select one or more channels to remove.");
      return;
    }
    const removed = removeChannelRows(selectedIndexes.map((idx) => state.currentRows[idx]));
    log.setStatus(`Removed ${removed} selected channel(s).`);
  }

  // Move each selected row by one position, preserving relative order and
  // clamping at the edges. The memory slots stay where they are and the
  // channels rotate through them, so moving a channel up swaps its memory
  // with its neighbour's instead of renumbering the whole codeplug. That
  // keeps the set of occupied memories — and so a sparse layout — intact.
  function moveSelectedChannelRows(direction: number): void {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      log.setStatus("Select one or more channels to move.");
      return;
    }
    const { order, selected, moved } = computeMovedRowOrder(
      state.currentRows.length,
      selectedIndexes,
      direction,
    );
    if (!moved) {
      log.setStatus(
        direction < 0
          ? "Selected channels are already at the top."
          : "Selected channels are already at the bottom.",
      );
      return;
    }
    const locationsByPosition = state.currentRows.map((row) => row.Location);
    const movedRows = selectedIndexes.map((idx) => state.currentRows[idx]);
    state.currentRows = order.map((idx) => state.currentRows[idx]);
    if (state.currentHeaders.includes("Location")) {
      const relocated: ChannelRow[] = [];
      state.currentRows.forEach((row, idx) => {
        if (row.Location !== locationsByPosition[idx]) {
          relocated.push(row);
        }
        row.Location = locationsByPosition[idx];
      });
      rowsRewritten(relocated);
    }
    // Slots were reassigned along the already-ascending positions, so the
    // list is still in memory order and this sort is a no-op — it runs so the
    // invariant holds from one place rather than by argument.
    reconcileLocations();
    clearInvalidHighlights();

    const movedIndexes = selectRowsByIdentity(movedRows);
    // Shift-click extends from the edge the selection travelled towards.
    if (movedIndexes.length > 0) {
      selectionAnchorIndex =
        direction < 0 ? Math.min(...movedIndexes) : Math.max(...movedIndexes);
    }
    render();
    log.setStatus(`Moved ${selected.length} channel(s) ${direction < 0 ? "up" : "down"}.`);
  }

  function hasDomTextSelection() {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && String(selection).trim() !== "");
  }

  // Channel clipboard/reorder shortcuts only apply in the channel view, with
  // no modal open and no cell editor (or other field) focused. Copy/cut also
  // defer to a regular DOM text selection (e.g. copying Debug Output text).
  function channelShortcutsActive(
    event: Event,
    { respectTextSelection = false }: { respectTextSelection?: boolean } = {},
  ): boolean {
    if (state.currentEditorView !== "channels") {
      return false;
    }
    if (actions.isAnyModalOpen()) {
      return false;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, select, textarea, [contenteditable='true'], [contenteditable='']")
    ) {
      return false;
    }
    if (respectTextSelection && hasDomTextSelection()) {
      return false;
    }
    return true;
  }

  // Serialize the explicitly selected rows (never the select-nothing-means-
  // all-rows fallback: cut would otherwise silently delete every channel).
  function selectedChannelTsv(actionLabel: string): { tsv: string; count: number; rows: ChannelRow[] } | null {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      log.setStatus(`Select one or more channels to ${actionLabel}.`);
      return null;
    }
    const rows = selectedIndexes.map((idx) => state.currentRows[idx]);
    return {
      tsv: serializeRowsToTsv(rows),
      count: rows.length,
      rows,
    };
  }

  function copySelectedChannels(event: ClipboardEvent): void {
    const payload = selectedChannelTsv("copy");
    // A copy event always carries its clipboard; null only for a synthetic one.
    if (!payload || !event.clipboardData) {
      return;
    }
    event.clipboardData.setData("text/plain", payload.tsv);
    event.preventDefault();
    log.setStatus(`Copied ${payload.count} channel(s) to clipboard.`);
  }

  function cutSelectedChannels(event: ClipboardEvent): void {
    const payload = selectedChannelTsv("cut");
    if (!payload || !event.clipboardData) {
      return;
    }
    event.clipboardData.setData("text/plain", payload.tsv);
    event.preventDefault();
    const removed = removeChannelRows(payload.rows);
    log.setStatus(`Cut ${removed} channel(s) to clipboard.`);
  }

  async function writeChannelTsvToClipboard(actionLabel: string, remove: boolean): Promise<void> {
    const payload = selectedChannelTsv(actionLabel);
    if (!payload) {
      return;
    }
    if (!navigator.clipboard?.writeText) {
      log.setStatus(`Clipboard write not available; press Ctrl+${remove ? "X" : "C"} / Cmd+${remove ? "X" : "C"} instead.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.tsv);
    } catch (error) {
      log.logError(`CLIPBOARD write failed: ${error}`);
      log.setStatus(`Clipboard write blocked; press Ctrl+${remove ? "X" : "C"} / Cmd+${remove ? "X" : "C"} instead.`);
      return;
    }
    if (remove) {
      // The write may have been parked behind a permission prompt; delete the
      // rows that were serialized, not whatever is selected now.
      const removed = removeChannelRows(payload.rows);
      log.setStatus(`Cut ${removed} channel(s) to clipboard.`);
    } else {
      log.setStatus(`Copied ${payload.count} channel(s) to clipboard.`);
    }
  }

  // Paste-overwrite starting at the first selected row (CHIRP desktop
  // semantics): pasted rows replace existing rows downward, extend the list
  // past the end, and require confirmation when non-empty rows would be
  // overwritten. With no selection, pasted rows append at the end.
  function pasteChannelsFromText(text: string): void {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    if (!looksLikeChannelTsv(text)) {
      log.setStatus("Clipboard does not contain tab-separated channel data.");
      return;
    }
    // Pasted values go into the rows as typed and are recorded as edits, so
    // the whole paste is normalized and checked by the runtime in one call
    // once the rows have their memories (submitRowEdits below). The blank row
    // each one started as is the fallback a rejected value keeps.
    const pastedEdits = new Map<ChannelRow, { base: ChannelRow; edits: RowEdit[] }>();
    const built = buildRowsFromClipboardText(text, {
      createBlankRow() {
        const row = createBlankChannelRow();
        pastedEdits.set(row, { base: { ...row }, edits: [] });
        return row;
      },
      setRowValue(row, column, value) {
        if (!state.currentHeaders.includes(column)) {
          return false;
        }
        const typed = String(value ?? "");
        row[column] = typed;
        pastedEdits.get(row)?.edits.push({ column, value: typed, allowReadOnly: true });
        return true;
      },
    });
    const rows = built?.rows ?? [];
    if (rows.length === 0) {
      log.setStatus("No channels found in pasted text.");
      return;
    }
    // Paste lands on consecutive *memories* from the selected channel's own
    // memory, not on consecutive rows. On a sparse codeplug those differ: the
    // rows below memory 26 might be 124 and 127, and walking rows would fling
    // a pasted block across the radio and clobber distant channels it never
    // named. With nothing selected there is no anchor, so the block goes to
    // the lowest free memories instead.
    const selectedIndexes = sortedSelectedRowIndexes();
    const keepsLocation = state.currentHeaders.includes("Location");
    const { hi } = locationBounds();
    const anchorLocation =
      keepsLocation && selectedIndexes.length > 0
        ? parsedLocation(state.currentRows[selectedIndexes[0]])
        : null;
    const rowByLocation = new Map();
    if (anchorLocation !== null) {
      for (const row of state.currentRows) {
        const location = parsedLocation(row);
        if (location !== null) {
          rowByLocation.set(location, row);
        }
      }
    }
    // Target memory per pasted row, or null where the block runs past the end
    // of the radio and reconcileLocations() has to find somewhere for it.
    const targetLocations = rows.map((_row, offset) => {
      if (anchorLocation === null) {
        return null;
      }
      const location = anchorLocation + offset;
      return location <= hi ? location : null;
    });
    const overwriteLocations: string[] = [];
    targetLocations.forEach((location) => {
      if (location === null) {
        return;
      }
      const target = rowByLocation.get(location);
      if (target && rowLooksNonEmpty(target)) {
        overwriteLocations.push(String(location));
      }
    });
    if (overwriteLocations.length > 0) {
      const summary =
        overwriteLocations.length === 1
          ? `channel ${overwriteLocations[0]}`
          : overwriteLocations.length > 10
            ? `${overwriteLocations.length} existing channels`
            : `channels ${overwriteLocations.join(", ")}`;
      if (!window.confirm(`Pasted channels will overwrite ${summary}. Continue?`)) {
        log.setStatus("Paste cancelled.");
        return;
      }
    }
    rows.forEach((row, offset) => {
      const location = targetLocations[offset];
      if (location === null) {
        // No anchor, or past the last memory: reconcileLocations() places it.
        state.currentRows.push(row);
        return;
      }
      // The pasted channel takes the memory it lands on rather than the one it
      // was copied from — pasting between codeplugs must not drag the source's
      // numbering across.
      row.Location = String(location);
      const target = rowByLocation.get(location);
      const at = target ? state.currentRows.indexOf(target) : -1;
      if (at >= 0) {
        state.currentRows[at] = row;
      } else {
        state.currentRows.push(row);
      }
    });
    reconcileLocations();
    clearInvalidHighlights();

    selectRowsByIdentity(rows);
    render();
    const firstLocation = rows[0]?.Location;
    log.setStatus(
      firstLocation
        ? `Pasted ${rows.length} channel(s) from memory ${firstLocation}.`
        : `Pasted ${rows.length} channel(s).`,
    );
    void submitRowEdits(rows.map((row) => ({
      row,
      edits: pastedEdits.get(row)?.edits ?? [],
      base: pastedEdits.get(row)?.base,
    })));
  }

  async function pasteChannelsViaApi() {
    if (!navigator.clipboard?.readText) {
      log.setStatus("Clipboard read not available; press Ctrl+V / Cmd+V in the channel view instead.");
      return;
    }
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (error) {
      log.logError(`CLIPBOARD read failed: ${error}`);
      log.setStatus("Clipboard read blocked; press Ctrl+V / Cmd+V in the channel view instead.");
      return;
    }
    pasteChannelsFromText(text);
  }

  async function addBandPlanChannels(
    builder: (hooks: RowBuilderHooks) => ChannelRow[],
    label: string,
  ): Promise<void> {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    let rows: ChannelRow[];
    try {
      rows = await buildRows(builder);
    } catch (error) {
      log.reportActionError(`Add ${label} channels`, error);
      return;
    }
    insertRowsAtSelectionOrEnd(rows, label);
    // Which band plan gets used is a rough read on where users are: GMRS and
    // FRS are US, PMR446 is European.
    trackEvent("preset_channels_added", {
      ...radioEventParams(state.selectedRadio),
      preset: label,
      channel_count: rows.length,
    });
  }

  // A driver's power labels ("Hi", "L3", "Mid1") carry no wattage, so spell the
  // driver's own table out on hover. Column-level, not row-level: valid_power_levels
  // is all the driver publishes, and a driver that reuses a label across bands
  // (vx6's 220MHz list) advertises only one of the two wattages — so this describes
  // the levels the driver offers, not what a given channel transmits.
  function columnLegend(column: string): string {
    const meta: Partial<ColumnMeta> = state.radioMetadata.columns?.[column] || {};
    const watts = meta.optionWatts;
    if (!watts || typeof watts !== "object") {
      return "";
    }
    const entries = (Array.isArray(meta.options) ? meta.options.map(String) : [])
      .filter((option) => watts[option])
      .map((option) => `${option} = ${watts[option]}`);
    return entries.length ? `Driver power levels: ${entries.join(", ")}` : "";
  }

  // Create a table cell editor (input/select) from the CHIRP column metadata.
  // Structure only — kind, options and read-only state depend on the column,
  // never on a row — so the element stays valid for any row until the schema
  // changes. bindCellEditor() is what puts a row's data into it.
  function createCellEditor(column: string): CellEditor {
    const meta: Partial<ColumnMeta> = state.radioMetadata.columns?.[column] || {};
    const readOnly = column === "Location" || meta.editable === false;

    // Grey out read-only cells and explain why; Location is excluded because
    // its button is the row-selection handle, not a disabled editor.
    function markReadOnly<T extends HTMLElement>(editor: T): T {
      if (readOnly && column !== "Location") {
        editor.classList.add("readonly-cell");
        editor.title = `${column} is read-only for this radio.`;
      }
      return editor;
    }
    if (column === "Location") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "channel-location-button";
      return button;
    }
    if (column === EXTRA_COLUMN) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "channel-extra-button";
      button.textContent = "Edit";
      button.title = "Edit this channel's driver-specific settings";
      return button;
    }
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      const select = document.createElement("select");
      for (const opt of meta.options.map(String)) {
        const optionEl = document.createElement("option");
        optionEl.value = opt;
        optionEl.textContent = opt;
        select.appendChild(optionEl);
      }
      // How many options came from the driver, so bindCellEditor can tell them
      // apart from one it had to add for an off-list row value.
      select.dataset.driverOptions = String(select.children.length);
      select.disabled = readOnly;
      // Before markReadOnly, which has a more urgent tooltip to show.
      const legend = columnLegend(column);
      if (legend) {
        select.title = legend;
      }
      return markReadOnly(select);
    }

    const input = document.createElement("input");
    input.type = "text";
    // Ask the browser for no width of its own: the column is sized from the
    // value this holds, by field-sizing in web/styles.css. Left at its default
    // the control would claim twenty average characters plus a one-character
    // surcharge whatever the channel holds. Where field-sizing is missing the
    // size attribute is still what governs, so columns there fall back to their
    // header widths rather than to that default.
    input.size = 1;
    input.readOnly = readOnly;
    input.disabled = readOnly;
    if (Number.isFinite(meta.maxLength)) {
      input.maxLength = Number(meta.maxLength);
    }
    return markReadOnly(input);
  }

  function bindCellEditor(editor: CellEditor, row: ChannelRow, column: string): void {
    if (column === EXTRA_COLUMN) {
      // Nothing to bind: the button is identical for every row, and marking
      // the ones carrying stored extras would mark every row a download
      // produced -- the runtime records a value for each of them.
      return;
    }
    const value = String(row[column] ?? "");
    if (editor.tagName === "BUTTON") {
      editor.textContent = value;
      return;
    }
    if (editor.tagName !== "SELECT") {
      editor.value = value;
      return;
    }
    // Drop any option added for a previous occupant of this recycled element,
    // so the list a row offers is the driver's plus at most that row's own
    // off-list value — exactly what a freshly built select would show.
    // Only a select is left: its option count is what this trims back.
    const select = editor as HTMLSelectElement;
    const driverOptions = Number(select.dataset.driverOptions);
    if (Number.isInteger(driverOptions) && select.length > driverOptions) {
      select.length = driverOptions;
    }
    editor.value = value;
    if (value !== "" && editor.value !== value) {
      // The stored value is outside this driver's option list (a hand-edited or
      // imported codeplug). Show what is really there rather than silently
      // snapping the cell to some other value.
      const optionEl = document.createElement("option");
      optionEl.value = value;
      optionEl.textContent = value;
      editor.appendChild(optionEl);
      editor.value = value;
    }
  }

  // Build one row's elements. Called only when the window grows or the schema
  // changes — never per render.
  function createRowElement() {
    const tr = document.createElement("tr");
    for (const column of renderedColumns) {
      const td = document.createElement("td");
      td.dataset.column = String(column);
      const editor = createCellEditor(column);
      // The title the editor was built with, for showCellNote to put back.
      editor.dataset.ownTitle = editor.title;
      td.appendChild(editor);
      tr.appendChild(td);
    }
    return tr;
  }

  // Point an existing row element at a model row: values, selection and
  // invalid-cell classes. This is the whole per-row cost of a render.
  function bindRowElement(tr: HTMLTableRowElement, rowIdx: number): void {
    const row = state.currentRows[rowIdx];
    if (!row) {
      return;
    }
    tr.dataset.rowIdx = String(rowIdx);
    const isSelected = selectedRowIndexes.has(rowIdx);
    tr.classList.toggle("is-selected", isSelected);
    const pending = pendingEdits.get(row);
    renderedColumns.forEach((column, columnIdx) => {
      const td = tr.children[columnIdx] as HTMLElement;
      const key = invalidCellKey(rowIdx, column);
      td.classList.toggle("is-invalid", invalidCellKeys.has(key));
      // Typed but not yet answered by the runtime: the value shown is what was
      // typed, and may still change (web/styles.css dims it).
      td.classList.toggle("is-pending", Boolean(pending?.has(column)));
      showCellNote(td, cellNotes.get(key) ?? "");
      // Each cell holds the one editor createRowElement() put there.
      bindCellEditor(td.children[0] as CellEditor, row, column);
    });
    const locationButton = locationButtonIn(tr);
    if (locationButton) {
      locationButton.setAttribute("aria-pressed", isSelected ? "true" : "false");
      // Mark the cells the context map (web/js/ui/repeater-map.ts) will look up
      // on hover -- the ones whose channel name is a callsign. Whether the
      // directory actually knows that callsign is only answerable over the
      // network, so this marks what is worth hovering, not what has a map.
      locationButton.classList.toggle("has-callsign", Boolean(callsignFromName(row.Name)));
    }
  }

  function locationButtonIn(tr: HTMLTableRowElement): Element | null {
    if (locationColumnIndex < 0) {
      return null;
    }
    return tr.children[locationColumnIndex]?.children[0] || null;
  }

  function cellElement(rowIdx: number, column: string): Element | null {
    const tr = rowElements[rowIdx - windowStart];
    if (!tr || tr.dataset.rowIdx !== String(rowIdx)) {
      return null;
    }
    const columnIdx = renderedColumns.indexOf(column);
    return columnIdx < 0 ? null : tr.children[columnIdx] || null;
  }

  // A spacer row stands in for the rows kept out of the DOM, so the scrollbar
  // and the scroll position match the full channel list.
  type SpacerRow = { tr: HTMLTableRowElement; cell: HTMLTableCellElement };
  function createSpacerRow(): SpacerRow {
    const tr = document.createElement("tr");
    tr.className = "mem-row-spacer";
    tr.setAttribute("aria-hidden", "true");
    const cell = document.createElement("td");
    cell.colSpan = Math.max(1, renderedColumns.length);
    tr.appendChild(cell);
    return { tr, cell };
  }

  function schemaChanged(columns: readonly string[]): boolean {
    return renderedMetadata !== state.radioMetadata
      || columns.length !== renderedColumns.length
      || columns.some((column, idx) => column !== renderedColumns[idx]);
  }

  function renderHeader() {
    dom.tableHead.innerHTML = "";
    const headerRow = document.createElement("tr");
    renderedColumns.forEach((column) => {
      const th = document.createElement("th");
      // Cells carry this already; the header needs it too, because the Extra
      // column is pinned to the right edge from the stylesheet and both halves
      // of the column have to be selectable there.
      th.dataset.column = String(column);
      const label = COLUMN_LABELS.get(column) ?? column;
      th.textContent = label;
      // Mirror the cell treatment: grey + tooltip on headers of columns the
      // selected radio marks read-only (Location stays the selection handle).
      const meta: Partial<ColumnMeta> = state.radioMetadata.columns?.[column] || {};
      const legend = columnLegend(column);
      if (legend) {
        th.title = legend;
      }
      if (column === EXTRA_COLUMN) {
        th.title = "Driver-specific settings this radio keeps per channel";
      }
      if (meta.editable === false && column !== "Location") {
        th.classList.add("readonly-cell");
        th.title = `${column} is read-only for this radio.`;
      }
      // An abbreviated header still has to say which column it is: the full
      // name becomes the cell's accessible name, so a screen reader announces
      // it with every cell in the column, and its tooltip unless a more urgent
      // one above already claimed it.
      if (label !== column) {
        th.setAttribute("aria-label", column);
        if (!th.title) {
          th.title = column;
        }
      }
      headerRow.appendChild(th);
    });
    dom.tableHead.appendChild(headerRow);
  }

  function discardRowElements() {
    dom.tableBody.innerHTML = "";
    rowElements = [];
    spacers = null;
    windowStart = 0;
    // Row height is a property of the editors, so it has to be re-measured
    // whenever they are rebuilt.
    measuredRowHeight = 0;
  }

  // Which slice of the channel list has to exist in the DOM.
  function visibleRowRange() {
    const total = state.currentRows.length;
    const viewportHeight = dom.tableScrollEl.clientHeight;
    // Headless callers (the tests' DOM stub) have no layout to virtualize
    // against; render every row so assertions see the whole grid.
    if (!Number.isFinite(viewportHeight)) {
      return { start: 0, count: total };
    }
    const rowHeight = measuredRowHeight || ESTIMATED_ROW_HEIGHT;
    const windowSize = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + OVERSCAN_ROWS * 2;
    // The header scrolls with the rows, so it offsets every row's position.
    const headerHeight = dom.tableHead.getBoundingClientRect?.().height || 0;
    const scrollTop = (Number(dom.tableScrollEl.scrollTop) || 0) - headerHeight;
    const firstVisible = Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS;
    const start = Math.max(0, Math.min(firstVisible, total - windowSize));
    return { start, count: Math.max(0, Math.min(windowSize, total - start)) };
  }

  // Grow or shrink the pool of row elements. Elements that survive are put back
  // in place rather than rebuilt, so only the size change costs anything.
  function syncRowElementCount(count: number): void {
    if (rowElements.length === count && spacers) {
      return;
    }
    while (rowElements.length < count) {
      rowElements.push(createRowElement());
    }
    rowElements.length = count;
    if (!spacers) {
      spacers = { above: createSpacerRow(), below: createSpacerRow() };
    }
    dom.tableBody.innerHTML = "";
    dom.tableBody.appendChild(spacers.above.tr);
    for (const tr of rowElements) {
      dom.tableBody.appendChild(tr);
    }
    dom.tableBody.appendChild(spacers.below.tr);
  }

  function applySpacerHeights(start: number, count: number): void {
    if (!spacers) {
      return;
    }
    const rowHeight = measuredRowHeight || ESTIMATED_ROW_HEIGHT;
    const below = Math.max(0, state.currentRows.length - start - count);
    spacers.above.cell.style.height = `${Math.round(start * rowHeight)}px`;
    spacers.below.cell.style.height = `${Math.round(below * rowHeight)}px`;
  }

  // Returns whether the height changed, i.e. whether the window that was just
  // laid out against the previous value is now wrong.
  function measureRowHeight() {
    const height = rowElements[0]?.getBoundingClientRect?.().height;
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - measuredRowHeight) < 0.5) {
      return false;
    }
    measuredRowHeight = height;
    return true;
  }

  // Row elements are recycled by position, so a scroll hands the focused editor
  // to a different channel. What is in the editor travels with the capture as
  // raw text and goes back verbatim, rather than being committed here: a
  // half-typed frequency ("146.") does not validate, and committing it would
  // write the previous value back over the caret on every scroll tick and
  // ResizeObserver call (issue #94). A value is committed only when the user
  // really leaves the cell — blur, Enter, or a toolbar click, which blurs the
  // editor before it fires.
  function captureFocusedCell() {
    const active = globalThis.document?.activeElement;
    // Only an editor holds an uncommitted value. The Location button is
    // focusable but is the row-selection handle, not an editor: committing
    // through it would push its empty .value at the Location column, which
    // only the runtime's read-only rule (normalize_cell in
    // web/python/webchirp_bridge/row_normalization.py) would then absorb.
    if (!active || (active.tagName !== "INPUT" && active.tagName !== "SELECT")) {
      return null;
    }
    if (!dom.tableBody.contains?.(active)) {
      return null;
    }
    const cell = cellReferenceFor(active);
    if (!cell) {
      return null;
    }
    // Narrowed by the tagName test above.
    const editor = active as HTMLInputElement | HTMLSelectElement;
    return {
      ...cell,
      // Only a text editor carries an uncommitted draft; a select commits on
      // change, so there is nothing of its own to put back.
      draft: active.tagName === "INPUT" ? String(editor.value ?? "") : null,
      // A select has no caret: these read undefined there, as they always did.
      selectionStart: (editor as HTMLInputElement).selectionStart,
      selectionEnd: (editor as HTMLInputElement).selectionEnd,
    };
  }

  // Hand focus to whichever element now shows the row that had it, so typing
  // continues in the same channel it started in.
  function restoreFocusedCell(captured: ReturnType<typeof captureFocusedCell>): void {
    if (!captured) {
      return;
    }
    // A cell's first child is the editor createCellEditor() built for it: a
    // text input, or a select, which has no caret to restore.
    const editor = cellElement(captured.rowIdx, captured.column)?.children[0] as HTMLInputElement | undefined;
    if (!editor) {
      // The channel being edited fell out of the rendered window, so there is
      // no element left to hold the draft. Commit it as a blur would rather
      // than dropping what was typed. After this render rather than inside
      // it: a commit re-renders the window to mark the cell pending.
      const draft = captured.draft;
      if (draft !== null) {
        queueMicrotask(() => {
          void commitRawValue(captured, draft);
        });
      }
      return;
    }
    // bindRowElement has just written the row's stored value into this
    // element; put the in-progress text back over it.
    const draft = captured.draft;
    const restoredDraft = draft !== null && editor.tagName === "INPUT";
    if (restoredDraft) {
      editor.value = draft;
    }
    const refocused = editor !== globalThis.document?.activeElement;
    if (refocused) {
      editor.focus?.({ preventScroll: true });
    }
    // Rewriting the value collapses the caret to the end, so the selection is
    // restored whenever either the text or the focus moved.
    if ((restoredDraft || refocused) && Number.isFinite(captured.selectionStart) && editor.setSelectionRange) {
      editor.setSelectionRange(captured.selectionStart, captured.selectionEnd);
    }
  }

  function renderRowWindow() {
    if (renderedColumns.length === 0) {
      discardRowElements();
      return;
    }
    const focused = captureFocusedCell();
    const { start, count } = visibleRowRange();
    syncRowElementCount(count);
    windowStart = start;
    for (let offset = 0; offset < count; offset += 1) {
      bindRowElement(rowElements[offset], start + offset);
    }
    applySpacerHeights(start, count);
    if (measureRowHeight() && !isRemeasuring) {
      // The window above was sized against an estimate; redo it now that the
      // real row height is known. Bounded to one extra pass, which leaves focus
      // to the outer one below.
      isRemeasuring = true;
      try {
        renderRowWindow();
      } finally {
        isRemeasuring = false;
      }
    }
    restoreFocusedCell(focused);
  }

  // Coalesce scroll and resize into one update per frame.
  function scheduleWindowUpdate() {
    if (windowUpdateHandle) {
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      renderRowWindow();
      return;
    }
    windowUpdateHandle = requestAnimationFrame(() => {
      windowUpdateHandle = 0;
      renderRowWindow();
    });
  }

  // With no channels there is nothing for the header row to label, so the whole
  // grid gives way to the centred "how to get channels in here" notice. index.html
  // ships in that state already, so the notice is up during runtime boot too.
  function renderEmptyState() {
    const isEmpty = state.currentRows.length === 0;
    dom.channelEmptyStateEl.hidden = !isEmpty;
    dom.tableScrollEl.hidden = isEmpty;
  }

  // Render the editable channel table using current rows and metadata rules.
  function render() {
    const columns = gridColumns();
    if (schemaChanged(columns)) {
      renderedColumns = columns;
      renderedMetadata = state.radioMetadata;
      locationColumnIndex = columns.indexOf("Location");
      renderHeader();
      discardRowElements();
    }
    renderEmptyState();
    renderRowWindow();
    notifySelectionChanged();
  }

  // Record per-cell issues reported by the upload preflight. Returns how many
  // cells were highlighted so the caller can decide whether to re-render.
  function applyValidationIssues(issues: readonly RowIssue[] | null | undefined): number {
    let applied = 0;
    for (const issue of issues || []) {
      const rowIdx = Number(issue?.rowIndex);
      const column = String(issue?.column || "");
      if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= state.currentRows.length || !column) {
        continue;
      }
      invalidCellKeys.add(invalidCellKey(rowIdx, column));
      cellNotes.set(invalidCellKey(rowIdx, column), String(issue?.message || "Invalid value"));
      applied += 1;
      const channel = state.currentRows[rowIdx]?.Location ?? rowIdx;
      log.logDebug(`PREFLIGHT INVALID channel=${channel} column=${column}: ${issue?.message || "Invalid value"}`);
    }
    return applied;
  }

  // Resolve which channel and column an event inside the grid belongs to. The
  // row index is read from the element at event time, never captured when the
  // element was built, so recycled rows always report the channel they are
  // currently showing.
  function cellReferenceFor(target: EventTarget | null): CellReference | null {
    const td = (target as Element | null)?.closest?.<HTMLElement>("td[data-column]");
    const rowIdx = Number((td?.parentNode as HTMLElement | null | undefined)?.dataset?.rowIdx);
    if (!td || !Number.isInteger(rowIdx) || !state.currentRows[rowIdx]) {
      return null;
    }
    // The selector matched on data-column, so the cell has one.
    return { rowIdx, column: td.dataset.column as string };
  }

  // Commit a raw editor string to the row it belongs to: stored as typed and
  // marked pending at once, then replaced by what the runtime normalizes it
  // to, with the driver's verdict on the row (submitRowEdits). Text equal to
  // what the cell already holds is not an edit and asks nothing. Takes the
  // text rather than the editor because a draft rescued from a recycled row
  // element has no element left; the re-render that applies the answer
  // writes the value back to whichever element shows the row by then.
  function commitRawValue({ rowIdx, column }: CellReference, text: string): Promise<void> {
    const row = state.currentRows[rowIdx];
    if (!row || (String(row[column] ?? "") === text && !pendingEdits.get(row)?.has(column))) {
      return Promise.resolve();
    }
    return submitRowEdits([{ row, edits: [{ column, value: text }] }]);
  }

  function commitCellValue(cell: CellReference, editor: HTMLInputElement | HTMLSelectElement): Promise<void> {
    return commitRawValue(cell, editor.value);
  }

  // One listener per event type for the whole grid, instead of three per cell.
  // Each handler reads its event's target as the element inside the tbody
  // that fired it -- a cell editor or one of the row's buttons.
  function bindGridEvents() {
    dom.tableBody.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const extraButton = target?.closest?.(".channel-extra-button") as HTMLButtonElement | null;
      const extraCell = extraButton && cellReferenceFor(extraButton);
      if (extraCell) {
        // The button travels with the call so the editor can hand the keyboard
        // back to it on close.
        actions.openChannelExtra(extraCell.rowIdx, extraButton);
        return;
      }
      const button = target?.closest?.(".channel-location-button");
      const cell = button && cellReferenceFor(button);
      if (cell) {
        updateRowSelectionFromLocationClick(event, cell.rowIdx);
      }
    });

    dom.tableBody.addEventListener("input", (event) => {
      const target = event.target as HTMLElement;
      const cell = cellReferenceFor(target);
      if (cell) {
        clearInvalidCell(cell.rowIdx, cell.column);
      }
    });

    dom.tableBody.addEventListener("change", (event) => {
      // Checked for SELECT below before it is read as one.
      const target = event.target as HTMLSelectElement;
      if (target?.tagName !== "SELECT") {
        return;
      }
      const cell = cellReferenceFor(event.target);
      if (cell) {
        clearInvalidCell(cell.rowIdx, cell.column);
        void commitCellValue(cell, target);
      }
    });

    // Text cells normalize when they lose focus. blur does not bubble, so the
    // delegated equivalent is focusout.
    dom.tableBody.addEventListener("focusout", (event) => {
      // Checked for INPUT below before it is read as one.
      const target = event.target as HTMLInputElement;
      if (target?.tagName !== "INPUT") {
        return;
      }
      const cell = cellReferenceFor(event.target);
      if (cell) {
        void commitCellValue(cell, target);
      }
    });

    dom.tableScrollEl.addEventListener("scroll", scheduleWindowUpdate, { passive: true });
    // A ResizeObserver also fires when the grid is shown again after the
    // settings view hid it (zero-sized box to real box), which a window resize
    // listener would miss.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(scheduleWindowUpdate).observe(dom.tableScrollEl);
    } else {
      window.addEventListener("resize", scheduleWindowUpdate);
    }
  }

  function bindEvents() {
    bindGridEvents();
    dom.channelInsertEl.addEventListener("click", () => {
      insertNewChannelRow();
    });
    dom.channelRemoveEl.addEventListener("click", () => {
      removeSelectedChannelRows();
    });
    dom.channelMoveUpEl.addEventListener("click", () => {
      moveSelectedChannelRows(-1);
    });
    dom.channelMoveDownEl.addEventListener("click", () => {
      moveSelectedChannelRows(1);
    });
    dom.channelCopyEl.addEventListener("click", async () => {
      await writeChannelTsvToClipboard("copy", false);
    });
    dom.channelCutEl.addEventListener("click", async () => {
      await writeChannelTsvToClipboard("cut", true);
    });
    dom.channelPasteEl.addEventListener("click", async () => {
      await pasteChannelsViaApi();
    });
    dom.channelAddGmrsEl.addEventListener("click", () => {
      void addBandPlanChannels(buildGmrsRows, "GMRS");
    });
    dom.channelAddFrsEl.addEventListener("click", () => {
      void addBandPlanChannels(buildFrsRows, "FRS");
    });
    dom.channelAddPmr446El.addEventListener("click", () => {
      void addBandPlanChannels(buildPmr446Rows, "PMR446");
    });

    // Ctrl/Cmd+C, X, V arrive as native clipboard events, which supply
    // clipboardData synchronously and need no permission prompt (unlike the
    // async navigator.clipboard API used by the toolbar buttons). The guard defers
    // to normal browser behavior inside inputs/selects and text selections.
    document.addEventListener("copy", (event) => {
      if (!channelShortcutsActive(event, { respectTextSelection: true })) {
        return;
      }
      copySelectedChannels(event);
    });

    document.addEventListener("cut", (event) => {
      if (!channelShortcutsActive(event, { respectTextSelection: true })) {
        return;
      }
      cutSelectedChannels(event);
    });

    document.addEventListener("paste", (event) => {
      if (!channelShortcutsActive(event)) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      pasteChannelsFromText(text);
    });
  }

  return {
    bindEvents,
    render,
    resetRowSelection,
    clearInvalidHighlights,
    clearInvalidHighlightsForCells,
    applyValidationIssues,
    selectedRowsForOperations,
    selectedChannelRows,
    hasRealChannels,
    reconcileLocations,
    sortRowsByLocation,
    insertRowsAtSelectionOrEnd,
    dropUnsupportedPowerValues,
    createBlankChannelRow,
    findEnumOption,
    buildRows,
    submitRowEdits,
    previewRowEdits,
    rowsRewritten,
    channelShortcutsActive,
    moveSelectedChannelRows,
    refreshVisibleRows: renderRowWindow,
  };
}

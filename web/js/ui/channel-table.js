import {
  buildFrsRows,
  buildGmrsRows,
  buildPmr446Rows,
} from "../datasources.js";
import {
  buildRowsFromClipboardText,
  computeMovedRowOrder,
  looksLikeChannelTsv,
  rowLooksNonEmpty,
  serializeRowsToTsv,
} from "../clipboard.js";
import { normalizeValue } from "./channel-values.js";
import { rowGeo } from "../row-geo.js";
import { radioEventParams, trackEvent } from "./analytics.js";

// The editable channel grid: rendering, row selection, the row operations
// (insert/remove/move/copy/cut/paste), the band-plan presets, and the
// invalid-cell highlighting the upload preflight drives. Owns the selection
// and invalid-cell state; the rows themselves live in the shared state so
// export, upload and import paths can read them.
export function createChannelTable({ dom, state, log, actions }) {
  let selectedRowIndexes = new Set();
  let selectionAnchorIndex = null;
  const invalidCellKeys = new Set();

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

  // The schema the current row elements were built for; a change to either
  // invalidates every editor.
  let renderedColumns = [];
  let renderedMetadata = null;
  let locationColumnIndex = -1;
  // The window: rowElements[i] shows channel windowStart + i.
  let rowElements = [];
  let spacers = null;
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

  function resetRowSelection() {
    selectedRowIndexes.clear();
    selectionAnchorIndex = null;
  }

  function invalidCellKey(rowIdx, column) {
    return `${Number(rowIdx)}:${String(column || "")}`;
  }

  function clearInvalidHighlights() {
    invalidCellKeys.clear();
  }

  function clearInvalidCell(rowIdx, column) {
    const key = invalidCellKey(rowIdx, column);
    if (!invalidCellKeys.has(key)) {
      return;
    }
    invalidCellKeys.delete(key);
    cellElement(Number(rowIdx), String(column || ""))?.classList.remove("is-invalid");
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

  function selectRowRange(fromIdx, toIdx, addToExisting) {
    const start = Math.max(0, Math.min(fromIdx, toIdx));
    const end = Math.min(state.currentRows.length - 1, Math.max(fromIdx, toIdx));
    const next = addToExisting ? new Set(selectedRowIndexes) : new Set();
    for (let idx = start; idx <= end; idx += 1) {
      next.add(idx);
    }
    selectedRowIndexes = next;
  }

  function updateRowSelectionFromLocationClick(event, rowIdx) {
    const wantsToggle = event.metaKey || event.ctrlKey;
    const wantsRange = event.shiftKey && Number.isInteger(selectionAnchorIndex);

    if (wantsRange) {
      selectRowRange(selectionAnchorIndex, rowIdx, wantsToggle);
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
  }

  function defaultValueForColumn(column) {
    if (column === "Location") {
      return "";
    }
    const meta = state.radioMetadata.columns?.[column] || {};
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      return String(meta.options[0]);
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
    const meta = state.radioMetadata.columns?.Location || {};
    return {
      lo: Number.isFinite(meta.min) ? Number(meta.min) : 0,
      hi: Number.isFinite(meta.max) ? Number(meta.max) : Number.POSITIVE_INFINITY,
    };
  }

  function parsedLocation(row) {
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
    const claimed = new Set();
    const needsSlot = [];
    for (const row of state.currentRows) {
      const location = parsedLocation(row);
      if (location === null || location < lo || location > hi || claimed.has(location)) {
        needsSlot.push(row);
        continue;
      }
      claimed.add(location);
    }
    let next = lo;
    for (const row of needsSlot) {
      while (claimed.has(next)) {
        next += 1;
      }
      // A full codeplug leaves the surplus rows without a slot. Blanking is
      // what keeps that visible: the upload preflight flags an empty Location
      // rather than the runtime rejecting an out-of-bounds one mid-transfer.
      row.Location = next > hi ? "" : String(next);
      claimed.add(next);
    }
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

  // The one call every row operation makes after mutating state.currentRows:
  // give slots to rows that need one, then put the list back in memory order.
  function reconcileLocations() {
    assignFreeLocations();
    sortRowsByLocation();
  }

  // Row operations know which row objects they touched, not where those rows
  // end up once the list is reordered. Resolve identity to position here.
  function selectRowsByIdentity(rows) {
    const positionOf = new Map(state.currentRows.map((row, index) => [row, index]));
    const indexes = rows
      .map((row) => positionOf.get(row))
      .filter((index) => index !== undefined);
    selectedRowIndexes = new Set(indexes);
    selectionAnchorIndex = indexes.length > 0 ? Math.min(...indexes) : null;
    return indexes;
  }

  function createBlankChannelRow() {
    const row = {};
    for (const column of state.currentHeaders) {
      row[column] = defaultValueForColumn(column);
    }
    return row;
  }

  function setRowValueIfPresent(row, column, value) {
    if (!state.currentHeaders.includes(column)) {
      return;
    }
    const meta = state.radioMetadata.columns?.[column] || {};
    row[column] = normalizeValue(column, value, meta, row[column], { allowReadOnly: true });
  }

  function findEnumOption(column, choices, caseInsensitive = false) {
    if (!state.currentHeaders.includes(column)) {
      return "";
    }
    const meta = state.radioMetadata.columns?.[column] || {};
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

  // Row builders from datasources.js all take the same construction hooks.
  function rowBuilderHooks() {
    return {
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
      findEnumOption,
    };
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

  function insertRowsAtSelectionOrEnd(rowsToInsert, label) {
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
    return true;
  }

  // Remove exactly these row objects. Identity-based so a removal captured
  // before an await (Cut's clipboard write) deletes the rows that were
  // serialized even if the selection or row order changed while it was
  // pending. Returns how many rows were actually removed.
  function removeChannelRows(rowsToRemove) {
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
  function moveSelectedChannelRows(direction) {
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
      state.currentRows.forEach((row, idx) => {
        row.Location = locationsByPosition[idx];
      });
    }
    // Slots were reassigned along the already-ascending positions, so the
    // list is still in memory order and this sort is a no-op — it runs so the
    // invariant holds from one place rather than by argument.
    reconcileLocations();
    clearInvalidHighlights();

    selectRowsByIdentity(movedRows);
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
  function channelShortcutsActive(event, { respectTextSelection = false } = {}) {
    if (state.currentEditorView !== "channels") {
      return false;
    }
    if (actions.isRepeaterModalOpen()) {
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
  function selectedChannelTsv(actionLabel) {
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

  function copySelectedChannels(event) {
    const payload = selectedChannelTsv("copy");
    if (!payload) {
      return;
    }
    event.clipboardData.setData("text/plain", payload.tsv);
    event.preventDefault();
    log.setStatus(`Copied ${payload.count} channel(s) to clipboard.`);
  }

  function cutSelectedChannels(event) {
    const payload = selectedChannelTsv("cut");
    if (!payload) {
      return;
    }
    event.clipboardData.setData("text/plain", payload.tsv);
    event.preventDefault();
    const removed = removeChannelRows(payload.rows);
    log.setStatus(`Cut ${removed} channel(s) to clipboard.`);
  }

  async function writeChannelTsvToClipboard(actionLabel, remove) {
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
  function pasteChannelsFromText(text) {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    if (!looksLikeChannelTsv(text)) {
      log.setStatus("Clipboard does not contain tab-separated channel data.");
      return;
    }
    const built = buildRowsFromClipboardText(text, {
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
    });
    const rows = built?.rows ?? [];
    if (rows.length === 0) {
      log.setStatus("No channels found in pasted text.");
      return;
    }
    const selectedIndexes = sortedSelectedRowIndexes();
    const startAt = selectedIndexes.length > 0 ? selectedIndexes[0] : state.currentRows.length;
    const overwriteLocations = [];
    for (let offset = 0; offset < rows.length && startAt + offset < state.currentRows.length; offset += 1) {
      const target = state.currentRows[startAt + offset];
      if (rowLooksNonEmpty(target)) {
        overwriteLocations.push(String(target.Location ?? startAt + offset));
      }
    }
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
    const keepsLocation = state.currentHeaders.includes("Location");
    rows.forEach((row, offset) => {
      const at = startAt + offset;
      if (at < state.currentRows.length) {
        // Overwrite means "replace the channel in this memory", so the pasted
        // channel inherits the slot rather than the Location it was copied
        // from — pasting between codeplugs must not drag the source's
        // numbering across.
        if (keepsLocation) {
          row.Location = state.currentRows[at].Location;
        }
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

  function addBandPlanChannels(buildRows, label) {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    const rows = buildRows(rowBuilderHooks());
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
  function columnLegend(column) {
    const meta = state.radioMetadata.columns?.[column] || {};
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
  function createCellEditor(column) {
    const meta = state.radioMetadata.columns?.[column] || {};
    const readOnly = column === "Location" || meta.editable === false;

    // Grey out read-only cells and explain why; Location is excluded because
    // its button is the row-selection handle, not a disabled editor.
    function markReadOnly(editor) {
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
    input.readOnly = readOnly;
    input.disabled = readOnly;
    if (Number.isFinite(meta.maxLength)) {
      input.maxLength = Number(meta.maxLength);
    }
    return markReadOnly(input);
  }

  function bindCellEditor(editor, row, column) {
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
    const driverOptions = Number(editor.dataset.driverOptions);
    if (Number.isInteger(driverOptions) && editor.length > driverOptions) {
      editor.length = driverOptions;
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
      td.appendChild(createCellEditor(column));
      tr.appendChild(td);
    }
    return tr;
  }

  // Point an existing row element at a model row: values, selection and
  // invalid-cell classes. This is the whole per-row cost of a render.
  function bindRowElement(tr, rowIdx) {
    const row = state.currentRows[rowIdx];
    if (!row) {
      return;
    }
    tr.dataset.rowIdx = String(rowIdx);
    const isSelected = selectedRowIndexes.has(rowIdx);
    tr.classList.toggle("is-selected", isSelected);
    renderedColumns.forEach((column, columnIdx) => {
      const td = tr.children[columnIdx];
      td.classList.toggle("is-invalid", invalidCellKeys.has(invalidCellKey(rowIdx, column)));
      bindCellEditor(td.children[0], row, column);
    });
    const locationButton = locationButtonIn(tr);
    if (locationButton) {
      locationButton.setAttribute("aria-pressed", isSelected ? "true" : "false");
      // Rows imported from a repeater directory carry coordinates; mark their
      // Location cell so the map affordance (ui/repeater-map.js) is visible.
      locationButton.classList.toggle("has-geo", Boolean(rowGeo(row)));
    }
  }

  function locationButtonIn(tr) {
    if (locationColumnIndex < 0) {
      return null;
    }
    return tr.children[locationColumnIndex]?.children[0] || null;
  }

  function cellElement(rowIdx, column) {
    const tr = rowElements[rowIdx - windowStart];
    if (!tr || tr.dataset.rowIdx !== String(rowIdx)) {
      return null;
    }
    const columnIdx = renderedColumns.indexOf(column);
    return columnIdx < 0 ? null : tr.children[columnIdx] || null;
  }

  // A spacer row stands in for the rows kept out of the DOM, so the scrollbar
  // and the scroll position match the full channel list.
  function createSpacerRow() {
    const tr = document.createElement("tr");
    tr.className = "mem-row-spacer";
    tr.setAttribute("aria-hidden", "true");
    const cell = document.createElement("td");
    cell.colSpan = Math.max(1, renderedColumns.length);
    tr.appendChild(cell);
    return { tr, cell };
  }

  function schemaChanged(columns) {
    return renderedMetadata !== state.radioMetadata
      || columns.length !== renderedColumns.length
      || columns.some((column, idx) => column !== renderedColumns[idx]);
  }

  function renderHeader() {
    dom.tableHead.innerHTML = "";
    const headerRow = document.createElement("tr");
    renderedColumns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column;
      // Mirror the cell treatment: grey + tooltip on headers of columns the
      // selected radio marks read-only (Location stays the selection handle).
      const meta = state.radioMetadata.columns?.[column] || {};
      const legend = columnLegend(column);
      if (legend) {
        th.title = legend;
      }
      if (meta.editable === false && column !== "Location") {
        th.classList.add("readonly-cell");
        th.title = `${column} is read-only for this radio.`;
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
  function syncRowElementCount(count) {
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

  function applySpacerHeights(start, count) {
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
  // to a different channel. Commit whatever was typed first — there is no blur
  // to do it, unlike a toolbar click, which blurs the editor before it fires.
  function captureFocusedCell() {
    const active = globalThis.document?.activeElement;
    // Only an editor holds an uncommitted value. The Location button is
    // focusable but is the row-selection handle, not an editor: committing
    // through it would push its empty .value at the Location column, which
    // only normalizeValue's editable:false guard currently absorbs.
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
    commitCellValue(cell, active);
    return { ...cell, selectionStart: active.selectionStart, selectionEnd: active.selectionEnd };
  }

  // Hand focus to whichever element now shows the row that had it, so typing
  // continues in the same channel it started in.
  function restoreFocusedCell(captured) {
    const editor = captured && cellElement(captured.rowIdx, captured.column)?.children[0];
    if (!editor || editor === globalThis.document?.activeElement) {
      return;
    }
    editor.focus?.({ preventScroll: true });
    if (Number.isFinite(captured.selectionStart) && editor.setSelectionRange) {
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
    const columns = state.currentHeaders.slice();
    if (schemaChanged(columns)) {
      renderedColumns = columns;
      renderedMetadata = state.radioMetadata;
      locationColumnIndex = columns.indexOf("Location");
      renderHeader();
      discardRowElements();
    }
    renderEmptyState();
    renderRowWindow();
  }

  // Record per-cell issues reported by the upload preflight. Returns how many
  // cells were highlighted so the caller can decide whether to re-render.
  function applyValidationIssues(issues) {
    let applied = 0;
    for (const issue of issues || []) {
      const rowIdx = Number(issue?.rowIndex);
      const column = String(issue?.column || "");
      if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= state.currentRows.length || !column) {
        continue;
      }
      invalidCellKeys.add(invalidCellKey(rowIdx, column));
      applied += 1;
      const channel = state.currentRows[rowIdx]?.Location ?? rowIdx;
      log.logDebug(`PREFLIGHT INVALID channel=${channel} column=${column}: ${issue?.message || "Invalid value"}`);
    }
    return applied;
  }

  function setMenuOpen(open) {
    if (!dom.channelMenuToggleEl || !dom.channelMenuPopupEl) {
      return;
    }
    dom.channelMenuPopupEl.classList.toggle("hidden", !open);
    dom.channelMenuToggleEl.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function toggleMenu() {
    setMenuOpen(dom.channelMenuPopupEl.classList.contains("hidden"));
  }

  // Resolve which channel and column an event inside the grid belongs to. The
  // row index is read from the element at event time, never captured when the
  // element was built, so recycled rows always report the channel they are
  // currently showing.
  function cellReferenceFor(target) {
    const td = target?.closest?.("td[data-column]");
    const rowIdx = Number(td?.parentNode?.dataset?.rowIdx);
    if (!td || !Number.isInteger(rowIdx) || !state.currentRows[rowIdx]) {
      return null;
    }
    return { rowIdx, column: td.dataset.column };
  }

  function commitCellValue({ rowIdx, column }, editor) {
    const row = state.currentRows[rowIdx];
    const meta = state.radioMetadata.columns?.[column] || {};
    const next = normalizeValue(column, editor.value, meta, row[column]);
    row[column] = next;
    editor.value = next;
  }

  // One listener per event type for the whole grid, instead of three per cell.
  function bindGridEvents() {
    dom.tableBody.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".channel-location-button");
      const cell = button && cellReferenceFor(button);
      if (cell) {
        updateRowSelectionFromLocationClick(event, cell.rowIdx);
      }
    });

    dom.tableBody.addEventListener("input", (event) => {
      const cell = cellReferenceFor(event.target);
      if (cell) {
        clearInvalidCell(cell.rowIdx, cell.column);
      }
    });

    dom.tableBody.addEventListener("change", (event) => {
      if (event.target?.tagName !== "SELECT") {
        return;
      }
      const cell = cellReferenceFor(event.target);
      if (cell) {
        clearInvalidCell(cell.rowIdx, cell.column);
        commitCellValue(cell, event.target);
      }
    });

    // Text cells normalize when they lose focus. blur does not bubble, so the
    // delegated equivalent is focusout.
    dom.tableBody.addEventListener("focusout", (event) => {
      if (event.target?.tagName !== "INPUT") {
        return;
      }
      const cell = cellReferenceFor(event.target);
      if (cell) {
        commitCellValue(cell, event.target);
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
    dom.channelMenuToggleEl.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });
    dom.channelCopyEl.addEventListener("click", async () => {
      setMenuOpen(false);
      await writeChannelTsvToClipboard("copy", false);
    });
    dom.channelCutEl.addEventListener("click", async () => {
      setMenuOpen(false);
      await writeChannelTsvToClipboard("cut", true);
    });
    dom.channelPasteEl.addEventListener("click", async () => {
      setMenuOpen(false);
      await pasteChannelsViaApi();
    });
    dom.channelAddGmrsEl.addEventListener("click", () => {
      setMenuOpen(false);
      addBandPlanChannels(buildGmrsRows, "GMRS");
    });
    dom.channelAddFrsEl.addEventListener("click", () => {
      setMenuOpen(false);
      addBandPlanChannels(buildFrsRows, "FRS");
    });
    dom.channelAddPmr446El.addEventListener("click", () => {
      setMenuOpen(false);
      addBandPlanChannels(buildPmr446Rows, "PMR446");
    });

    document.addEventListener("click", (event) => {
      if (!dom.channelMenuPopupEl || dom.channelMenuPopupEl.classList.contains("hidden")) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (dom.channelMenuPopupEl.contains(target) || dom.channelMenuToggleEl.contains(target)) {
        return;
      }
      setMenuOpen(false);
    });

    // Ctrl/Cmd+C, X, V arrive as native clipboard events, which supply
    // clipboardData synchronously and need no permission prompt (unlike the
    // async navigator.clipboard API used by the menu items). The guard defers
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
    applyValidationIssues,
    selectedRowsForOperations,
    hasRealChannels,
    reconcileLocations,
    insertRowsAtSelectionOrEnd,
    createBlankChannelRow,
    setRowValueIfPresent,
    findEnumOption,
    rowBuilderHooks,
    channelShortcutsActive,
    moveSelectedChannelRows,
    setMenuOpen,
    refreshVisibleRows: renderRowWindow,
  };
}

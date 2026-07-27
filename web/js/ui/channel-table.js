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

// The editable channel grid: rendering, row selection, the row operations
// (insert/remove/move/copy/cut/paste), the band-plan presets, and the
// invalid-cell highlighting the upload preflight drives. Owns the selection
// and invalid-cell state; the rows themselves live in the shared state so
// export, upload and import paths can read them.
export function createChannelTable({ dom, state, log, actions }) {
  let selectedRowIndexes = new Set();
  let selectionAnchorIndex = null;
  const invalidCellKeys = new Set();

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
    const td = dom.tableBody.querySelector(
      `td[data-row-idx="${Number(rowIdx)}"][data-column="${CSS.escape(String(column || ""))}"]`,
    );
    td?.classList.remove("is-invalid");
  }

  function applyRowSelectionVisuals() {
    const selected = selectedRowIndexes;
    const rows = dom.tableBody.querySelectorAll("tr");
    rows.forEach((tr, rowIdx) => {
      const isSelected = selected.has(rowIdx);
      tr.classList.toggle("is-selected", isSelected);
      const locationButton = tr.querySelector(".channel-location-button");
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

  function reindexLocationColumn() {
    if (!state.currentHeaders.includes("Location")) {
      return;
    }
    state.currentRows.forEach((row, idx) => {
      row.Location = String(idx);
    });
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

    const selectedIndexes = sortedSelectedRowIndexes();
    const insertAt = selectedIndexes.length > 0 ? selectedIndexes[0] : state.currentRows.length;
    state.currentRows.splice(insertAt, 0, createBlankChannelRow());
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set([insertAt]);
    selectionAnchorIndex = insertAt;
    render();
    log.setStatus(`Inserted new channel at channel ${insertAt}.`);
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
    const selectedIndexes = sortedSelectedRowIndexes();
    const insertAt = selectedIndexes.length > 0 ? selectedIndexes[0] : state.currentRows.length;
    state.currentRows.splice(insertAt, 0, ...rowsToInsert);
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(
      rowsToInsert.map((_, offset) => insertAt + offset),
    );
    selectionAnchorIndex = insertAt;
    render();
    log.setStatus(`Inserted ${rowsToInsert.length} ${label} channel(s) at channel ${insertAt}.`);
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
    reindexLocationColumn();
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
  // clamping at the edges; Location renumbers to match the new order.
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
    state.currentRows = order.map((idx) => state.currentRows[idx]);
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(selected);
    selectionAnchorIndex = direction < 0 ? Math.min(...selected) : Math.max(...selected);
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
      log.logDebug(`CLIPBOARD write failed: ${error}`);
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
    rows.forEach((row, offset) => {
      const at = startAt + offset;
      if (at < state.currentRows.length) {
        state.currentRows[at] = row;
      } else {
        state.currentRows.push(row);
      }
    });
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(rows.map((_, offset) => startAt + offset));
    selectionAnchorIndex = startAt;
    render();
    log.setStatus(`Pasted ${rows.length} channel(s) at channel ${startAt}.`);
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
      log.logDebug(`CLIPBOARD read failed: ${error}`);
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
    insertRowsAtSelectionOrEnd(buildRows(rowBuilderHooks()), label);
  }

  // Create a table cell editor (input/select) based on CHIRP column metadata.
  function createCellEditor(row, rowIdx, column) {
    const meta = state.radioMetadata.columns?.[column] || {};
    const current = String(row[column] ?? "");
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
      button.textContent = current;
      button.addEventListener("click", (event) => {
        updateRowSelectionFromLocationClick(event, rowIdx);
      });
      return button;
    }
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      const select = document.createElement("select");
      const options = meta.options.map(String);
      if (!options.includes(current)) {
        options.unshift(current);
      }
      for (const opt of options) {
        const optionEl = document.createElement("option");
        optionEl.value = opt;
        optionEl.textContent = opt;
        select.appendChild(optionEl);
      }
      select.value = current;
      select.disabled = readOnly;
      select.addEventListener("change", () => {
        clearInvalidCell(rowIdx, column);
        const next = normalizeValue(column, select.value, meta, row[column]);
        row[column] = next;
        state.currentRows[rowIdx][column] = next;
        select.value = next;
      });
      return markReadOnly(select);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.readOnly = readOnly;
    input.disabled = readOnly;
    if (Number.isFinite(meta.maxLength)) {
      input.maxLength = Number(meta.maxLength);
    }
    input.addEventListener("input", () => {
      clearInvalidCell(rowIdx, column);
    });
    input.addEventListener("blur", () => {
      const next = normalizeValue(column, input.value, meta, row[column]);
      row[column] = next;
      state.currentRows[rowIdx][column] = next;
      input.value = next;
    });
    return markReadOnly(input);
  }

  // Render the editable channel table using current rows and metadata rules.
  function render() {
    const columns = state.currentHeaders.slice();

    dom.tableHead.innerHTML = "";
    dom.tableBody.innerHTML = "";

    const headerRow = document.createElement("tr");
    columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column;
      // Mirror the cell treatment: grey + tooltip on headers of columns the
      // selected radio marks read-only (Location stays the selection handle).
      const meta = state.radioMetadata.columns?.[column] || {};
      if (meta.editable === false && column !== "Location") {
        th.classList.add("readonly-cell");
        th.title = `${column} is read-only for this radio.`;
      }
      headerRow.appendChild(th);
    });
    dom.tableHead.appendChild(headerRow);

    state.currentRows.forEach((row, rowIdx) => {
      const tr = document.createElement("tr");
      if (selectedRowIndexes.has(rowIdx)) {
        tr.classList.add("is-selected");
      }

      columns.forEach((column) => {
        const td = document.createElement("td");
        td.dataset.rowIdx = String(rowIdx);
        td.dataset.column = String(column);
        td.classList.toggle("is-invalid", invalidCellKeys.has(invalidCellKey(rowIdx, column)));
        const editor = createCellEditor(row, rowIdx, column);
        td.appendChild(editor);
        tr.appendChild(td);
      });

      dom.tableBody.appendChild(tr);
    });

    applyRowSelectionVisuals();
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

  function bindEvents() {
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
    reindexLocationColumn,
    insertRowsAtSelectionOrEnd,
    createBlankChannelRow,
    setRowValueIfPresent,
    findEnumOption,
    rowBuilderHooks,
    channelShortcutsActive,
    moveSelectedChannelRows,
    setMenuOpen,
  };
}

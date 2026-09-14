import { normalizeCellValue } from "./channel-values.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { createSettingControl, readSettingControl } from "./setting-fields.js";
import { radioEventParams, trackEvent } from "./analytics.js";
import { requireRuntimeApi } from "./state.js";

// The bulk channel editor: one modal that writes the same value to every
// selected channel (issue #146).
//
// Editing twenty channels one cell at a time is the grid's only answer to
// "give this whole block the repeater's tone", and it is the wrong one: the
// same value has to be retyped per row, and a driver's per-channel extras
// (Busy Channel Lockout, PTT-ID, scramble) are a modal apiece on top of that.
// This is the one place that does it once.
//
// Two things decide what the modal offers:
//   * the grid's own columns, minus Location (the memory slot is what tells
//     channels apart, so one value across a selection is never right) and
//     minus anything the selected driver marks read-only;
//   * the driver's per-channel extras, read through the same
//     get_channel_extra RPC the single-channel editor uses
//     (web/python/webchirp_bridge/channel_extra.py).
//
// Every field carries its own "apply this" checkbox and nothing is written
// without one ticked. That is what makes "leave the rest alone" the default
// rather than a thing the user has to arrange: a bulk edit opened on twenty
// channels that disagree about Mode must not quietly give all twenty the first
// one's Mode just because the control had to show something.
export function createChannelBulkEdit(ctx) {
  const { dom, state, log } = ctx;

  // The rows the modal opened on, and one entry per rendered field. All three
  // are dropped on close, which is also what makes a late extras response
  // harmless: it finds a closed modal and returns.
  let editedRows = [];
  let columnFields = [];
  let extraFields = [];
  // The toolbar button the open came from, refocused when the modal closes.
  let triggerElement = null;
  // Bumped on every open so the response to a superseded open cannot render
  // over the one the user is looking at.
  let openToken = 0;

  const COLUMN_ID_PREFIX = "channel-bulk-column-";
  const EXTRA_ID_PREFIX = "channel-bulk-extra-";

  function isModalOpen() {
    return !dom.channelBulkEditModalEl.classList.contains("hidden");
  }

  function setModalOpen(open) {
    dom.channelBulkEditModalEl.classList.toggle("hidden", !open);
    if (!open) {
      editedRows = [];
      columnFields = [];
      extraFields = [];
      // Hand the keyboard back to where it came from; without this it is left
      // inside a hidden dialog and the next Tab starts from the top of the page.
      triggerElement?.focus?.();
      triggerElement = null;
    }
  }

  function closeModal() {
    setModalOpen(false);
  }

  function setMessage(text) {
    const message = String(text || "");
    dom.channelBulkEditMessageEl.textContent = message;
    dom.channelBulkEditMessageEl.hidden = message === "";
  }

  function setExtraMessage(text) {
    const message = String(text || "");
    dom.channelBulkEditExtraMessageEl.textContent = message;
    dom.channelBulkEditExtraMessageEl.hidden = message === "";
  }

  // The toolbar control only means anything with a selection behind it, so it
  // follows one. The grid owns the selection and calls this on every change to
  // it, which is the only thing that can move this button.
  function refreshAvailability() {
    const count = ctx.table.selectedChannelRows().length;
    dom.channelBulkEditEl.disabled = count === 0;
    dom.channelBulkEditEl.title = count === 0
      ? "Select one or more channels to edit them together"
      : `Edit the ${count} selected channel(s) together`;
  }

  // The columns a bulk edit may write. Location is excluded because a memory
  // slot is a channel's identity rather than an attribute, and a column the
  // driver reports as read-only is excluded because the radio would not take
  // it -- the grid greys those cells out for the same reason.
  function editableColumns() {
    return state.currentHeaders.filter((column) => {
      if (column === "Location") {
        return false;
      }
      const meta = state.radioMetadata.columns?.[column];
      // No metadata at all is an unconstrained column, not an unsupported one:
      // until a radio is selected the grid runs on the generic-CSV schema and
      // writes anything through. See findEnumOption in
      // web/js/ui/channel-table.js, which reads an absent option list the same
      // way.
      return !meta || meta.editable !== false;
    });
  }

  // What the selection already holds for a column: the first row's value, and
  // whether the rows disagree. A disagreement is shown rather than resolved --
  // the control has to display something, and saying "multiple values" beside
  // it is what stops that something from reading as the selection's value.
  function commonValue(values) {
    const first = values[0];
    return {
      value: first,
      mixed: values.some((each) => String(each ?? "") !== String(first ?? "")),
    };
  }

  // The control for one grid column, built from the same CHIRP column metadata
  // the grid's own cell editors are built from (createCellEditor in
  // web/js/ui/channel-table.js).
  function createColumnControl(column, initial) {
    const meta = state.radioMetadata.columns?.[column] || {};
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      const select = document.createElement("select");
      const options = meta.options.map(String);
      for (const option of options) {
        const optionEl = document.createElement("option");
        optionEl.value = option;
        optionEl.textContent = option;
        select.appendChild(optionEl);
      }
      let wanted = String(initial ?? "");
      if (wanted !== "" && !options.includes(wanted)) {
        // A value the driver's list does not carry (a codeplug edited
        // elsewhere, rows carried over from another radio) is offered rather
        // than silently replaced, exactly as the grid's enum cells do.
        const optionEl = document.createElement("option");
        optionEl.value = wanted;
        optionEl.textContent = wanted;
        select.appendChild(optionEl);
      }
      if (wanted === "") {
        // A blank enum is what an unset Power looks like, and a <select> cannot
        // be cleared back to it -- so a blank start would leave the one value
        // the column cannot accept sitting in a control the user may tick.
        // Falling back to the driver's first option keeps every applicable
        // value applicable; the checkbox is what decides whether it is written.
        wanted = options[0];
      }
      select.value = wanted;
      return select;
    }
    const input = document.createElement("input");
    const numeric = meta.kind === "int";
    input.type = numeric ? "number" : "text";
    if (numeric) {
      if (Number.isFinite(meta.min)) {
        input.min = String(meta.min);
      }
      if (Number.isFinite(meta.max)) {
        input.max = String(meta.max);
      }
    }
    if (Number.isFinite(meta.maxLength)) {
      input.maxLength = Number(meta.maxLength);
    }
    input.value = String(initial ?? "");
    return input;
  }

  // One field row: the "apply this" checkbox with its label, then the control
  // and its error slot. Returns the entry the apply path reads the field back
  // through.
  function appendField(grid, { id, name, label, doc, mixed, control }) {
    const labelCell = document.createElement("div");
    labelCell.className = "bulk-edit-label";
    // The checkbox sits inside the label, so the field's name is its own click
    // target and needs no htmlFor pointing at a second id.
    const toggle = document.createElement("label");
    toggle.className = "bulk-edit-toggle";
    const apply = document.createElement("input");
    apply.type = "checkbox";
    apply.className = "bulk-edit-apply";
    apply.name = `${name}__apply`;
    toggle.appendChild(apply);
    const text = document.createElement("span");
    text.textContent = label;
    toggle.appendChild(text);
    labelCell.appendChild(toggle);
    if (mixed) {
      const note = document.createElement("div");
      note.className = "bulk-edit-mixed";
      note.textContent = "multiple values";
      labelCell.appendChild(note);
    }
    if (doc) {
      const docEl = document.createElement("div");
      docEl.className = "bulk-edit-doc";
      docEl.textContent = doc;
      labelCell.appendChild(docEl);
    }

    const controlCell = document.createElement("div");
    controlCell.className = "bulk-edit-control";
    control.id = id;
    control.name = name;
    // The visible label belongs to the checkbox, so the control needs its own
    // accessible name or a screen reader announces it as unlabelled.
    control.setAttribute("aria-label", label);
    // Touching a control is as good as ticking its box: having to arm a field
    // before it accepts a value is the kind of two-step nobody expects, and the
    // box still has to be reachable on its own for a checkbox field, where the
    // control is a checkbox too.
    const arm = () => {
      apply.checked = true;
    };
    control.addEventListener("input", arm);
    control.addEventListener("change", arm);
    controlCell.appendChild(control);
    const errorEl = document.createElement("div");
    errorEl.className = "bulk-edit-error";
    errorEl.hidden = true;
    controlCell.appendChild(errorEl);

    grid.appendChild(labelCell);
    grid.appendChild(controlCell);
    return {
      control,
      apply,
      setError(message) {
        errorEl.textContent = String(message || "");
        errorEl.hidden = !message;
        controlCell.classList.toggle("is-invalid", Boolean(message));
      },
    };
  }

  function renderColumnFields(rows) {
    dom.channelBulkEditGridEl.innerHTML = "";
    columnFields = editableColumns().map((column) => {
      const { value, mixed } = commonValue(rows.map((row) => String(row?.[column] ?? "")));
      const entry = appendField(dom.channelBulkEditGridEl, {
        id: `${COLUMN_ID_PREFIX}${column}`,
        name: column,
        label: column,
        mixed,
        control: createColumnControl(column, value),
      });
      return { ...entry, column };
    });
    dom.channelBulkEditApplyEl.disabled = columnFields.length === 0;
  }

  function renderExtraFields(fields, rows) {
    dom.channelBulkEditExtraGridEl.innerHTML = "";
    extraFields = fields.map((field) => {
      // A row's own value wins over the one the driver reported for the slot,
      // exactly as the single-channel editor resolves it: the sidecar is what
      // the channel carries, wherever it has been moved to since.
      const { value, mixed } = commonValue(rows.map((row) => {
        const stored = rowExtras(row) || {};
        return Object.hasOwn(stored, field.name) ? stored[field.name] : field.current;
      }));
      const entry = appendField(dom.channelBulkEditExtraGridEl, {
        id: `${EXTRA_ID_PREFIX}${field.name}`,
        name: field.name,
        label: field.label || field.name,
        doc: field.doc,
        mixed,
        control: createSettingControl(field, value),
      });
      return { ...entry, field };
    });
    dom.channelBulkEditApplyEl.disabled = false;
  }

  // Whether a response has been overtaken: the modal has been closed (which
  // drops the rows it was opened on) or re-opened on another selection. Both
  // have to be checked -- a token alone misses a close, and rendering into a
  // hidden dialog leaves fields there for whatever opens it next.
  function superseded(rows, token) {
    return token !== openToken || editedRows !== rows;
  }

  // Fetch the driver's per-channel settings schema for the selection.
  //
  // Extras are per-memory in principle, so there is no schema for a set of
  // channels -- only for one. The first selected channel's slot is what is
  // read, and the message above the section says so, because a driver that did
  // vary its extras by slot would otherwise offer fields the rest of the
  // selection has no equivalent for. The upload path ignores names a
  // destination memory does not have (_apply_row_extras_to_memory in
  // web/python/webchirp_bridge/channel_extra.py), so the failure mode is a
  // setting that does not land, not a corrupted channel.
  async function loadExtraFields(rows, token) {
    const radio = state.selectedRadio;
    if (!radio) {
      setExtraMessage("Select a radio to edit driver-specific channel settings.");
      return;
    }
    const location = String(rows[0]?.Location ?? "").trim();
    setExtraMessage("Reading the driver's per-channel settings...");
    let payload = null;
    try {
      payload = await requireRuntimeApi(state).getChannelExtra({
        module: radio.module,
        className: radio.className,
        location,
      });
    } catch (error) {
      if (superseded(rows, token)) {
        return;
      }
      setExtraMessage("Extra settings could not be read for these channels.");
      log.reportActionError("Bulk channel edit", error);
      return;
    }
    if (superseded(rows, token)) {
      return;
    }
    if (!payload?.available) {
      setExtraMessage(payload?.message || "This radio has no extra settings for its channels.");
      return;
    }
    // Immutable settings are dropped rather than shown disabled the way the
    // single-channel editor shows them: there they are context for the channel
    // being edited, here they are a field that could be ticked and could never
    // be applied.
    const fields = (payload.fields || []).filter((field) => field.mutable !== false);
    if (fields.length === 0) {
      setExtraMessage("This radio has no editable extra settings for its channels.");
      return;
    }
    setExtraMessage(
      `Read from channel ${location || "?"}; whatever you tick here is written to `
      + `all ${rows.length} selected channel(s).`,
    );
    renderExtraFields(fields, rows);
  }

  // Open the editor on the current selection. The columns render immediately —
  // they need nothing but the schema the grid already has — while the extras
  // are fetched, so a slow first call (this can be the one that boots Pyodide)
  // leaves a usable dialog rather than an empty one.
  function open(trigger = null) {
    const rows = ctx.table.selectedChannelRows();
    if (rows.length === 0) {
      log.setStatus("Select one or more channels to edit them in bulk.");
      return Promise.resolve();
    }
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return Promise.resolve();
    }
    // Where focus goes back to on every close path. The caller hands the button
    // over rather than this reading document.activeElement, because a click does
    // not focus a button on every platform (Safari does not).
    triggerElement = trigger;
    const token = openToken + 1;
    openToken = token;
    editedRows = rows;
    dom.channelBulkEditTitleEl.textContent =
      `Edit ${rows.length} selected channel${rows.length === 1 ? "" : "s"}`;
    setMessage("Tick an attribute to give every selected channel the same value. "
      + "Anything left unticked is left as it is.");
    renderColumnFields(rows);
    dom.channelBulkEditExtraGridEl.innerHTML = "";
    extraFields = [];
    setExtraMessage("");
    setModalOpen(true);
    // Immediately, not when the extras arrive: until focus is inside the dialog
    // the keyboard is still on the toolbar button behind the overlay.
    (columnFields[0]?.apply ?? dom.channelBulkEditCancelEl).focus?.();
    trackEvent("channels_bulk_edit_opened", {
      ...radioEventParams(state.selectedRadio),
      channel_count: rows.length,
    });
    return loadExtraFields(rows, token);
  }

  // Write the ticked values onto every selected channel.
  //
  // Everything is validated before anything is written. A bulk edit that gave
  // up half way would leave the selection in two states with nothing to say
  // which channels took the value, and the grid's own per-cell rejection is
  // invisible in a row (see normalizeCellValue in
  // web/js/ui/channel-values.js) -- a tone the radio's table lacks becomes
  // 67.0 Hz rather than an error. So a value this radio will not take stops the
  // whole apply and is reported on its own field.
  function apply() {
    const rows = editedRows;
    if (rows.length === 0) {
      setModalOpen(false);
      return;
    }
    // A download or an image load replaces state.currentRows wholesale without
    // closing this modal, which would leave the apply mutating rows that are no
    // longer in the editor -- reported as success, absent from what is later
    // uploaded.
    if (rows.some((row) => !state.currentRows.includes(row))) {
      setModalOpen(false);
      log.setStatus("The channel list changed while the bulk editor was open; nothing was changed.");
      return;
    }

    const columnWrites = [];
    const extraWrites = {};
    let invalid = 0;
    for (const entry of columnFields) {
      entry.setError("");
      if (!entry.apply.checked) {
        continue;
      }
      const value = String(entry.control.value ?? "");
      const meta = state.radioMetadata.columns?.[entry.column] || {};
      // Checked against a blank previous value on purpose: what matters is
      // whether the column can hold this value at all, not what it held before.
      const check = normalizeCellValue(entry.column, value, meta, "", { allowReadOnly: true });
      if (!check.accepted) {
        entry.setError(`The selected radio does not accept this ${entry.column}.`);
        invalid += 1;
        continue;
      }
      columnWrites.push({ column: entry.column, value });
    }
    for (const entry of extraFields) {
      entry.setError("");
      if (!entry.apply.checked) {
        continue;
      }
      const { value, error } = readSettingControl(entry.field, entry.control);
      if (error) {
        entry.setError(error);
        invalid += 1;
        continue;
      }
      extraWrites[entry.field.name] = value;
    }
    if (invalid > 0) {
      setMessage(`Fix ${invalid} highlighted value${invalid === 1 ? "" : "s"} before applying.`);
      return;
    }
    const extraCount = Object.keys(extraWrites).length;
    const fieldCount = columnWrites.length + extraCount;
    if (fieldCount === 0) {
      setMessage("Tick at least one attribute to change, or cancel.");
      return;
    }

    for (const row of rows) {
      for (const { column, value } of columnWrites) {
        ctx.table.setRowValueIfPresent(row, column, value);
      }
      if (extraCount > 0) {
        // A fresh object per row: setRowExtras merges into whatever the row
        // already carries, and one shared object would leave every row holding
        // the same mapping.
        setRowExtras(row, { ...extraWrites });
      }
    }
    // The values the preflight objected to are no longer the values in the
    // rows, so its highlights no longer describe them.
    ctx.table.clearInvalidHighlights();
    ctx.table.render();
    setModalOpen(false);
    trackEvent("channels_bulk_edited", {
      ...radioEventParams(state.selectedRadio),
      channel_count: rows.length,
      field_count: fieldCount,
    });
    log.setStatus(
      `Applied ${fieldCount} attribute(s) to ${rows.length} selected channel(s)`
      + `${extraCount > 0 ? "; extra settings are written on upload or image export." : "."}`,
    );
  }

  function bindEvents() {
    dom.channelBulkEditEl.addEventListener("click", () => {
      open(dom.channelBulkEditEl);
    });
    dom.channelBulkEditCancelEl.addEventListener("click", () => {
      setModalOpen(false);
    });
    dom.channelBulkEditModalEl.addEventListener("click", (event) => {
      if (event.target === dom.channelBulkEditModalEl) {
        setModalOpen(false);
      }
    });
    dom.channelBulkEditFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      apply();
    });
  }

  return { bindEvents, isModalOpen, closeModal, open, refreshAvailability };
}

import { radioEventParams, trackEvent } from "./analytics.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { requireRuntimeApi } from "./state.js";
import { createSettingControl, readSettingControl } from "./setting-fields.js";

// The bulk editor: one form that writes the same value into every selected
// channel.
//
// Editing twenty channels to the same tone one cell at a time is the thing the
// grid is worst at, so this modal lists every attribute the grid has a column
// for together with the driver's per-channel extras, and applies what the user
// filled in to the whole selection at once.
//
// Every field is armed by its own tick box, and only an armed field is
// written. That is what makes "set the mode on these twelve channels" possible
// without also flattening their names: a form that applied everything it shows
// would have to invent a value for each field it was not asked about, and the
// values it opens on belong to the first selected channel, not to the rest.
//
// Column fields go through the table's own validating writer, so a value this
// radio will not take is rejected exactly as it would be in a cell rather than
// stored and discovered at upload. Extra fields land in the row sidecar
// (web/js/row-extra.js), the same place the per-channel editor in
// web/js/ui/channel-extra.js writes them.
export function createChannelBulkEdit(ctx) {
  const { dom, state, log } = ctx;

  // The rows the form was opened on, and one entry per rendered field. Both
  // are dropped on close, which is also what makes a late schema response
  // harmless: it finds a closed modal and returns.
  let editedRows = [];
  let fieldControls = [];
  // The toolbar button the open came from, refocused when the modal closes.
  let triggerElement = null;
  // Bumped on every open so the response to a superseded open cannot render
  // over the one the user is looking at.
  let openToken = 0;

  const FIELD_ID_PREFIX = "channel-bulk-edit-field-";
  // The memory slot a channel occupies is what identifies it; writing one
  // number into a whole selection would collapse them onto each other.
  const EXCLUDED_COLUMNS = new Set(["Location"]);

  function isModalOpen() {
    return !dom.channelBulkEditModalEl.classList.contains("hidden");
  }

  function setModalOpen(open) {
    dom.channelBulkEditModalEl.classList.toggle("hidden", !open);
    if (!open) {
      editedRows = [];
      fieldControls = [];
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

  // The toolbar button is only live with a selection, because "edit in bulk"
  // with nothing selected has no answer: the grid's other actions fall back to
  // every channel (see selectedRowsForOperations), and silently rewriting a
  // whole codeplug is not a fallback anyone wants.
  function updateToolbarState() {
    dom.channelBulkEditEl.disabled = ctx.table.explicitlySelectedRows().length === 0;
  }

  // Describe one grid column as the field shape the shared controls render.
  // The grid's column metadata (CHIRP's own, via get_radio_metadata) and a
  // driver setting are different vocabularies for the same handful of kinds;
  // this is the translation, and returns null for a column nobody may edit.
  function columnField(column) {
    if (EXCLUDED_COLUMNS.has(column)) {
      return null;
    }
    const meta = state.radioMetadata.columns?.[column] || {};
    if (meta.editable === false) {
      return null;
    }
    const field = { name: column, label: column, mutable: true, kind: "column" };
    if (meta.kind === "enum") {
      return { ...field, type: "enum", options: Array.isArray(meta.options) ? meta.options.map(String) : [] };
    }
    if (meta.kind === "int") {
      return { ...field, type: "integer", min: meta.min, max: meta.max };
    }
    // A frequency is typed as MHz text rather than as a number input: CHIRP
    // spells it "446.006250", and a number input drops the trailing zeros the
    // moment the browser reformats it. Band membership is checked by the
    // table's writer when the value is applied.
    return {
      ...field,
      type: "text",
      maxLength: meta.kind === "text" ? meta.maxLength : undefined,
      charset: meta.kind === "text" ? meta.validChars : undefined,
    };
  }

  function columnFields() {
    return state.currentHeaders.map(columnField).filter(Boolean);
  }

  // One tick box, one label and one control per field, filling the modal's
  // two-column grid. Returns the entry the apply path reads the field back
  // through.
  function appendField(field, current) {
    const controlId = `${FIELD_ID_PREFIX}${field.kind}-${field.name}`;
    const labelCell = document.createElement("div");
    labelCell.className = "channel-bulk-edit-label";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "channel-bulk-edit-toggle";
    toggle.id = `${controlId}-apply`;
    toggle.name = `apply-${field.kind}-${field.name}`;
    // What the tick means, for anyone who reaches it without seeing the hint.
    toggle.title = `Write ${field.label || field.name} to every selected channel`;
    labelCell.appendChild(toggle);
    const label = document.createElement("label");
    label.htmlFor = controlId;
    label.textContent = field.label || field.name;
    labelCell.appendChild(label);
    if (field.doc) {
      const doc = document.createElement("div");
      doc.className = "channel-extra-doc";
      doc.textContent = field.doc;
      labelCell.appendChild(doc);
    }

    const controlCell = document.createElement("div");
    controlCell.className = "channel-bulk-edit-control is-idle";
    const control = createSettingControl(field, current);
    control.id = controlId;
    control.name = `${field.kind}-${field.name}`;
    controlCell.appendChild(control);
    const errorEl = document.createElement("div");
    errorEl.className = "channel-extra-error";
    errorEl.hidden = true;
    controlCell.appendChild(errorEl);

    // Touching a value is the same statement as ticking the box, so it arms
    // the field: a form where a typed value does nothing until a second click
    // is a form that silently discards edits.
    const arm = () => {
      toggle.checked = true;
      controlCell.classList.remove("is-idle");
    };
    control.addEventListener("input", arm);
    control.addEventListener("change", arm);
    toggle.addEventListener("change", () => {
      controlCell.classList.toggle("is-idle", !toggle.checked);
    });

    dom.channelBulkEditGridEl.appendChild(labelCell);
    dom.channelBulkEditGridEl.appendChild(controlCell);
    return {
      field,
      control,
      toggle,
      isArmed: () => Boolean(toggle.checked),
      setError(text) {
        errorEl.textContent = String(text || "");
        errorEl.hidden = !text;
        controlCell.classList.toggle("is-invalid", Boolean(text));
      },
    };
  }

  // Render the grid columns first and the driver extras after, each field
  // opening on what the first selected channel holds -- the selection has no
  // single value to show, and the channel the user started from is the one
  // they are most likely to be spreading.
  function renderFields(extraFields) {
    const firstRow = editedRows[0] || {};
    const stored = rowExtras(firstRow) || {};
    const entries = columnFields().map((field) => appendField(field, firstRow[field.name] ?? ""));
    for (const field of extraFields) {
      if (field.mutable === false) {
        // Nothing may write it, so an armed tick next to it would be a lie.
        continue;
      }
      const current = Object.hasOwn(stored, field.name) ? stored[field.name] : field.current;
      entries.push(appendField({ ...field, kind: "extra" }, current));
    }
    fieldControls = entries;
    fieldControls[0]?.control.focus?.();
  }

  // Ask the runtime what extras the driver gives the first selected channel.
  // Per-memory in principle, so this describes one slot; in practice a driver
  // publishes the same set for every memory, and the alternative -- refusing
  // to offer extras at all in bulk -- is what the issue asks against.
  async function loadExtraFields(radio) {
    if (!radio) {
      return { fields: [], note: "Select a radio to also edit driver-specific channel settings." };
    }
    const location = String(editedRows[0]?.Location ?? "").trim();
    let payload = null;
    try {
      payload = await requireRuntimeApi(state).getChannelExtra({
        module: radio.module,
        className: radio.className,
        location,
      });
    } catch (error) {
      // Not fatal: the grid's own columns are still editable in bulk, and the
      // full traceback is in the debug panel.
      log.reportActionError("Bulk channel edit", error);
      return { fields: [], note: "Driver-specific channel settings could not be read; columns can still be edited." };
    }
    if (!payload?.available) {
      return { fields: [], note: payload?.message || "" };
    }
    return { fields: payload.fields || [], note: "" };
  }

  // Open the editor for the current selection. The modal opens before the
  // runtime is asked anything, so a slow first call (this can be the one that
  // boots Pyodide) shows a dialog that is loading rather than a click that did
  // nothing.
  async function openForSelection(trigger = null) {
    const rows = ctx.table.explicitlySelectedRows();
    if (rows.length === 0) {
      log.setStatus("Select one or more channels to edit in bulk.");
      return;
    }
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    triggerElement = trigger;
    const radio = state.selectedRadio;
    const token = openToken + 1;
    openToken = token;
    editedRows = rows;
    dom.channelBulkEditTitleEl.textContent =
      `Edit ${rows.length} selected channel${rows.length === 1 ? "" : "s"}`;
    dom.channelBulkEditGridEl.innerHTML = "";
    fieldControls = [];
    dom.channelBulkEditApplyEl.disabled = true;
    setMessage("Reading the driver's channel settings...");
    setModalOpen(true);
    // Immediately, not when the fields arrive: until focus is inside the
    // dialog the keyboard is still on the button behind the overlay.
    dom.channelBulkEditCancelEl.focus?.();

    const { fields, note } = await loadExtraFields(radio);
    // A response for a selection the user has since closed or replaced has
    // nowhere to render.
    if (token !== openToken || !isModalOpen()) {
      return;
    }
    setMessage(note);
    renderFields(fields);
    dom.channelBulkEditApplyEl.disabled = false;
    trackEvent("channel_bulk_edit_opened", {
      ...radioEventParams(radio),
      channel_count: rows.length,
    });
  }

  // Write the armed fields onto every selected channel.
  //
  // Column values go through the table's validating writer, which reports
  // whether the radio actually took the value: a rejected enum leaves a
  // perfectly valid looking option in the cell, so a refusal has to be counted
  // here rather than inferred from the row afterwards. Extras go into the row
  // sidecar, one merge per row, so a channel keeps whatever it already carried
  // for the fields this form did not touch.
  function apply() {
    if (editedRows.length === 0) {
      return;
    }
    // A download or an image load replaces state.currentRows wholesale without
    // closing this modal, which would leave the apply mutating rows that are no
    // longer in the grid -- reported as success, absent from what is uploaded.
    const rows = editedRows.filter((row) => state.currentRows.includes(row));
    if (rows.length !== editedRows.length) {
      setModalOpen(false);
      log.setStatus("The channel list changed while the bulk editor was open; nothing was changed.");
      return;
    }

    const armed = [];
    let invalid = 0;
    for (const entry of fieldControls) {
      if (!entry.isArmed()) {
        entry.setError("");
        continue;
      }
      const { value, error } = readSettingControl(entry.field, entry.control);
      entry.setError(error);
      if (error) {
        invalid += 1;
        continue;
      }
      armed.push({ field: entry.field, value });
    }
    if (invalid > 0) {
      setMessage(`Fix ${invalid} highlighted value${invalid === 1 ? "" : "s"} before applying.`);
      return;
    }
    if (armed.length === 0) {
      setMessage("Tick at least one field to apply it to the selected channels.");
      return;
    }

    const rejectedColumns = new Set();
    for (const row of rows) {
      const extras = {};
      for (const { field, value } of armed) {
        if (field.kind === "extra") {
          extras[field.name] = value;
          continue;
        }
        if (!ctx.table.setRowValueIfPresent(row, field.name, value)) {
          rejectedColumns.add(field.name);
        }
      }
      setRowExtras(row, extras);
    }

    setModalOpen(false);
    ctx.table.render();
    trackEvent("channel_bulk_edit_applied", {
      ...radioEventParams(state.selectedRadio),
      channel_count: rows.length,
    });
    const fieldCount = armed.length;
    const rejectedNote = rejectedColumns.size > 0
      ? ` This radio did not accept the value given for ${Array.from(rejectedColumns).join(", ")}.`
      : "";
    log.setStatus(
      `Applied ${fieldCount} field${fieldCount === 1 ? "" : "s"} to `
      + `${rows.length} channel${rows.length === 1 ? "" : "s"}.${rejectedNote}`,
    );
  }

  function bindEvents() {
    dom.channelBulkEditEl.addEventListener("click", () => {
      openForSelection(dom.channelBulkEditEl);
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

  return { bindEvents, isModalOpen, closeModal, openForSelection, updateToolbarState };
}

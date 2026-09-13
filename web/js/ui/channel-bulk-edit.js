import { radioEventParams, trackEvent } from "./analytics.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { requireRuntimeApi } from "./state.js";

// Bulk editing of the selected channels: the modal behind the grid toolbar's
// "Edit in bulk" button (issue #146).
//
// Setting the same Mode, Power or Tone on thirty imported repeaters is thirty
// cell edits in the grid. This modal offers one control per editable grid
// column, plus the driver's per-channel extras (the same schema
// web/js/ui/channel-extra.js renders for a single channel), and writes what was
// set onto every selected row.
//
// The opt-in checkbox beside each field is the whole design: a control's value
// means nothing until its box is ticked, so opening the modal and applying it
// changes nothing, and a field left alone keeps whatever each selected channel
// already holds. That is what makes "set Power on these twenty" possible
// without flattening their nineteen other columns onto one value.
export function createChannelBulkEdit(ctx) {
  const { dom, state, log } = ctx;

  // The rows the open captured, and one entry per rendered field. Dropped on
  // close, which is also what makes a late extras response harmless.
  let editedRows = [];
  let fieldControls = [];
  let openToken = 0;

  const FIELD_ID_PREFIX = "channel-bulk-field-";

  // Location is per-channel by definition -- it is which memory slot a channel
  // occupies -- so there is nothing to set on many channels at once, and the
  // grid renders it as the selection handle rather than an editor.
  const EXCLUDED_COLUMNS = new Set(["Location"]);

  function isModalOpen() {
    return !dom.channelBulkEditModalEl.classList.contains("hidden");
  }

  function setModalOpen(open) {
    dom.channelBulkEditModalEl.classList.toggle("hidden", !open);
    if (!open) {
      editedRows = [];
      fieldControls = [];
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

  // One field row: the opt-in checkbox and label on the left, the control on
  // the right. `apply` is what the Apply handler calls once per selected row,
  // so a column field and an extras field can sit in the same list.
  function appendField({ key, label, doc, control, apply, immutable = false }) {
    const controlId = `${FIELD_ID_PREFIX}${key}`;
    const labelCell = document.createElement("div");
    labelCell.className = "channel-bulk-label";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "channel-bulk-toggle";
    toggle.dataset.field = key;
    toggle.disabled = immutable;
    const labelEl = document.createElement("label");
    labelEl.htmlFor = controlId;
    labelEl.textContent = label;
    labelCell.appendChild(toggle);
    labelCell.appendChild(labelEl);
    if (doc) {
      const docEl = document.createElement("div");
      docEl.className = "channel-extra-doc";
      docEl.textContent = doc;
      labelCell.appendChild(docEl);
    }

    const controlCell = document.createElement("div");
    controlCell.className = "channel-extra-control";
    control.id = controlId;
    control.name = key;
    control.disabled = immutable;
    controlCell.appendChild(control);

    dom.channelBulkEditGridEl.appendChild(labelCell);
    dom.channelBulkEditGridEl.appendChild(controlCell);
    fieldControls.push({ key, toggle, control, apply });
  }

  // Build the control for one grid column from the same CHIRP column metadata
  // the grid's own cells are built from, so the bulk value offers exactly the
  // options a cell would accept.
  function columnControl(meta) {
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      const select = document.createElement("select");
      for (const option of meta.options.map(String)) {
        const optionEl = document.createElement("option");
        optionEl.value = option;
        optionEl.textContent = option;
        select.appendChild(optionEl);
      }
      return select;
    }
    const input = document.createElement("input");
    input.type = "text";
    if (Number.isFinite(meta.maxLength)) {
      input.maxLength = Number(meta.maxLength);
    }
    return input;
  }

  // The grid's columns, minus the ones no bulk value applies to. The write goes
  // through the table's own validating writer, so a value this driver rejects
  // leaves the row as it was rather than being stored unchecked.
  function renderColumnFields() {
    for (const column of state.currentHeaders) {
      if (EXCLUDED_COLUMNS.has(column)) {
        continue;
      }
      const meta = state.radioMetadata.columns?.[column] || {};
      if (meta.editable === false) {
        continue;
      }
      const control = columnControl(meta);
      appendField({
        key: `column:${column}`,
        label: column,
        control,
        apply: (row) => ctx.table.setRowValueIfPresent(row, column, control.value ?? ""),
      });
    }
  }

  // The driver's per-channel extras, read once for the first selected channel's
  // memory. One schema for the whole selection is the point: these settings are
  // driver-wide in shape even though their values are per-channel.
  function renderExtraFields(fields) {
    for (const field of fields) {
      if (field.mutable === false) {
        continue;
      }
      let control;
      if (field.type === "boolean") {
        control = document.createElement("select");
        for (const option of ["On", "Off"]) {
          const optionEl = document.createElement("option");
          optionEl.value = option;
          optionEl.textContent = option;
          control.appendChild(optionEl);
        }
      } else if (field.type === "enum") {
        control = document.createElement("select");
        for (const option of Array.isArray(field.options) ? field.options : []) {
          const optionEl = document.createElement("option");
          optionEl.value = String(option);
          optionEl.textContent = String(option);
          control.appendChild(optionEl);
        }
      } else {
        control = document.createElement("input");
        control.type = field.type === "integer" || field.type === "float" ? "number" : "text";
      }
      appendField({
        key: `extra:${field.name}`,
        label: field.label || field.name,
        doc: field.doc,
        control,
        apply: (row) => {
          const raw = String(control.value ?? "");
          let value = raw;
          if (field.type === "boolean") {
            value = raw === "On";
          } else if (field.type === "integer" || field.type === "float") {
            const parsed = Number(raw.trim());
            if (!Number.isFinite(parsed)) {
              return false;
            }
            value = parsed;
          }
          setRowExtras(row, { [field.name]: value });
          return true;
        },
      });
    }
  }

  // Open the modal for whatever is selected in the grid. Like the per-channel
  // editor, the dialog opens before the runtime is asked anything so a slow
  // first call shows a dialog that is loading rather than a click that did
  // nothing.
  async function openForSelection() {
    const rows = ctx.table.selectedChannelRows();
    if (rows.length === 0) {
      log.setStatus("Select one or more channels to edit in bulk.");
      return;
    }
    const token = openToken + 1;
    openToken = token;
    editedRows = rows;
    fieldControls = [];
    dom.channelBulkEditGridEl.innerHTML = "";
    dom.channelBulkEditTitleEl.textContent =
      `Edit ${rows.length} selected channel${rows.length === 1 ? "" : "s"}`;
    setMessage("Tick a field to set it on every selected channel; anything left unticked is unchanged.");
    setModalOpen(true);
    renderColumnFields();
    dom.channelBulkEditCancelEl.focus?.();

    const radio = state.selectedRadio;
    if (!radio) {
      trackEvent("channel_bulk_edit_opened", { outcome: "ok", channel_count: rows.length });
      return;
    }
    let payload = null;
    try {
      payload = await requireRuntimeApi(state).getChannelExtra({
        module: radio.module,
        className: radio.className,
        location: String(rows[0].Location ?? "").trim(),
      });
    } catch (error) {
      if (token !== openToken) {
        return;
      }
      // Not fatal: the column fields are rendered and usable, so say what is
      // missing rather than closing the dialog on the user.
      setMessage("Driver-specific channel settings could not be read; the columns above can still be set.");
      log.reportActionError("Bulk channel edit", error);
      trackEvent("channel_bulk_edit_opened", {
        ...radioEventParams(radio),
        outcome: "failed",
        channel_count: rows.length,
      });
      return;
    }
    if (token !== openToken) {
      return;
    }
    if (payload?.available) {
      renderExtraFields(payload.fields || []);
    }
    trackEvent("channel_bulk_edit_opened", {
      ...radioEventParams(radio),
      outcome: payload?.available ? "ok" : "unavailable",
      channel_count: rows.length,
    });
  }

  // Write every ticked field onto every selected row.
  function apply() {
    const rows = editedRows;
    // A download or an image load can replace state.currentRows wholesale while
    // the modal is open, which would leave this mutating rows nothing uploads.
    const live = rows.filter((row) => state.currentRows.includes(row));
    if (live.length !== rows.length) {
      setModalOpen(false);
      log.setStatus("The channel list changed while the bulk editor was open; nothing was applied.");
      return;
    }
    const selected = fieldControls.filter((entry) => entry.toggle.checked);
    if (selected.length === 0) {
      setModalOpen(false);
      log.setStatus("No fields were ticked, so no channels were changed.");
      return;
    }
    let rejected = 0;
    for (const row of live) {
      for (const entry of selected) {
        if (entry.apply(row) === false) {
          rejected += 1;
        }
      }
    }
    setModalOpen(false);
    ctx.table.render();
    trackEvent("channel_bulk_edit_applied", {
      ...radioEventParams(state.selectedRadio),
      channel_count: live.length,
    });
    const fieldWord = selected.length === 1 ? "field" : "fields";
    log.setStatus(
      `Applied ${selected.length} ${fieldWord} to ${live.length} channel(s).`
      + (rejected > 0 ? ` ${rejected} value(s) were rejected by the driver and left unchanged.` : ""),
    );
  }

  function bindEvents() {
    dom.channelBulkEditEl.addEventListener("click", () => {
      openForSelection();
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

  return { bindEvents, isModalOpen, closeModal, openForSelection };
}

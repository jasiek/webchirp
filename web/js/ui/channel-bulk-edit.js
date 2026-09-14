import { radioEventParams, trackEvent } from "./analytics.js";
import { normalizeCellValue } from "./channel-values.js";
import { columnDoc } from "./column-docs.js";
import { createExtraFieldControl, readExtraFieldControl } from "./extra-field-controls.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { requireRuntimeApi } from "./state.js";

// Bulk-editing the channels selected in the grid (issue #146): one modal that
// lists every editable grid column plus the driver's per-channel extras (the
// same fields web/js/ui/channel-extra.js edits one channel at a time), each
// behind its own "set this" checkbox. Applying writes only the checked
// fields onto every selected row and leaves the rest of each channel alone.
//
// There is no runtime round trip to apply a change: a checked field's value
// is validated once against the schema already in state.radioMetadata (for
// grid columns) or read straight off the driver's own field descriptors (for
// extras), then copied onto each selected row exactly as a single cell edit
// or the per-channel extras editor would. The only RPC this makes is
// get_channel_extra, reused as-is to read which extra fields the driver
// offers -- from one representative channel, since Memory.extra is a schema
// per driver, not per memory, in every driver that ships one today.
export function createChannelBulkEdit(ctx) {
  const { dom, state, log } = ctx;

  // The rows being edited and one entry per rendered field, both dropped on
  // close -- the same lifecycle web/js/ui/channel-extra.js uses, and for the
  // same reason: it makes a response that arrives after the modal closed
  // harmless rather than something that has to be guarded everywhere.
  let editedRows = [];
  let fieldEntries = [];
  let triggerElement = null;
  // Bumped on every open so a slow get_channel_extra reply for a superseded
  // open cannot render extra fields over the ones the user is looking at.
  let openToken = 0;
  // The schema every attribute field was built from. Selecting a radio leaves
  // the previous one in place while the new metadata loads, so a modal opened
  // in that window renders the old columns, options and bounds -- and applying
  // it afterwards would validate against a schema the grid no longer runs on.
  // Held by identity because applyRadioMetadata (web/js/ui/radio-catalog.js)
  // assigns a fresh object rather than mutating this one.
  let schemaAtOpen = null;

  // Whether the modal is on screen. ui.js reads this to route Escape.
  function isModalOpen() {
    return !dom.channelBulkEditModalEl.classList.contains("hidden");
  }

  // Show or hide the modal. Closing drops everything the open was about, so a
  // reply that arrives afterwards has nothing to render into.
  function setModalOpen(open) {
    dom.channelBulkEditModalEl.classList.toggle("hidden", !open);
    if (!open) {
      editedRows = [];
      fieldEntries = [];
      triggerElement?.focus?.();
      triggerElement = null;
      schemaAtOpen = null;
    }
  }

  // Close without applying, for Escape and the overlay click ui.js owns.
  function closeModal() {
    setModalOpen(false);
  }

  // The one line above the field list that explains why an Apply did not
  // happen, or what the driver says is missing. Blank hides it.
  function setMessage(text) {
    const message = String(text || "");
    dom.channelBulkEditMessageEl.textContent = message;
    dom.channelBulkEditMessageEl.hidden = message === "";
  }

  // A heading spanning the whole grid, so the checkbox/label/control rows
  // below it read as "channel columns" or "extra settings" rather than one
  // undifferentiated list.
  function appendSectionTitle(text) {
    const title = document.createElement("div");
    title.className = "channel-bulk-edit-section-title";
    title.textContent = text;
    dom.channelBulkEditGridEl.appendChild(title);
  }

  // Three grid cells shared by every field row, whatever kind of value it
  // edits: a checkbox that opts the field into the write, its label, and a
  // slot the caller fills with the value control. Unchecked is the default,
  // because "no attributes set" -- leave every selected channel exactly as it
  // is -- has to be the do-nothing state for a form that writes to every
  // channel someone selected.
  //
  // The control stays live while the field is unchecked rather than being
  // disabled, for two reasons: touching it is what ticks the box (nobody has
  // to find the checkbox first), and a field switched back off keeps whatever
  // was typed, so changing one's mind twice costs nothing. Off is shown by
  // dimming the row, and only the checkbox decides what apply() writes.
  function appendFieldRow(idPrefix, name, label, control, doc) {
    const controlId = `${idPrefix}${name}`;
    const toggleCell = document.createElement("div");
    toggleCell.className = "channel-bulk-edit-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `${controlId}-enabled`;
    // The checkbox is its own control with no <label> of its own -- the label
    // beside it belongs to the value control -- so it needs a spoken name, or
    // a screen reader reads a column of bare "checkbox".
    checkbox.setAttribute("aria-label", `Apply ${label} to every selected channel`);
    toggleCell.appendChild(checkbox);

    const labelCell = document.createElement("div");
    labelCell.className = "channel-bulk-edit-label";
    const labelEl = document.createElement("label");
    labelEl.htmlFor = controlId;
    labelEl.textContent = label;
    labelCell.appendChild(labelEl);
    if (doc) {
      const docEl = document.createElement("div");
      docEl.className = "channel-bulk-edit-doc";
      docEl.textContent = doc;
      labelCell.appendChild(docEl);
    }

    const controlCell = document.createElement("div");
    controlCell.className = "channel-bulk-edit-control";
    control.id = controlId;
    control.name = name;
    controlCell.appendChild(control);
    const errorEl = document.createElement("div");
    errorEl.className = "channel-bulk-edit-error";
    errorEl.hidden = true;
    controlCell.appendChild(errorEl);

    function setError(text) {
      errorEl.textContent = String(text || "");
      errorEl.hidden = !text;
      controlCell.classList.toggle("is-invalid", Boolean(text));
    }

    // Dim the label and the value while the field is off, so a form whose
    // controls are all editable still reads at a glance as "these four are the
    // ones being written". The checkbox itself is never dimmed: it is the
    // switch, and it has to stay the most legible thing in the row.
    const cells = [labelCell, controlCell];
    function syncEnabledLook() {
      for (const cell of cells) {
        cell.classList.toggle("is-off", !checkbox.checked);
      }
    }

    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) {
        setError("");
      }
      syncEnabledLook();
    });

    // Editing the value is the plainest statement that this field should be
    // written, so it ticks the box: "input" covers typing in a text or number
    // field, "change" covers a select and a boolean extra's own checkbox.
    // Both are idempotent, so a browser that fires both is harmless.
    function optIn() {
      if (!checkbox.checked) {
        checkbox.checked = true;
        syncEnabledLook();
      }
    }
    control.addEventListener("input", optIn);
    control.addEventListener("change", optIn);
    syncEnabledLook();

    dom.channelBulkEditGridEl.appendChild(toggleCell);
    dom.channelBulkEditGridEl.appendChild(labelCell);
    dom.channelBulkEditGridEl.appendChild(controlCell);

    return { checkbox, control, setError };
  }

  // The grid column shape from web/js/ui/channel-table.js, minus its Location
  // and Extra special cases: Location is a memory slot, not an attribute
  // shared across channels, and Extra is not a CSV column at all -- its
  // fields get their own section below, read from the driver rather than
  // from radioMetadata.
  function createAttributeControl(meta) {
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

  // Columns worth offering: CHIRP's own headers, minus Location (a per-channel
  // memory slot, not a value to copy across channels) and minus anything this
  // driver marks read-only (bulk-writing to those would only be rejected).
  function attributeColumns() {
    return state.currentHeaders.filter((column) => {
      if (column === "Location") {
        return false;
      }
      const meta = state.radioMetadata.columns?.[column];
      return meta?.editable !== false;
    });
  }

  // One field row per offerable grid column, built from the schema in hand so
  // the modal has something to show before any runtime call returns.
  function renderAttributeFields() {
    const columns = attributeColumns();
    if (columns.length === 0) {
      return;
    }
    appendSectionTitle("Channel columns");
    for (const column of columns) {
      const meta = state.radioMetadata.columns?.[column] || {};
      const control = createAttributeControl(meta);
      const entry = appendFieldRow(
        "channel-bulk-edit-attr-",
        column,
        column,
        control,
        columnDoc(column),
      );
      fieldEntries.push({ kind: "attribute", column, meta, ...entry });
    }
  }

  // One field row per writable driver extra, seeded from the representative
  // row's own sidecar where it has one. field.current describes the memory
  // slot, which is not the same thing: a row edited through
  // web/js/ui/channel-extra.js, or moved to another Location, carries a value
  // the slot does not know about -- and since checking a box without touching
  // the control applies exactly what is displayed, showing the slot's value
  // there would copy a stale setting onto every selected channel.
  function renderExtraFields(fields) {
    if (!fields.length) {
      return;
    }
    const stored = rowExtras(editedRows[0]) || {};
    appendSectionTitle("Extra settings");
    for (const field of fields) {
      // An immutable field (the driver refuses to write it back) has nothing
      // for bulk-edit to offer: web/js/ui/channel-extra.js still shows it, as
      // a fact about the one channel it opened on, but a checkbox nobody
      // could ever tick is pure clutter across a whole selection.
      if (field.mutable === false) {
        continue;
      }
      const current = Object.hasOwn(stored, field.name) ? stored[field.name] : field.current;
      const control = createExtraFieldControl(field, current);
      const entry = appendFieldRow(
        "channel-bulk-edit-extra-",
        field.name,
        field.label || field.name,
        control,
        field.doc,
      );
      fieldEntries.push({ kind: "extra", field, ...entry });
    }
  }

  // Read the driver's extra-settings schema off one representative channel --
  // the first selected row, in memory order -- exactly as
  // web/js/ui/channel-extra.js reads it for the one channel it edits.
  // Memory.extra is a per-driver schema in every driver shipped today (the
  // per-memory freedom get_channel_extra's own docstring calls out is
  // theoretical), so one read is enough to describe the fields every selected
  // channel can set.
  async function loadExtraFields(radio, location, token) {
    let payload = null;
    try {
      payload = await requireRuntimeApi(state).getChannelExtra({
        module: radio.module,
        className: radio.className,
        location,
      });
    } catch (error) {
      if (token !== openToken) {
        return;
      }
      log.reportActionError("Bulk-edit extra settings", error);
      return;
    }
    if (token !== openToken) {
      return;
    }
    if (payload?.available) {
      renderExtraFields(payload.fields || []);
      return;
    }
    // Unavailable is not the same as "this driver has no extras": it is
    // usually "load or download a codeplug first", and the runtime says which.
    // Dropping that left the modal looking complete while silently missing
    // every extra-setting control (web/js/ui/channel-extra.js shows it too).
    setMessage(payload?.message || "");
  }

  // Open the editor for the currently selected channels. Attribute columns
  // render immediately from state already in hand; extra settings arrive
  // asynchronously (the same call can be the one that boots Pyodide), so the
  // modal opens with whatever it has and grows once that reply lands.
  async function openModal(trigger) {
    const rows = ctx.table.selectedChannelRows();
    if (rows.length === 0) {
      log.setStatus("Select one or more channels to bulk-edit.");
      return;
    }
    triggerElement = trigger;
    const token = openToken + 1;
    openToken = token;
    editedRows = rows;
    fieldEntries = [];
    schemaAtOpen = state.radioMetadata;
    dom.channelBulkEditGridEl.innerHTML = "";
    dom.channelBulkEditTitleEl.textContent =
      `Bulk edit ${rows.length} channel${rows.length === 1 ? "" : "s"}`;
    setMessage("");
    renderAttributeFields();
    setModalOpen(true);
    dom.channelBulkEditCancelEl.focus?.();

    trackEvent("channel_bulk_edit_opened", {
      ...radioEventParams(state.selectedRadio),
      channel_count: rows.length,
    });

    const radio = state.selectedRadio;
    if (!radio) {
      return;
    }
    const location = String(rows[0].Location ?? "").trim();
    await loadExtraFields(radio, location, token);
  }

  // Validate every checked field once, against the schema rather than against
  // any one row, and collect what it resolved to. Returns null the first time
  // a checked field fails, after marking that field's error -- the same
  // fail-fast behaviour save() in web/js/ui/channel-extra.js uses, so one
  // Apply either changes every checked field on every selected channel or
  // changes nothing.
  function collectChanges() {
    const attributeChanges = [];
    const extraValues = {};
    let invalid = 0;
    for (const entry of fieldEntries) {
      entry.setError("");
      if (!entry.checkbox.checked) {
        continue;
      }
      if (entry.kind === "attribute") {
        const { value, accepted } = normalizeCellValue(
          entry.column,
          entry.control.value,
          entry.meta,
          undefined,
          { allowReadOnly: true },
        );
        if (!accepted) {
          entry.setError(`Enter a valid value for ${entry.column}.`);
          invalid += 1;
          continue;
        }
        attributeChanges.push({ column: entry.column, value });
      } else {
        const { value, error } = readExtraFieldControl(entry.field, entry.control);
        if (error) {
          entry.setError(error);
          invalid += 1;
          continue;
        }
        extraValues[entry.field.name] = value;
      }
    }
    if (invalid > 0) {
      return { invalid };
    }
    return { attributeChanges, extraValues };
  }

  // Write every checked field onto every still-live selected row, or explain
  // why nothing was written. All or nothing: one rejected value stops the lot.
  function apply() {
    // Picking a radio swaps state.radioMetadata once the new metadata lands,
    // and the fields on screen were built from whatever was current at open --
    // options, bounds and editability all included. Validating those against
    // the new schema is how an enum value this driver does not publish would
    // get written, so a swap mid-edit is refused rather than reconciled, the
    // same way a replaced row list is below.
    if (schemaAtOpen && state.radioMetadata !== schemaAtOpen) {
      setModalOpen(false);
      log.setStatus("The radio's columns changed while bulk edit was open; nothing was applied.");
      return;
    }
    const { invalid, attributeChanges, extraValues } = collectChanges();
    if (invalid > 0) {
      setMessage(`Fix ${invalid} highlighted value${invalid === 1 ? "" : "s"} before applying.`);
      return;
    }
    const fieldCount = attributeChanges.length + Object.keys(extraValues).length;
    if (fieldCount === 0) {
      setModalOpen(false);
      log.setStatus("No fields were selected to bulk-edit.");
      return;
    }
    // A download, an image load or an import can replace state.currentRows
    // wholesale while this modal is open; only rows still actually in the
    // grid are worth writing to (see the equivalent guard in
    // web/js/ui/channel-extra.js's save()).
    const liveRowSet = new Set(state.currentRows);
    const rows = editedRows.filter((row) => liveRowSet.has(row));
    if (rows.length === 0) {
      setModalOpen(false);
      log.setStatus("The channel list changed while bulk edit was open; nothing was applied.");
      return;
    }
    for (const row of rows) {
      for (const { column, value } of attributeChanges) {
        row[column] = value;
      }
      setRowExtras(row, extraValues);
    }
    // A structural editing operation (insert/remove/paste/...) always clears
    // stale invalid-cell highlights after mutating rows; a bulk edit is no
    // different; and re-rendering is what can make the Extra column appear
    // for the first time, if this was the write that gave a row its first
    // sidecar.
    ctx.table.clearInvalidHighlights();
    ctx.table.render();
    setModalOpen(false);
    trackEvent("channel_bulk_edit_applied", {
      ...radioEventParams(state.selectedRadio),
      channel_count: rows.length,
      field_count: fieldCount,
    });
    log.setStatus(`Updated ${fieldCount} field(s) on ${rows.length} channel(s).`);
  }

  // Wires the toolbar button, Cancel, the overlay click and the form's submit.
  // ui.js owns only Escape, which every modal shares.
  function bindEvents() {
    dom.channelBulkEditEl.addEventListener("click", () => {
      openModal(dom.channelBulkEditEl).catch((error) => {
        log.reportActionError("Bulk edit", error);
      });
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

  return { bindEvents, isModalOpen, closeModal, openModal };
}

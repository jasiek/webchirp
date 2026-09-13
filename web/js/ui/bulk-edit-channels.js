import { radioEventParams, trackEvent } from "./analytics.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { requireRuntimeApi } from "./state.js";

// The bulk-edit modal: edit multiple selected channels at once.
//
// A user selects one or more channels and opens the bulk-edit modal, which
// shows all editable grid columns plus any driver-specific extra settings. Only
// the fields they actually change are applied to each selected channel; the
// rest are left alone. This avoids overwriting different values with blanks
// when editing a mixed selection.
//
// The schema comes from the selected radio's metadata, same as channel-extra.js
// uses. Extra settings are fetched from the first selected row's location, since
// the schema applies radio-wide even though the sidecar values are per-channel.
export function createBulkEditChannels(ctx) {
  const { dom, state, log } = ctx;

  // The rows currently being edited, and one entry per rendered field.
  let editedRows = [];
  let fieldControls = [];
  // The grid button the open came from, refocused when the modal closes.
  let triggerElement = null;
  // Bumped on every open so a late response to a superseded open cannot render
  // over the one the user is looking at.
  let openToken = 0;

  const FIELD_ID_PREFIX = "bulk-edit-field-";

  function isModalOpen() {
    return !dom.bulkEditModalEl.classList.contains("hidden");
  }

  function setModalOpen(open) {
    dom.bulkEditModalEl.classList.toggle("hidden", !open);
    if (!open) {
      editedRows = [];
      fieldControls = [];
      // Hand the keyboard back to where it came from.
      triggerElement?.focus?.();
      triggerElement = null;
    }
  }

  function closeModal() {
    setModalOpen(false);
  }

  function setMessage(text) {
    const message = String(text || "");
    dom.bulkEditMessageEl.textContent = message;
    dom.bulkEditMessageEl.hidden = message === "";
  }

  // Build a control for one field, reusing the logic from channel-extra.js.
  function createControl(field, current) {
    const immutable = field.mutable === false;
    if (field.type === "boolean") {
      const control = document.createElement("input");
      control.type = "checkbox";
      control.checked = Boolean(current);
      control.disabled = immutable;
      return control;
    }
    if (field.type === "enum") {
      const control = document.createElement("select");
      for (const option of Array.isArray(field.options) ? field.options : []) {
        const optionEl = document.createElement("option");
        optionEl.value = String(option);
        optionEl.textContent = String(option);
        control.appendChild(optionEl);
      }
      const wanted = String(current ?? "");
      control.value = wanted;
      if (wanted !== "" && control.value !== wanted) {
        const optionEl = document.createElement("option");
        optionEl.value = wanted;
        optionEl.textContent = wanted;
        control.appendChild(optionEl);
        control.value = wanted;
      }
      control.disabled = immutable;
      return control;
    }
    const control = document.createElement("input");
    const numeric = field.type === "integer" || field.type === "float";
    control.type = numeric ? "number" : "text";
    if (numeric && Number.isFinite(field.min)) {
      control.min = String(field.min);
    }
    if (numeric && Number.isFinite(field.max)) {
      control.max = String(field.max);
    }
    control.value = String(current ?? "");
    control.disabled = immutable;
    return control;
  }

  // Render all editable column fields plus extra settings.
  function renderFields(columnFields, extraFields) {
    fieldControls = [];
    dom.bulkEditGridEl.innerHTML = "";

    // Render grid columns (Frequency, Name, Mode, etc.)
    for (const field of columnFields) {
      const fieldId = FIELD_ID_PREFIX + field.name;
      const label = document.createElement("label");
      label.htmlFor = fieldId;
      label.textContent = field.label || field.name;

      const control = createControl(field, "");
      control.id = fieldId;

      const entry = { field, control, initial: "", setError: () => {} };
      fieldControls.push(entry);

      dom.bulkEditGridEl.appendChild(label);
      dom.bulkEditGridEl.appendChild(control);
    }

    // Render extra settings (driver-specific per-channel settings)
    for (const field of extraFields) {
      const fieldId = FIELD_ID_PREFIX + field.name;
      const label = document.createElement("label");
      label.htmlFor = fieldId;
      label.textContent = field.label || field.name;

      const errorLabel = document.createElement("div");
      errorLabel.className = "control-error";

      const control = createControl(field, "");
      control.id = fieldId;

      const entry = {
        field,
        control,
        initial: "",
        setError: (error) => {
          control.classList.toggle("is-invalid", Boolean(error));
          errorLabel.textContent = String(error || "");
          errorLabel.hidden = !error;
        },
      };
      fieldControls.push(entry);

      dom.bulkEditGridEl.appendChild(label);
      dom.bulkEditGridEl.appendChild(control);
      dom.bulkEditGridEl.appendChild(errorLabel);
    }
  }

  // Read the current value from a control, with validation.
  function readControl(field, control) {
    if (field.type === "boolean") {
      return { value: control.checked, error: "" };
    }
    if (field.type === "enum") {
      return { value: control.value, error: "" };
    }
    const value = String(control.value).trim();
    if (field.type === "integer") {
      const num = Number.parseInt(value, 10);
      if (value !== "" && !Number.isInteger(num)) {
        return { value: "", error: "Must be a whole number" };
      }
      if (Number.isFinite(field.min) && num < field.min) {
        return { value: "", error: `Minimum is ${field.min}` };
      }
      if (Number.isFinite(field.max) && num > field.max) {
        return { value: "", error: `Maximum is ${field.max}` };
      }
      return { value: num, error: "" };
    }
    if (field.type === "float") {
      const num = Number.parseFloat(value);
      if (value !== "" && !Number.isFinite(num)) {
        return { value: "", error: "Must be a number" };
      }
      if (Number.isFinite(field.min) && num < field.min) {
        return { value: "", error: `Minimum is ${field.min}` };
      }
      if (Number.isFinite(field.max) && num > field.max) {
        return { value: "", error: `Maximum is ${field.max}` };
      }
      return { value: num, error: "" };
    }
    return { value, error: "" };
  }

  // Get the editable columns for grid fields.
  function editableColumnFields() {
    const fields = [];
    for (const column of state.currentHeaders) {
      if (column === "Location") {
        continue;
      }
      const meta = state.radioMetadata.columns?.[column] || {};
      const field = {
        name: column,
        label: column,
        type: meta.kind || "text",
        options: meta.options || [],
        min: meta.min,
        max: meta.max,
        mutable: meta.mutable !== false,
      };
      fields.push(field);
    }
    return fields;
  }

  // Fetch extra settings schema from the runtime and return the fields.
  async function loadExtraSettingsSchema(token) {
    if (editedRows.length === 0) {
      return [];
    }
    const firstRow = editedRows[0];
    const location = String(firstRow.Location ?? "").trim();
    if (!location) {
      return [];
    }
    try {
      const api = requireRuntimeApi(state);
      const payload = await api.getChannelExtraSchema(location);
      if (token !== openToken) {
        return [];
      }
      return (payload.fields || []).map((field) => ({
        ...field,
        category: "extra",
      }));
    } catch (error) {
      if (token === openToken) {
        setMessage(`Failed to load extra settings schema: ${error.message}`);
      }
      return [];
    }
  }

  // Open the modal to edit the given rows (passed by reference, not index).
  async function openForRows(rows, trigger) {
    editedRows = rows;
    triggerElement = trigger;
    openToken += 1;
    const token = openToken;

    setModalOpen(true);
    setMessage("");
    dom.bulkEditApplyEl.disabled = true;

    const columnFields = editableColumnFields();
    const extraFields = await loadExtraSettingsSchema(token);

    if (token !== openToken) {
      return;
    }

    const rowCount = rows.length;
    const locationList = rows
      .map((row) => String(row.Location ?? "").trim())
      .filter(Boolean)
      .join(", ");

    dom.bulkEditTitleEl.textContent = `Edit ${rowCount} channel${rowCount === 1 ? "" : "s"}`;
    renderFields(columnFields, extraFields);
    dom.bulkEditApplyEl.disabled = false;

    trackEvent("bulk_edit_opened", {
      ...radioEventParams(state.selectedRadio),
      row_count: rowCount,
    });
  }

  // Apply the edited values to all selected rows.
  function apply() {
    const changes = {};
    let invalid = 0;

    for (const entry of fieldControls) {
      const { value, error } = readControl(entry.field, entry.control);
      entry.setError(error);
      if (error) {
        invalid += 1;
        continue;
      }
      // Only include fields that were actually changed (non-empty).
      if (entry.field.type === "boolean") {
        // Booleans are included if they're true (since false/unchecked is the no-op default).
        if (value) {
          changes[entry.field.name] = value;
        }
      } else if (String(value).trim() !== "") {
        changes[entry.field.name] = value;
      }
    }

    if (invalid > 0) {
      setMessage(`Fix ${invalid} highlighted value${invalid === 1 ? "" : "s"} before applying.`);
      return;
    }

    const changedCount = Object.keys(changes).length;
    if (changedCount === 0) {
      setMessage("No fields were changed.");
      return;
    }

    // Apply the changes to each row.
    for (const row of editedRows) {
      for (const [fieldName, value] of Object.entries(changes)) {
        // Check if it's a grid column or an extra setting.
        if (state.currentHeaders.includes(fieldName)) {
          row[fieldName] = value;
        } else {
          // It's an extra setting; store it in the row's sidecar.
          const extras = rowExtras(row) || {};
          extras[fieldName] = value;
          setRowExtras(row, extras);
        }
      }
    }

    setModalOpen(false);
    const rowCount = editedRows.length;
    trackEvent("bulk_edit_applied", {
      ...radioEventParams(state.selectedRadio),
      row_count: rowCount,
      field_count: changedCount,
    });
    log.setStatus(
      `Updated ${changedCount} field${changedCount === 1 ? "" : "s"} on `
      + `${rowCount} channel${rowCount === 1 ? "" : "s"}.`,
    );
  }

  function bindEvents() {
    // Ensure the modal starts hidden (in case it was created by vivify or not
    // present in the DOM with the hidden class).
    setModalOpen(false);

    dom.bulkEditCancelEl.addEventListener("click", () => {
      setModalOpen(false);
    });
    dom.bulkEditModalEl.addEventListener("click", (event) => {
      if (event.target === dom.bulkEditModalEl) {
        setModalOpen(false);
      }
    });
    dom.bulkEditFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      apply();
    });
  }

  return { bindEvents, isModalOpen, closeModal, openForRows };
}

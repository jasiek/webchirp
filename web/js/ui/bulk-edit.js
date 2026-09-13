import { radioEventParams, trackEvent } from "./analytics.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { requireRuntimeApi } from "./state.js";

// Bulk-edit modal for editing multiple selected channels at once. Allows editing
// both channel attributes (grid columns) and driver-specific extra settings.
// Only values that are explicitly changed are applied; empty fields preserve
// existing values on each channel.
export function createBulkEdit(ctx) {
  const { dom, state, log, actions } = ctx;

  let selectedRowIndexes = new Set();
  let fieldControls = [];
  let triggerElement = null;
  let openToken = 0;

  const FIELD_ID_PREFIX = "channel-bulk-edit-field-";
  const ATTRIBUTE_PREFIX = "attr-";
  const EXTRA_PREFIX = "extra-";

  function isModalOpen() {
    return !dom.channelBulkEditModalEl.classList.contains("hidden");
  }

  function setModalOpen(open) {
    dom.channelBulkEditModalEl.classList.toggle("hidden", !open);
    if (!open) {
      selectedRowIndexes.clear();
      fieldControls = [];
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

  function createControl(field, fieldType) {
    const immutable = field.mutable === false || field.editable === false;

    if (field.type === "boolean") {
      const control = document.createElement("input");
      control.type = "checkbox";
      control.indeterminate = true;
      control.disabled = immutable;
      return control;
    }

    if (field.type === "enum") {
      const control = document.createElement("select");
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = "—";
      control.appendChild(emptyOpt);
      for (const option of Array.isArray(field.options) ? field.options : []) {
        const optionEl = document.createElement("option");
        optionEl.value = String(option);
        optionEl.textContent = String(option);
        control.appendChild(optionEl);
      }
      control.disabled = immutable;
      return control;
    }

    const control = document.createElement("input");
    const numeric = field.type === "integer" || field.type === "float";
    control.type = numeric ? "number" : "text";
    if (numeric) {
      if (Number.isFinite(field.min)) {
        control.min = String(field.min);
      }
      if (Number.isFinite(field.max)) {
        control.max = String(field.max);
      }
      control.step = field.type === "float" ? "any" : String(field.step || 1);
    }
    if (Number.isFinite(field.maxLength)) {
      control.maxLength = Number(field.maxLength);
    }
    control.placeholder = "—";
    control.readOnly = immutable;
    control.disabled = immutable;
    return control;
  }

  function readControl(field, control) {
    if (field.type === "boolean") {
      // Indeterminate state means "don't change" - treat as empty
      if (control.indeterminate) {
        return { value: null, error: "" };
      }
      return { value: Boolean(control.checked), error: "" };
    }

    if (field.type === "enum") {
      const value = String(control.value ?? "");
      // Empty value means "don't change"
      if (value === "") {
        return { value: null, error: "" };
      }
      return { value, error: "" };
    }

    if (field.type === "integer" || field.type === "float") {
      const text = String(control.value ?? "").trim();
      // Empty means "don't change"
      if (text === "") {
        return { value: null, error: "" };
      }
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return { value: null, error: field.type === "integer" ? "Enter a whole number." : "Enter a number." };
      }
      if (field.type === "integer" && !Number.isInteger(parsed)) {
        return { value: parsed, error: "Enter a whole number." };
      }
      if (Number.isFinite(field.min) && parsed < Number(field.min)) {
        return { value: parsed, error: `Value must be at least ${field.min}.` };
      }
      if (Number.isFinite(field.max) && parsed > Number(field.max)) {
        return { value: parsed, error: `Value must be at most ${field.max}.` };
      }
      return { value: parsed, error: "" };
    }

    const text = String(control.value ?? "").trim();
    // Empty means "don't change"
    if (text === "") {
      return { value: null, error: "" };
    }
    if (Number.isFinite(field.maxLength) && text.length > Number(field.maxLength)) {
      return { value: text, error: `Value must be at most ${field.maxLength} characters.` };
    }
    if (field.charset) {
      const allowed = new Set(String(field.charset).split(""));
      const rejected = text.split("").find((character) => !allowed.has(character));
      if (rejected) {
        return { value: text, error: `Character ${JSON.stringify(rejected)} is not allowed.` };
      }
    }
    return { value: text, error: "" };
  }

  function appendField(field, fieldType) {
    const controlId = `${FIELD_ID_PREFIX}${fieldType}-${field.name}`;
    const labelCell = document.createElement("div");
    labelCell.className = "channel-bulk-edit-label";
    const label = document.createElement("label");
    label.htmlFor = controlId;
    label.textContent = field.label || field.name;
    labelCell.appendChild(label);

    if (field.doc) {
      const doc = document.createElement("div");
      doc.className = "channel-bulk-edit-doc";
      doc.textContent = field.doc;
      labelCell.appendChild(doc);
    }

    const controlCell = document.createElement("div");
    controlCell.className = "channel-bulk-edit-control";
    if (field.mutable === false || field.editable === false) {
      controlCell.classList.add("is-immutable");
    }
    const control = createControl(field, fieldType);
    control.id = controlId;
    control.name = `${fieldType}-${field.name}`;
    controlCell.appendChild(control);
    const errorEl = document.createElement("div");
    errorEl.className = "channel-bulk-edit-error";
    errorEl.hidden = true;
    controlCell.appendChild(errorEl);

    dom.channelBulkEditGridEl.appendChild(labelCell);
    dom.channelBulkEditGridEl.appendChild(controlCell);
    return {
      field,
      fieldType,
      control,
      setError(text) {
        errorEl.textContent = String(text || "");
        errorEl.hidden = !text;
        controlCell.classList.toggle("is-invalid", Boolean(text));
      },
    };
  }

  function renderFields(attributes, extras) {
    dom.channelBulkEditGridEl.innerHTML = "";
    fieldControls = [];

    // Add column attribute fields
    if (attributes && attributes.length > 0) {
      for (const field of attributes) {
        fieldControls.push(appendField(field, ATTRIBUTE_PREFIX));
      }
    }

    // Add extra settings fields
    if (extras && extras.length > 0) {
      for (const field of extras) {
        fieldControls.push(appendField(field, EXTRA_PREFIX));
      }
    }

    fieldControls[0]?.control.focus?.();
  }

  async function openForSelection(rowIndexes, trigger = null) {
    selectedRowIndexes = new Set(rowIndexes);
    if (selectedRowIndexes.size === 0) {
      log.setStatus("No channels selected for bulk edit.");
      return;
    }

    triggerElement = trigger;
    const radio = state.selectedRadio;
    const token = openToken + 1;
    openToken = token;

    const count = selectedRowIndexes.size;
    dom.channelBulkEditTitleEl.textContent = count === 1
      ? "Edit 1 selected channel"
      : `Edit ${count} selected channels`;

    dom.channelBulkEditGridEl.innerHTML = "";
    fieldControls = [];
    dom.channelBulkEditSaveEl.disabled = true;
    setMessage("Loading available fields...");
    setModalOpen(true);
    dom.channelBulkEditCancelEl.focus?.();

    if (!radio) {
      setMessage("Select a radio to edit channel settings.");
      return;
    }

    try {
      // Get editable column attributes
      const attributes = [];
      for (const column of state.currentHeaders) {
        if (column === "Location") {
          continue;
        }
        const meta = state.radioMetadata.columns?.[column] || {};
        if (meta.editable === false) {
          continue;
        }
        const field = {
          name: column,
          label: column,
          editable: true,
          ...meta,
        };
        attributes.push(field);
      }

      // Get union of extra fields from all selected channels
      const selectedRows = Array.from(selectedRowIndexes)
        .map((idx) => state.currentRows[idx])
        .filter(Boolean);

      const extraFieldsMap = new Map();
      for (const row of selectedRows) {
        const location = String(row.Location ?? "").trim();
        if (!location) {
          continue;
        }
        try {
          const payload = await requireRuntimeApi(state).getChannelExtra({
            module: radio.module,
            className: radio.className,
            location,
          });
          if (payload?.available && Array.isArray(payload.fields)) {
            for (const field of payload.fields) {
              if (!extraFieldsMap.has(field.name)) {
                extraFieldsMap.set(field.name, field);
              }
            }
          }
        } catch {
          // Skip errors for individual channels; try to get extras from others
        }
      }
      const extras = Array.from(extraFieldsMap.values());

      if (token !== openToken) {
        return;
      }

      setMessage("");
      renderFields(attributes, extras);
      dom.channelBulkEditSaveEl.disabled = false;
      trackEvent("bulk_edit_opened", { ...radioEventParams(radio), channel_count: count });
    } catch (error) {
      if (token !== openToken) {
        return;
      }
      trackEvent("bulk_edit_opened", { ...radioEventParams(radio), outcome: "failed" });
      setMessage("Fields could not be loaded.");
      log.reportActionError("Bulk edit", error);
    }
  }

  function save() {
    if (selectedRowIndexes.size === 0) {
      setModalOpen(false);
      return;
    }

    const selectedRows = Array.from(selectedRowIndexes)
      .map((idx) => state.currentRows[idx])
      .filter(Boolean);

    const attributeChanges = {};
    const extraChanges = {};
    let hasErrors = false;
    let invalid = 0;

    for (const entry of fieldControls) {
      const { value, error } = readControl(entry.field, entry.control);
      entry.setError(error);
      if (error) {
        hasErrors = true;
        invalid += 1;
        continue;
      }

      if (value === null) {
        continue;
      }

      if (entry.fieldType === ATTRIBUTE_PREFIX) {
        attributeChanges[entry.field.name] = value;
      } else if (entry.fieldType === EXTRA_PREFIX) {
        extraChanges[entry.field.name] = value;
      }
    }

    if (hasErrors) {
      setMessage(`Fix ${invalid} highlighted value${invalid === 1 ? "" : "s"} before saving.`);
      return;
    }

    const changedCount = Object.keys(attributeChanges).length + Object.keys(extraChanges).length;
    if (changedCount === 0) {
      setModalOpen(false);
      log.setStatus("No changes were made.");
      return;
    }

    // Apply changes to all selected rows
    for (const row of selectedRows) {
      for (const [key, value] of Object.entries(attributeChanges)) {
        row[key] = String(value);
      }
      if (Object.keys(extraChanges).length > 0) {
        const current = rowExtras(row) || {};
        setRowExtras(row, { ...current, ...extraChanges });
      }
    }

    setModalOpen(false);
    ctx.table.render();
    trackEvent("bulk_edit_saved", {
      ...radioEventParams(state.selectedRadio),
      channel_count: selectedRows.length,
      change_count: changedCount,
    });
    const locations = selectedRows.map((r) => r.Location).filter(Boolean);
    const locationStr = locations.length > 3
      ? `${locations.length} channels`
      : locations.join(", ");
    log.setStatus(`Updated ${locationStr}. Changes are written on upload to the radio or image export.`);
  }

  function bindEvents() {
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
      save();
    });
  }

  return { bindEvents, isModalOpen, closeModal, openForSelection };
}

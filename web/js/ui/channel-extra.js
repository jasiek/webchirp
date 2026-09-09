import { radioEventParams, trackEvent } from "./analytics.js";
import { rowExtras, setRowExtras } from "../row-extra.js";
import { requireRuntimeApi } from "./state.js";

// The per-channel extras editor: the modal behind the grid's Extra column.
//
// A driver hangs settings off a memory that no CSV column can hold -- Busy
// Channel Lockout, PTT-ID, signalling code, scramble. Desktop CHIRP shows them
// as optional extra columns; here one modal edits one channel's set, because
// the list is per-driver and would otherwise widen the grid by an unpredictable
// number of columns.
//
// The values live on the row itself, under the sidecar key in
// web/js/row-extra.js, which is the only thing the upload path reads
// (_apply_row_extras in web/python/webchirp_bridge/channel_extra.py). Their
// *schema* -- type, options, bounds -- can only come from the driver, so it is
// fetched per open from the memory the row occupies. Overlaying the row's
// stored values on that schema is what makes a moved or edited channel show its
// own settings rather than the ones sitting in the slot it now occupies.
export function createChannelExtra(ctx) {
  const { dom, state, log } = ctx;

  // The row currently being edited, and one entry per rendered field. Both are
  // dropped on close, which is also what makes a late response harmless: it
  // finds a different row (or none) and returns.
  let editedRow = null;
  let fieldControls = [];
  // Bumped on every open so the response to a superseded open cannot render
  // over the one the user is looking at.
  let openToken = 0;

  const FIELD_ID_PREFIX = "channel-extra-field-";

  function isModalOpen() {
    return !dom.channelExtraModalEl.classList.contains("hidden");
  }

  function setModalOpen(open) {
    dom.channelExtraModalEl.classList.toggle("hidden", !open);
    if (!open) {
      editedRow = null;
      fieldControls = [];
    }
  }

  function closeModal() {
    setModalOpen(false);
  }

  function setMessage(text) {
    const message = String(text || "");
    dom.channelExtraMessageEl.textContent = message;
    dom.channelExtraMessageEl.hidden = message === "";
  }

  // Build the control for one field from the same value metadata the radio-wide
  // settings panel renders (both come from _serialize_setting_value), minus the
  // panel's live re-render: this modal validates once, on save, so a control
  // here needs no change listener.
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
      // A stored value the driver no longer offers (an image edited elsewhere,
      // a row carried over from another radio) is shown rather than silently
      // snapped to some other option, exactly as the grid's enum cells do.
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
    control.value = current ?? "";
    control.readOnly = immutable;
    control.disabled = immutable;
    return control;
  }

  // Read one control back as the typed value the driver expects, or say what is
  // wrong with it. Bounds are re-checked here rather than left to the number
  // input's min/max, which browsers enforce only on form submission and not at
  // all for a value typed then read by script.
  function readControl(field, control) {
    if (field.type === "boolean") {
      return { value: Boolean(control.checked), error: "" };
    }
    if (field.type === "enum") {
      return { value: String(control.value ?? ""), error: "" };
    }
    if (field.type === "integer" || field.type === "float") {
      const text = String(control.value ?? "").trim();
      const parsed = field.type === "integer"
        ? Number.parseInt(text, 10)
        : Number.parseFloat(text);
      if (!Number.isFinite(parsed)) {
        return { value: null, error: field.type === "integer" ? "Enter a whole number." : "Enter a number." };
      }
      if (Number.isFinite(field.min) && parsed < Number(field.min)) {
        return { value: parsed, error: `Value must be at least ${field.min}.` };
      }
      if (Number.isFinite(field.max) && parsed > Number(field.max)) {
        return { value: parsed, error: `Value must be at most ${field.max}.` };
      }
      return { value: parsed, error: "" };
    }
    const text = String(control.value ?? "");
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

  // One label cell and one control cell per field, filling the modal's
  // two-column grid. Returns the entry the save path reads the field back
  // through.
  function appendField(field, current) {
    const controlId = `${FIELD_ID_PREFIX}${field.name}`;
    const labelCell = document.createElement("div");
    labelCell.className = "channel-extra-label";
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
    controlCell.className = "channel-extra-control";
    if (field.mutable === false) {
      controlCell.classList.add("is-immutable");
    }
    const control = createControl(field, current);
    control.id = controlId;
    control.name = field.name;
    controlCell.appendChild(control);
    const errorEl = document.createElement("div");
    errorEl.className = "channel-extra-error";
    errorEl.hidden = true;
    controlCell.appendChild(errorEl);

    dom.channelExtraGridEl.appendChild(labelCell);
    dom.channelExtraGridEl.appendChild(controlCell);
    return {
      field,
      control,
      setError(text) {
        errorEl.textContent = String(text || "");
        errorEl.hidden = !text;
        controlCell.classList.toggle("is-invalid", Boolean(text));
      },
    };
  }

  function renderFields(fields, stored) {
    dom.channelExtraGridEl.innerHTML = "";
    fieldControls = fields.map((field) => {
      // The row's own value wins over the one read from the slot: it is what
      // this channel carries, wherever it has been moved to since.
      const current = Object.hasOwn(stored, field.name) ? stored[field.name] : field.current;
      return appendField(field, current);
    });
    fieldControls[0]?.control.focus?.();
  }

  // Open the editor for one grid row. The modal opens before the runtime is
  // asked anything, so a slow first call (this can be the one that boots
  // Pyodide) shows a dialog that is loading rather than a click that did
  // nothing.
  async function openForRow(rowIdx) {
    const row = state.currentRows[rowIdx];
    if (!row) {
      return;
    }
    const radio = state.selectedRadio;
    const token = openToken + 1;
    openToken = token;
    editedRow = row;
    const location = String(row.Location ?? "").trim();
    dom.channelExtraTitleEl.textContent = location
      ? `Extra settings for channel ${location}`
      : "Extra settings";
    dom.channelExtraGridEl.innerHTML = "";
    fieldControls = [];
    dom.channelExtraSaveEl.disabled = true;
    setMessage("Reading this channel's extra settings from the driver...");
    setModalOpen(true);

    if (!radio) {
      setMessage("Select a radio to edit driver-specific channel settings.");
      return;
    }

    let payload = null;
    try {
      payload = await requireRuntimeApi(state).getChannelExtra({
        module: radio.module,
        className: radio.className,
        location,
      });
    } catch (error) {
      if (token !== openToken || editedRow !== row) {
        return;
      }
      trackEvent("channel_extra_opened", { ...radioEventParams(radio), outcome: "failed" });
      setMessage("Extra settings could not be read for this channel.");
      log.reportActionError("Channel extra settings", error);
      return;
    }
    // A response for a row the user has since closed or navigated away from has
    // nowhere to render.
    if (token !== openToken || editedRow !== row) {
      return;
    }
    if (!payload?.available) {
      trackEvent("channel_extra_opened", { ...radioEventParams(radio), outcome: "unavailable" });
      setMessage(payload?.message || "This channel has no extra settings.");
      return;
    }
    setMessage("");
    renderFields(payload.fields || [], rowExtras(row) || {});
    dom.channelExtraSaveEl.disabled = false;
    trackEvent("channel_extra_opened", { ...radioEventParams(radio), outcome: "ok" });
  }

  // Write the edited values onto the row. Immutable fields are left out: the
  // schema was read from the memory this row's Location points at, and a value
  // the driver will not accept anyway is not this channel's to carry.
  function save() {
    const row = editedRow;
    if (!row) {
      return;
    }
    const values = {};
    let invalid = 0;
    for (const entry of fieldControls) {
      const { value, error } = readControl(entry.field, entry.control);
      entry.setError(error);
      if (error) {
        invalid += 1;
        continue;
      }
      if (entry.field.mutable === false) {
        continue;
      }
      values[entry.field.name] = value;
    }
    if (invalid > 0) {
      setMessage(`Fix ${invalid} highlighted value${invalid === 1 ? "" : "s"} before saving.`);
      return;
    }
    setRowExtras(row, values);
    const location = String(row.Location ?? "").trim();
    setModalOpen(false);
    // No re-render: the grid shows the same button whatever a row carries, and
    // the Extra column is already up (nothing else could have opened this).
    trackEvent("channel_extra_saved", radioEventParams(state.selectedRadio));
    log.setStatus(
      `Extra settings updated for channel ${location || "?"}; they are written on upload or export.`,
    );
  }

  function bindEvents() {
    dom.channelExtraCancelEl.addEventListener("click", () => {
      setModalOpen(false);
    });
    dom.channelExtraModalEl.addEventListener("click", (event) => {
      if (event.target === dom.channelExtraModalEl) {
        setModalOpen(false);
      }
    });
    dom.channelExtraFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      save();
    });
  }

  return { bindEvents, isModalOpen, closeModal, openForRow };
}

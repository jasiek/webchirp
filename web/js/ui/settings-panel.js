import { errorSummary } from "./format.js";
import { radioEventParams, trackEvent } from "./analytics.js";
import { isStaleRadioLoad, nextRadioLoadToken, requireRuntimeApi } from "./state.js";

// Radio-wide settings: the tabbed editor, its per-value validation, and the
// load/merge path from the Python runtime. Owns the settings tree and the
// invalid-value bookkeeping; other modules reach it through the returned API.
export function createSettingsPanel({ dom, state, log, actions }) {
  let settingsState = {
    supported: false,
    available: false,
    requiresImage: false,
    message: "",
    groups: [],
  };
  let activeTab = "";
  const invalidKeys = new Set();
  const invalidMessages = new Map();

  function cloneGroups(groups) {
    return JSON.parse(JSON.stringify(Array.isArray(groups) ? groups : []));
  }

  function settingKey(path, valueIndex = 0) {
    return `${(Array.isArray(path) ? path : []).join("/")}:${Number(valueIndex)}`;
  }

  function clearInvalid() {
    invalidKeys.clear();
    invalidMessages.clear();
  }

  function clearInvalidSetting(path, valueIndex = 0) {
    const key = settingKey(path, valueIndex);
    invalidKeys.delete(key);
    invalidMessages.delete(key);
  }

  function radioHasSettings() {
    return Boolean(
      settingsState?.available &&
      Array.isArray(settingsState.groups) &&
      settingsState.groups.length > 0,
    );
  }

  function hasInvalidSettings() {
    return invalidKeys.size > 0;
  }

  function settingsUnavailableMessage() {
    return settingsState?.message || "This radio does not expose radio-wide settings.";
  }

  function updateViewButtons() {
    dom.viewSettingsEl.disabled = !radioHasSettings();
    dom.viewSettingsEl.title = radioHasSettings()
      ? "Edit radio-wide settings"
      : (settingsState?.message || "This radio does not expose radio-wide settings");
  }

  function updateSummary() {
    const count = invalidKeys.size;
    dom.settingsSummaryEl.hidden = !radioHasSettings();
    dom.settingsSummaryEl.classList.toggle("has-invalid", count > 0);
    if (!radioHasSettings()) {
      dom.settingsSummaryEl.textContent = "";
      return;
    }
    dom.settingsSummaryEl.textContent = count > 0
      ? `Radio settings have ${count} invalid value${count === 1 ? "" : "s"}. Fix the highlighted fields before upload.`
      : "Radio settings are ready to write. Immutable values are shown but disabled.";
    actions.updateSerialActionState();
  }

  function flattenSettingsFields(groups) {
    const out = [];
    function walk(node) {
      if (!node) {
        return;
      }
      if (node.kind === "setting") {
        const values = Array.isArray(node.values) ? node.values : [];
        values.forEach((value, valueIndex) => {
          out.push({
            path: node.path || [],
            valueIndex,
            current: value.current,
            valueRef: value,
          });
        });
        return;
      }
      (node.children || []).forEach(walk);
    }
    (groups || []).forEach(walk);
    return out;
  }

  function normalizeRadioSettingValue(meta, rawValue, previousValue) {
    const type = String(meta?.type || "");
    if (meta?.mutable === false) {
      return { value: previousValue, error: "" };
    }

    if (type === "boolean") {
      return { value: Boolean(rawValue), error: "" };
    }

    if (type === "enum") {
      const options = Array.isArray(meta?.options) ? meta.options.map(String) : [];
      const candidate = String(rawValue ?? "");
      if (options.length > 0 && !options.includes(candidate)) {
        return { value: previousValue, error: "Select one of the supported values." };
      }
      return { value: candidate, error: "" };
    }

    if (type === "integer") {
      const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
      if (!Number.isInteger(parsed)) {
        return { value: rawValue, error: "Enter an integer." };
      }
      if (Number.isFinite(meta.min) && parsed < Number(meta.min)) {
        return { value: parsed, error: `Value must be at least ${meta.min}.` };
      }
      if (Number.isFinite(meta.max) && parsed > Number(meta.max)) {
        return { value: parsed, error: `Value must be at most ${meta.max}.` };
      }
      if (Number.isFinite(meta.step) && Number(meta.step) > 1) {
        const base = Number.isFinite(meta.min) ? Number(meta.min) : 0;
        if ((parsed - base) % Number(meta.step) !== 0) {
          return { value: parsed, error: `Value must increment by ${meta.step}.` };
        }
      }
      return { value: parsed, error: "" };
    }

    if (type === "float") {
      const parsed = Number.parseFloat(String(rawValue ?? "").trim());
      if (!Number.isFinite(parsed)) {
        return { value: rawValue, error: "Enter a number." };
      }
      if (Number.isFinite(meta.min) && parsed < Number(meta.min)) {
        return { value: parsed, error: `Value must be at least ${meta.min}.` };
      }
      if (Number.isFinite(meta.max) && parsed > Number(meta.max)) {
        return { value: parsed, error: `Value must be at most ${meta.max}.` };
      }
      return { value: parsed, error: "" };
    }

    if (type === "string") {
      const text = String(rawValue ?? "");
      if (Number.isFinite(meta.minLength) && text.length < Number(meta.minLength)) {
        return { value: text, error: `Value must be at least ${meta.minLength} characters.` };
      }
      if (Number.isFinite(meta.maxLength) && text.length > Number(meta.maxLength)) {
        return { value: text, error: `Value must be at most ${meta.maxLength} characters.` };
      }
      if (meta.charset) {
        const allowed = new Set(String(meta.charset).split(""));
        const invalidChar = text.split("").find((ch) => !allowed.has(ch));
        if (invalidChar) {
          return { value: text, error: `Character ${JSON.stringify(invalidChar)} is not allowed.` };
        }
      }
      return { value: text, error: "" };
    }

    return { value: rawValue, error: "" };
  }

  function setSettingValue(settingNode, valueIndex, rawValue) {
    const valueMeta = settingNode?.values?.[valueIndex];
    if (!valueMeta) {
      return;
    }
    const result = normalizeRadioSettingValue(valueMeta, rawValue, valueMeta.current);
    valueMeta.current = result.value;
    const key = settingKey(settingNode.path, valueIndex);
    if (result.error) {
      invalidKeys.add(key);
      invalidMessages.set(key, result.error);
    } else {
      clearInvalidSetting(settingNode.path, valueIndex);
    }
    updateSummary();
    render();
  }

  function findSettingsTabNode(tabId) {
    return settingsState.groups.find((group) => group.id === tabId) || null;
  }

  function tabHasInvalidSettings(group) {
    if (!group) {
      return false;
    }
    return flattenSettingsFields([group]).some((field) =>
      invalidKeys.has(settingKey(field.path, field.valueIndex)));
  }

  function renderSettingControl(settingNode, valueMeta, valueIndex) {
    const wrapper = document.createElement("div");
    wrapper.className = "settings-field-control";
    const key = settingKey(settingNode.path, valueIndex);
    const immutable = settingNode.mutable === false || valueMeta.mutable === false;
    const errorText = invalidMessages.get(key) || "";
    wrapper.classList.toggle("is-invalid", Boolean(errorText));
    wrapper.classList.toggle("is-immutable", immutable);

    const current = valueMeta.current;
    let control;
    if (valueMeta.type === "boolean") {
      control = document.createElement("input");
      control.type = "checkbox";
      control.checked = Boolean(current);
      control.disabled = immutable;
      control.addEventListener("change", () => {
        setSettingValue(settingNode, valueIndex, control.checked);
      });
    } else if (valueMeta.type === "enum") {
      control = document.createElement("select");
      const options = Array.isArray(valueMeta.options) ? valueMeta.options : [];
      options.forEach((option) => {
        const optionEl = document.createElement("option");
        optionEl.value = String(option);
        optionEl.textContent = String(option);
        control.appendChild(optionEl);
      });
      control.value = String(current ?? "");
      control.disabled = immutable;
      control.addEventListener("change", () => {
        setSettingValue(settingNode, valueIndex, control.value);
      });
    } else {
      control = document.createElement("input");
      control.type = valueMeta.type === "integer" || valueMeta.type === "float" ? "number" : "text";
      if (valueMeta.type === "integer" || valueMeta.type === "float") {
        if (Number.isFinite(valueMeta.min)) {
          control.min = String(valueMeta.min);
        }
        if (Number.isFinite(valueMeta.max)) {
          control.max = String(valueMeta.max);
        }
        if (Number.isFinite(valueMeta.step)) {
          control.step = String(valueMeta.step);
        } else if (valueMeta.type === "float") {
          control.step = "any";
        }
      }
      if (Number.isFinite(valueMeta.maxLength)) {
        control.maxLength = Number(valueMeta.maxLength);
      }
      control.value = current ?? "";
      control.readOnly = immutable;
      control.disabled = immutable;
      control.addEventListener("change", () => {
        setSettingValue(settingNode, valueIndex, control.value);
      });
    }

    wrapper.appendChild(control);

    if (settingNode.warning) {
      const warningEl = document.createElement("div");
      warningEl.className = "settings-field-warning";
      warningEl.textContent = settingNode.warning;
      wrapper.appendChild(warningEl);
    }
    if (errorText) {
      const errorEl = document.createElement("div");
      errorEl.className = "settings-field-error";
      errorEl.textContent = errorText;
      wrapper.appendChild(errorEl);
    }
    return wrapper;
  }

  function renderSettingNode(parentEl, node) {
    if (node.kind === "group") {
      const section = document.createElement("section");
      section.className = node.path?.length > 1 ? "settings-subgroup" : "settings-group";
      const heading = document.createElement(node.path?.length > 1 ? "h4" : "h3");
      heading.textContent = node.label || node.id;
      section.appendChild(heading);
      (node.children || []).forEach((child) => renderSettingNode(section, child));
      parentEl.appendChild(section);
      return;
    }

    const fields = document.createElement("div");
    fields.className = "settings-fields";
    const values = Array.isArray(node.values) ? node.values : [];
    values.forEach((valueMeta, valueIndex) => {
      const labelEl = document.createElement("div");
      labelEl.className = "settings-field-label";
      const labelStrong = document.createElement("strong");
      labelStrong.textContent = values.length > 1 ? `${node.label} ${valueIndex + 1}` : node.label;
      labelEl.appendChild(labelStrong);
      if (node.doc) {
        const docEl = document.createElement("div");
        docEl.className = "settings-field-doc";
        docEl.textContent = node.doc;
        labelEl.appendChild(docEl);
      }
      if (node.volatile) {
        const volatileEl = document.createElement("div");
        volatileEl.className = "settings-field-doc";
        volatileEl.textContent = "Volatile setting";
        labelEl.appendChild(volatileEl);
      }
      fields.appendChild(labelEl);
      fields.appendChild(renderSettingControl(node, valueMeta, valueIndex));
    });
    parentEl.appendChild(fields);
  }

  function render() {
    updateSummary();
    updateViewButtons();
    if (!dom.settingsTabsEl || !dom.settingsContentEl || !dom.settingsEmptyEl) {
      return;
    }

    dom.settingsTabsEl.innerHTML = "";
    dom.settingsContentEl.innerHTML = "";
    dom.settingsEmptyEl.textContent = settingsUnavailableMessage();

    if (!radioHasSettings()) {
      dom.settingsEmptyEl.hidden = false;
      dom.settingsContentEl.hidden = true;
      return;
    }

    dom.settingsEmptyEl.hidden = true;
    dom.settingsContentEl.hidden = false;

    const activeGroup = findSettingsTabNode(activeTab) || settingsState.groups[0];
    if (!activeGroup) {
      dom.settingsEmptyEl.hidden = false;
      dom.settingsContentEl.hidden = true;
      return;
    }
    activeTab = activeGroup.id;

    settingsState.groups.forEach((group) => {
      const tabButton = document.createElement("button");
      tabButton.type = "button";
      tabButton.className = "settings-tab";
      tabButton.textContent = group.label || group.id;
      tabButton.classList.toggle("is-active", group.id === activeTab);
      tabButton.classList.toggle("has-invalid", tabHasInvalidSettings(group));
      tabButton.addEventListener("click", () => {
        // Group ids come from the driver's own settings tree, so this says
        // which parts of a radio's configuration people actually go looking
        // for. Only the group id travels, never a setting value.
        trackEvent("settings_tab_opened", {
          ...radioEventParams(state.selectedRadio),
          tab: String(group.id || ""),
        });
        activeTab = group.id;
        render();
      });
      dom.settingsTabsEl.appendChild(tabButton);
    });
    renderSettingNode(dom.settingsContentEl, activeGroup);
  }

  // Keep the active tab pointing at a group that still exists.
  function ensureActiveTab() {
    if (!activeTab || !settingsState.groups.some((group) => group.id === activeTab)) {
      activeTab = settingsState.groups[0]?.id || "";
    }
  }

  async function load(options = {}) {
    const loadToken = options.loadToken ?? nextRadioLoadToken(state);
    if (!state.selectedRadio) {
      settingsState = {
        supported: false,
        available: false,
        requiresImage: false,
        message: "",
        groups: [],
      };
      clearInvalid();
      updateViewButtons();
      render();
      return;
    }
    const preserveCurrent = Boolean(options.preserveCurrent);
    let nextState = {
      supported: false,
      available: false,
      requiresImage: false,
      message: "",
      groups: [],
    };
    try {
      const result = await requireRuntimeApi(state).getRadioSettings({
        module: state.selectedRadio.module,
        className: state.selectedRadio.className,
      });
      nextState = {
        supported: Boolean(result?.supported),
        available: Boolean(result?.available),
        requiresImage: Boolean(result?.requiresImage),
        message: String(result?.message || ""),
        groups: cloneGroups(result?.groups || []),
      };
    } catch (error) {
      log.logError(`SETTINGS LOAD FALLBACK ${errorSummary(error)}`);
      nextState.message = "Radio-wide settings could not be prepared.";
    }

    if (isStaleRadioLoad(state, loadToken)) {
      return;
    }

    if (preserveCurrent && radioHasSettings() && nextState.supported) {
      const currentByKey = new Map();
      for (const field of flattenSettingsFields(settingsState.groups)) {
        currentByKey.set(settingKey(field.path, field.valueIndex), field.current);
      }
      for (const field of flattenSettingsFields(nextState.groups)) {
        const key = settingKey(field.path, field.valueIndex);
        if (currentByKey.has(key)) {
          field.valueRef.current = currentByKey.get(key);
        }
      }
    }

    settingsState = nextState;
    clearInvalid();
    if (!radioHasSettings() && state.currentEditorView === "settings") {
      actions.setEditorView("channels");
    }
    ensureActiveTab();
    updateViewButtons();
    render();
  }

  // Record per-setting issues reported by the upload preflight so the affected
  // fields and their tabs render as invalid.
  function applyValidationIssues(issues) {
    (issues || []).forEach((issue) => {
      const path = Array.isArray(issue?.path) ? issue.path : [];
      const valueIndex = Number(issue?.valueIndex || 0);
      const key = settingKey(path, valueIndex);
      invalidKeys.add(key);
      invalidMessages.set(key, String(issue?.message || "Invalid value"));
      log.logDebug(
        `PREFLIGHT INVALID setting=${path.join(".") || "<unknown>"} value=${valueIndex}: ${issue?.message || "Invalid value"}`,
      );
    });
  }

  return {
    cloneGroups,
    render,
    load,
    updateViewButtons,
    updateSummary,
    radioHasSettings,
    hasInvalidSettings,
    settingsUnavailableMessage,
    clearInvalid,
    ensureActiveTab,
    applyValidationIssues,
    invalidCount: () => invalidKeys.size,
    getGroups: () => settingsState.groups,
    // Replace the settings tree, falling back to the current groups when the
    // runtime returns nothing (upload/export echo the settings back).
    setGroups(groups) {
      settingsState.groups = cloneGroups(groups || settingsState.groups);
    },
    // Wholesale replacement after a download or image load, where the settings
    // come from the image rather than a driver probe.
    replaceState(nextState) {
      settingsState = nextState;
      activeTab = settingsState.groups[0]?.id || "";
    },
  };
}

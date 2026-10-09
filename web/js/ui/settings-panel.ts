import { errorSummary } from "./format.ts";
import { radioEventParams, trackEvent } from "./analytics.ts";
import { normalizeSettingValue } from "./setting-values.ts";
import { requireRuntimeApi } from "./state.ts";
import type { UiContext } from "../types/ui-context.js";
import type { SettingValueMeta } from "./setting-fields.ts";
import type { SettingIssue, SettingLeafNode, SettingNode } from "../runtime-rpc.ts";
import type { RadioSessionHandle } from "./state.ts";

/**
 * One value of one setting, flattened out of the settings tree: where it is
 * (the setting's path and the value's index in it) and the tree's own value
 * object, which a merge writes current back into.
 */
/** The settings tree the panel shows, and whether there is one. */
interface SettingsState {
  supported: boolean;
  available: boolean;
  requiresImage: boolean;
  message: string;
  groups: SettingNode[];
}

interface FlatSettingField {
  path: unknown[];
  valueIndex: number;
  current: unknown;
  valueRef: SettingValueMeta;
}

// Radio-wide settings: the tabbed editor, its per-value validation, and the
// load/merge path from the Python runtime. Owns the settings tree and the
// invalid-value bookkeeping; other modules reach it through the returned API.
export function createSettingsPanel(ctx: UiContext) {
  const { dom, state, log, actions } = ctx;
  let settingsState: SettingsState = {
    supported: false,
    available: false,
    requiresImage: false,
    message: "",
    groups: [],
  };
  let activeTab = "";
  const invalidKeys = new Set<string>();
  const invalidMessages = new Map<string, string>();

  // A deep copy, through JSON: the tree is plain data the runtime produced.
  function cloneGroups(groups: readonly SettingNode[] | null | undefined): SettingNode[] {
    return JSON.parse(JSON.stringify(Array.isArray(groups) ? groups : []));
  }

  function settingKey(path: readonly unknown[] | null | undefined, valueIndex = 0): string {
    return `${(Array.isArray(path) ? path : []).join("/")}:${Number(valueIndex)}`;
  }

  function clearInvalid() {
    invalidKeys.clear();
    invalidMessages.clear();
  }

  function clearInvalidSetting(path: readonly unknown[], valueIndex = 0): void {
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

  function flattenSettingsFields(groups: readonly SettingNode[] | null | undefined): FlatSettingField[] {
    const out: FlatSettingField[] = [];
    function walk(node: SettingNode | null | undefined) {
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

  function setSettingValue(settingNode: SettingLeafNode, valueIndex: number, rawValue: unknown): void {
    const valueMeta = settingNode?.values?.[valueIndex];
    if (!valueMeta) {
      return;
    }
    const result = normalizeSettingValue(valueMeta, rawValue, valueMeta.current);
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

  function findSettingsTabNode(tabId: string): SettingNode | null {
    return settingsState.groups.find((group) => group.id === tabId) || null;
  }

  function tabHasInvalidSettings(group: SettingNode | null): boolean {
    if (!group) {
      return false;
    }
    return flattenSettingsFields([group]).some((field) =>
      invalidKeys.has(settingKey(field.path, field.valueIndex)));
  }

  function renderSettingControl(settingNode: SettingLeafNode, valueMeta: SettingValueMeta, valueIndex: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "settings-field-control";
    const key = settingKey(settingNode.path, valueIndex);
    const immutable = settingNode.mutable === false || valueMeta.mutable === false;
    const errorText = invalidMessages.get(key) || "";
    wrapper.classList.toggle("is-invalid", Boolean(errorText));
    wrapper.classList.toggle("is-immutable", immutable);

    const current = valueMeta.current;
    let control: HTMLInputElement | HTMLSelectElement;
    if (valueMeta.type === "boolean") {
      const checkbox = document.createElement("input");
      control = checkbox;
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(current);
      checkbox.disabled = immutable;
      checkbox.addEventListener("change", () => {
        setSettingValue(settingNode, valueIndex, checkbox.checked);
      });
    } else if (valueMeta.type === "enum") {
      const select = document.createElement("select");
      control = select;
      const options = Array.isArray(valueMeta.options) ? valueMeta.options : [];
      options.forEach((option) => {
        const optionEl = document.createElement("option");
        optionEl.value = String(option);
        optionEl.textContent = String(option);
        select.appendChild(optionEl);
      });
      select.value = String(current ?? "");
      select.disabled = immutable;
      select.addEventListener("change", () => {
        setSettingValue(settingNode, valueIndex, select.value);
      });
    } else {
      const input = document.createElement("input");
      control = input;
      input.type = valueMeta.type === "integer" || valueMeta.type === "float" ? "number" : "text";
      if (valueMeta.type === "integer" || valueMeta.type === "float") {
        if (Number.isFinite(valueMeta.min)) {
          input.min = String(valueMeta.min);
        }
        if (Number.isFinite(valueMeta.max)) {
          input.max = String(valueMeta.max);
        }
        if (Number.isFinite(valueMeta.step)) {
          input.step = String(valueMeta.step);
        } else if (valueMeta.type === "float") {
          input.step = "any";
        }
      }
      if (Number.isFinite(valueMeta.maxLength)) {
        input.maxLength = Number(valueMeta.maxLength);
      }
      input.value = String(current ?? "");
      input.readOnly = immutable;
      input.disabled = immutable;
      input.addEventListener("change", () => {
        setSettingValue(settingNode, valueIndex, input.value);
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

  function renderSettingNode(parentEl: HTMLElement, node: SettingNode): void {
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

  // The settings state for a session's radio, or the empty state for none. A
  // runtime failure becomes an "unavailable" state rather than a throw, so a
  // driver whose settings cannot be built still loads its channel schema.
  async function fetchForSession(session: RadioSessionHandle | null): Promise<SettingsState> {
    if (!session) {
      return {
        supported: false,
        available: false,
        requiresImage: false,
        message: "",
        groups: [],
      };
    }
    let nextState: SettingsState = {
      supported: false,
      available: false,
      requiresImage: false,
      message: "",
      groups: [],
    };
    try {
      const sessionId = await ctx.session.idOf(session);
      const result = await requireRuntimeApi(state).getRadioSettings({ sessionId });
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
    return nextState;
  }

  function applyLoadedState(nextState: SettingsState, options: { preserveCurrent?: boolean } = {}) {
    const preserveCurrent = Boolean(options.preserveCurrent);
    if (preserveCurrent && radioHasSettings() && nextState.supported) {
      const currentByKey = new Map<string, unknown>();
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

  // Load the selected radio's settings, applied only if its session is still
  // the current one when the runtime answers.
  async function load(options: { preserveCurrent?: boolean } = {}) {
    const session = ctx.session.current();
    const nextState = await fetchForSession(session);
    if (!ctx.session.isCurrent(session)) {
      return;
    }
    applyLoadedState(nextState, options);
  }

  // Record per-setting issues reported by the upload preflight so the affected
  // fields and their tabs render as invalid.
  function applyValidationIssues(issues: readonly SettingIssue[] | null | undefined): void {
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
    fetchForSession,
    applyLoadedState,
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
    setGroups(groups: SettingNode[] | null | undefined) {
      settingsState.groups = cloneGroups(groups || settingsState.groups);
    },
    // Wholesale replacement after a download or image load, where the settings
    // come from the image rather than a driver probe.
    replaceState(nextState: SettingsState) {
      settingsState = nextState;
      activeTab = settingsState.groups[0]?.id || "";
    },
  };
}

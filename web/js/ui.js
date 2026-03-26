import {
  buildGmrsRows,
  buildFrsRows,
  PRZEMIENNIKI_API_URL,
  PRZEMIENNIKI_META_URL,
  REPEATERBOOK_API_URL,
  REPEATERBOOK_META_URL,
  buildPmr446Rows,
  buildPrzemiennikiRows,
  parsePrzemiennikiMetaJson,
  parsePrzemiennikiXml,
} from "./datasources.js";

const DEFAULT_SAMPLE_CSV = `Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment\n0,Simplex1,146.520000,,0.600000,,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,National Calling\n1,RepeaterA,146.940000,-,0.600000,TSQL,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,Local repeater\n`;
const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";
const LAST_RADIO_COOKIE = "webchirp_last_radio";

// Create and manage all DOM/UI state and user interaction behavior.
export function createUiController() {
  const tableHead = document.querySelector("#mem-table thead");
  const tableBody = document.querySelector("#mem-table tbody");
  const channelEditorEl = document.querySelector("#channel-editor");
  const settingsEditorEl = document.querySelector("#settings-editor");
  const viewChannelsEl = document.querySelector("#view-channels");
  const viewSettingsEl = document.querySelector("#view-settings");
  const settingsTabsEl = document.querySelector("#settings-tabs");
  const settingsSummaryEl = document.querySelector("#settings-summary");
  const settingsEmptyEl = document.querySelector("#settings-empty");
  const settingsContentEl = document.querySelector("#settings-content");
  const fileInput = document.querySelector("#csv-file");
  const imgFileInput = document.querySelector("#img-file");
  const debugOutputEl = document.querySelector("#debug-output");
  const reportIssueEl = document.querySelector("#report-issue");
  const serialSupportWarningEl = document.querySelector("#webserial-support-warning");
  const liveRadioSupportWarningEl = document.querySelector("#live-radio-support-warning");
  const radioMakeEl = document.querySelector("#radio-make");
  const radioModelEl = document.querySelector("#radio-model");
  const serialConnectToggleEl = document.querySelector("#serial-connect-toggle");
  const radioDownloadEl = document.querySelector("#radio-download");
  const radioUploadEl = document.querySelector("#radio-upload");
  const channelInsertEl = document.querySelector("#channel-insert");
  const channelRemoveEl = document.querySelector("#channel-remove");
  const channelMenuToggleEl = document.querySelector("#channel-menu-toggle");
  const channelMenuPopupEl = document.querySelector("#channel-menu-popup");
  const channelAddGmrsEl = document.querySelector("#channel-add-gmrs");
  const channelAddFrsEl = document.querySelector("#channel-add-frs");
  const channelAddPmr446El = document.querySelector("#channel-add-pmr446");
  const channelImportPrzemiennikiEl = document.querySelector("#channel-import-przemienniki");
  const channelImportRepeaterbookEl = document.querySelector("#channel-import-repeaterbook");
  const przemiennikiModalEl = document.querySelector("#przemienniki-modal");
  const przemiennikiFormEl = document.querySelector("#przemienniki-form");
  const przemiennikiModalTitleEl = document.querySelector("#przemienniki-modal-title");
  const przemiennikiCountryEl = document.querySelector("#przemienniki-country");
  const przemiennikiBandListEl = document.querySelector("#przemienniki-band-list");
  const przemiennikiModeListEl = document.querySelector("#przemienniki-mode-list");
  const przemiennikiOnlyWorkingEl = document.querySelector("#przemienniki-onlyworking");
  const przemiennikiLatitudeEl = document.querySelector("#przemienniki-latitude");
  const przemiennikiLongitudeEl = document.querySelector("#przemienniki-longitude");
  const przemiennikiRangeEl = document.querySelector("#przemienniki-range");
  const przemiennikiGeolocateEl = document.querySelector("#przemienniki-geolocate");
  const przemiennikiCancelEl = document.querySelector("#przemienniki-cancel");
  const sidebarControlEls = Array.from(
    document.querySelectorAll(".left-panel select, .left-panel button, .left-panel input"),
  );

  let runtimeApi = null;
  let currentHeaders = [];
  let currentRows = [];
  let radioCatalog = [];
  let selectedRadio = null;
  let radioMetadata = { headers: [], columns: {} };
  let radioSettingsState = { supported: false, available: false, requiresImage: false, message: "", groups: [] };
  let runtimeInfo = { chirpRevision: "" };
  let lastUsbVendorId = "";
  let lastUsbProductId = "";
  let lastErrorSummary = "";
  let currentEditorView = "channels";
  let activeSettingsTab = "";
  let selectedRowIndexes = new Set();
  let selectionAnchorIndex = null;
  let invalidCellKeys = new Set();
  let invalidSettingKeys = new Set();
  let invalidSettingMessages = new Map();
  let przemiennikiDictionaryPromise = null;
  let repeaterbookDictionaryPromise = null;
  let activeRepeaterQuerySource = "przemienniki";
  let sidebarControlsEnabled = false;
  let serialConnected = false;

  const repeaterQuerySources = {
    przemienniki: {
      key: "przemienniki",
      label: "przemienniki.net",
      actionLabel: "Przemienniki",
      insertLabel: "przemienniki",
      apiUrl: PRZEMIENNIKI_API_URL,
      metaUrl: PRZEMIENNIKI_META_URL,
      getDictionaryPromise: () => przemiennikiDictionaryPromise,
      setDictionaryPromise: (value) => {
        przemiennikiDictionaryPromise = value;
      },
    },
    repeaterbook: {
      key: "repeaterbook",
      label: "repeaterbook.com",
      actionLabel: "RepeaterBook",
      insertLabel: "repeaterbook",
      apiUrl: REPEATERBOOK_API_URL,
      metaUrl: REPEATERBOOK_META_URL,
      getDictionaryPromise: () => repeaterbookDictionaryPromise,
      setDictionaryPromise: (value) => {
        repeaterbookDictionaryPromise = value;
      },
    },
  };

  if (!Object.getOwnPropertyDescriptor(globalThis, "currentRows")) {
    Object.defineProperty(globalThis, "currentRows", {
      configurable: true,
      get: () => currentRows,
    });
  }

  function setRuntimeApi(api) {
    runtimeApi = api;
  }

  function setSidebarControlsEnabled(enabled) {
    sidebarControlsEnabled = Boolean(enabled);
    for (const el of sidebarControlEls) {
      el.disabled = !enabled;
    }
    updateSerialActionState();
  }

  function setSerialSupportWarningVisible(visible) {
    if (!serialSupportWarningEl) {
      return;
    }
    serialSupportWarningEl.hidden = !visible;
  }

  function setLiveRadioSupportWarningVisible(visible) {
    if (!liveRadioSupportWarningEl) {
      return;
    }
    liveRadioSupportWarningEl.hidden = !visible;
  }

  function refreshSerialConnectToggleLabel() {
    if (!serialConnectToggleEl) {
      return;
    }
    serialConnectToggleEl.textContent = serialConnected ? "Disconnect" : "Connect";
  }

  function setCookie(name, value, maxAgeSeconds = 31536000) {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  function getCookie(name) {
    const prefix = `${name}=`;
    const parts = String(document.cookie || "").split(";").map((v) => v.trim());
    for (const part of parts) {
      if (part.startsWith(prefix)) {
        return decodeURIComponent(part.slice(prefix.length));
      }
    }
    return "";
  }

  function persistSelectedRadioCookie() {
    if (!selectedRadio) {
      return;
    }
    const value = JSON.stringify({
      make: selectedRadio.vendor,
      key: selectedRadio.key,
    });
    setCookie(LAST_RADIO_COOKIE, value);
  }

  function restoreSelectedRadioCookie() {
    const raw = getCookie(LAST_RADIO_COOKIE);
    if (!raw) {
      return false;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    const make = String(parsed?.make || "");
    const key = String(parsed?.key || "");
    if (!make || !key) {
      return false;
    }
    if (!radioCatalog.some((r) => r.vendor === make && r.key === key)) {
      return false;
    }
    radioMakeEl.value = make;
    refreshModelOptions();
    radioModelEl.value = key;
    selectedRadio = radioCatalog.find((r) => r.key === key) || null;
    if (!selectedRadio) {
      return false;
    }
    updateSerialActionState();
    logDebug(
      `RADIO RESTORE ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
    );
    return true;
  }

  function sortedSelectedRowIndexes() {
    return Array.from(selectedRowIndexes)
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < currentRows.length)
      .sort((a, b) => a - b);
  }

  function selectedRowsForOperations() {
    const indexes = sortedSelectedRowIndexes();
    if (indexes.length === 0) {
      return currentRows;
    }
    return indexes.map((idx) => currentRows[idx]).filter(Boolean);
  }

  function resetRowSelection() {
    selectedRowIndexes.clear();
    selectionAnchorIndex = null;
  }

  function invalidCellKey(rowIdx, column) {
    return `${Number(rowIdx)}:${String(column || "")}`;
  }

  function cloneSettingsGroups(groups) {
    return JSON.parse(JSON.stringify(Array.isArray(groups) ? groups : []));
  }

  function settingKey(path, valueIndex = 0) {
    return `${(Array.isArray(path) ? path : []).join("/")}:${Number(valueIndex)}`;
  }

  function clearInvalidHighlights() {
    invalidCellKeys.clear();
  }

  function clearInvalidSettings() {
    invalidSettingKeys.clear();
    invalidSettingMessages.clear();
  }

  function clearInvalidCell(rowIdx, column) {
    const key = invalidCellKey(rowIdx, column);
    if (!invalidCellKeys.has(key)) {
      return;
    }
    invalidCellKeys.delete(key);
    const td = tableBody.querySelector(
      `td[data-row-idx="${Number(rowIdx)}"][data-column="${CSS.escape(String(column || ""))}"]`,
    );
    td?.classList.remove("is-invalid");
  }

  function clearInvalidSetting(path, valueIndex = 0) {
    const key = settingKey(path, valueIndex);
    invalidSettingKeys.delete(key);
    invalidSettingMessages.delete(key);
  }

  function applyRowSelectionVisuals() {
    const selected = selectedRowIndexes;
    const rows = tableBody.querySelectorAll("tr");
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
    const end = Math.min(currentRows.length - 1, Math.max(fromIdx, toIdx));
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

  function requireRuntimeApi() {
    if (!runtimeApi) {
      throw new Error("Runtime API client is not initialized");
    }
    return runtimeApi;
  }

  // Emit status updates into the debug output stream.
  function setStatus(text) {
    logDebug(`STATUS ${text}`);
  }

  function currentViewLabel() {
    return currentEditorView === "settings" ? "radio settings" : "channels";
  }

  function captureErrorSummary(line) {
    const text = String(line || "");
    if (!/\b(error|traceback|exception)\b/i.test(text)) {
      return;
    }
    lastErrorSummary = text.replace(/\s+/g, " ").trim().slice(0, 180);
  }

  // Record serial-related events in the central debug output stream.
  function logSerial(line) {
    logDebug(`SERIAL ${String(line || "")}`);
  }

  // Append a timestamped line to the bottom debug console panel.
  function logDebug(line) {
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${String(line || "")}`;
    const current = debugOutputEl.value ? `${debugOutputEl.value}\n` : "";
    debugOutputEl.value = `${current}${text}`;
    debugOutputEl.scrollTop = debugOutputEl.scrollHeight;
    captureErrorSummary(line);
  }

  function detectOperatingSystem() {
    const ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) {
      return "Windows";
    }
    if (/Macintosh|Mac OS X/i.test(ua)) {
      return "macOS";
    }
    if (/Linux|X11/i.test(ua)) {
      return "Linux";
    }
    return "Other";
  }

  function detectBrowserVersion() {
    const ua = navigator.userAgent || "";
    const matchers = [
      [/Edg\/([\d.]+)/, "Microsoft Edge"],
      [/OPR\/([\d.]+)/, "Opera"],
      [/Firefox\/([\d.]+)/, "Firefox"],
      [/Chrome\/([\d.]+)/, "Chrome"],
      [/Version\/([\d.]+).*Safari/, "Safari"],
    ];
    for (const [regex, name] of matchers) {
      const match = ua.match(regex);
      if (match?.[1]) {
        return `${name} ${match[1]}`;
      }
    }
    return navigator.appVersion || "Unknown browser";
  }

  function latestDebugTail(lineCount) {
    const lines = String(debugOutputEl.value || "")
      .split("\n")
      .filter(Boolean);
    if (lines.length <= lineCount) {
      return lines.join("\n");
    }
    return lines.slice(lines.length - lineCount).join("\n");
  }

  function buildIssueUrl() {
    const radioMake = selectedRadio?.vendor || radioMakeEl.value || "Not selected";
    const radioModel = selectedRadio?.model || radioModelEl.value || "Not selected";
    const bugSummary = lastErrorSummary || "manual report";
    const issueTitle = `Bug report: ${radioMake} ${radioModel} - ${bugSummary}`;
    const debugTail = latestDebugTail(120);
    const steps = [
      "1. Open WebCHIRP",
      "2. Select a radio make/model if relevant",
      "3. Perform the action that shows the bug",
      "4. Describe what happened",
    ].join("\n");
    const actualBehavior = [
      lastErrorSummary || "Manual report with no captured runtime error yet.",
      "",
      "Debug output excerpt:",
      "```",
      debugTail || "<no debug logs captured>",
      "```",
    ].join("\n");

    const params = new URLSearchParams({
      template: ISSUE_TEMPLATE_NAME,
      title: issueTitle.slice(0, 240),
      radio_make: radioMake,
      radio_model: radioModel,
      usb_vendor_id: lastUsbVendorId || "Unknown / not connected",
      usb_product_id: lastUsbProductId || "Unknown / not connected",
      operating_system: detectOperatingSystem(),
      browser_and_version: detectBrowserVersion(),
      chirp_revision: runtimeInfo.chirpRevision || "unknown",
      steps_to_reproduce: steps,
      expected_behavior: "The reported action should work without the observed bug.",
      actual_behavior: actualBehavior,
    });
    return `${ISSUE_NEW_URL}?${params.toString()}`;
  }

  function openPrefilledIssue() {
    const url = buildIssueUrl();
    window.open(url, "_blank", "noopener,noreferrer");
    logDebug("Opened pre-filled GitHub issue form.");
  }

  // Normalize unknown error shapes into a detailed string for diagnostics.
  function errorDetails(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error === "string") {
      return error;
    }
    if (typeof error.stack === "string" && error.stack.length > 0) {
      return error.stack;
    }
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  // Extract a short first-line summary from a detailed error payload.
  function errorSummary(error) {
    const firstLine = errorDetails(error).split("\n")[0].trim();
    return firstLine || "Unknown error";
  }

  // Centralized UI + debug handling for action-level failures.
  function reportActionError(action, error) {
    const details = errorDetails(error);
    logDebug(`${action.toUpperCase()} ERROR\n${details}`);
    setStatus(`${action} failed (see Debug Output).`);
  }

  function setEditorView(nextView) {
    currentEditorView = nextView === "settings" ? "settings" : "channels";
    const channelsActive = currentEditorView === "channels";
    channelEditorEl?.classList.toggle("is-active", channelsActive);
    settingsEditorEl?.classList.toggle("is-active", !channelsActive);
    if (channelEditorEl) {
      channelEditorEl.hidden = !channelsActive;
    }
    if (settingsEditorEl) {
      settingsEditorEl.hidden = channelsActive;
    }
    viewChannelsEl?.classList.toggle("is-active", channelsActive);
    viewSettingsEl?.classList.toggle("is-active", !channelsActive);
    viewChannelsEl?.setAttribute("aria-selected", channelsActive ? "true" : "false");
    viewSettingsEl?.setAttribute("aria-selected", channelsActive ? "false" : "true");
  }

  function radioHasSettings() {
    return Boolean(
      radioSettingsState?.available &&
      Array.isArray(radioSettingsState.groups) &&
      radioSettingsState.groups.length > 0,
    );
  }

  function updateViewButtons() {
    if (viewSettingsEl) {
      viewSettingsEl.disabled = !radioHasSettings();
      viewSettingsEl.title = radioHasSettings()
        ? "Edit radio-wide settings"
        : (radioSettingsState?.message || "This radio does not expose radio-wide settings");
    }
  }

  function hasInvalidSettings() {
    return invalidSettingKeys.size > 0;
  }

  function selectedRadioIsLiveMode() {
    return Boolean(selectedRadio?.isLiveRadio);
  }

  function updateSerialActionState() {
    const liveRadioUnsupported = selectedRadioIsLiveMode();
    const actionsAllowed = sidebarControlsEnabled && !liveRadioUnsupported;

    setLiveRadioSupportWarningVisible(liveRadioUnsupported);

    if (serialConnectToggleEl) {
      serialConnectToggleEl.disabled = !actionsAllowed;
      serialConnectToggleEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : "";
    }

    if (radioDownloadEl) {
      radioDownloadEl.disabled = !actionsAllowed;
      radioDownloadEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : "";
    }

    if (!radioUploadEl) {
      return;
    }

    radioUploadEl.disabled = !actionsAllowed || hasInvalidSettings();
    if (liveRadioUnsupported) {
      radioUploadEl.title = "Live-mode radios are not supported in this UI yet";
      return;
    }
    radioUploadEl.title = hasInvalidSettings()
      ? "Fix invalid radio settings before upload"
      : "";
  }

  function updateSettingsSummary() {
    if (!settingsSummaryEl) {
      return;
    }
    const count = invalidSettingKeys.size;
    settingsSummaryEl.hidden = !radioHasSettings();
    settingsSummaryEl.classList.toggle("has-invalid", count > 0);
    if (!radioHasSettings()) {
      settingsSummaryEl.textContent = "";
      return;
    }
    settingsSummaryEl.textContent = count > 0
      ? `Radio settings have ${count} invalid value${count === 1 ? "" : "s"}. Fix the highlighted fields before upload.`
      : "Radio settings are ready to write. Immutable values are shown but disabled.";
    updateSerialActionState();
  }

  function settingsUnavailableMessage() {
    return radioSettingsState?.message || "This radio does not expose radio-wide settings.";
  }

  // Build a short user-facing label for a selected radio catalog entry.
  function makeModelLabel(radio) {
    return `${radio.vendor} ${radio.model}`;
  }

  function sanitizeFileNamePart(text) {
    return String(text || "")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "radio";
  }

  function nowStampForFileName() {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    const hh = pad2(now.getHours());
    const mm = pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    return `${y}${m}${d}_${hh}${mm}${ss}`;
  }

  function buildBinaryCodeplugFileName(vendor, model) {
    const vendorPart = sanitizeFileNamePart(vendor);
    const modelPart = sanitizeFileNamePart(model);
    return `${vendorPart}_${modelPart}_${nowStampForFileName()}.img`;
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let out = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      out += String.fromCharCode(...chunk);
    }
    return btoa(out);
  }

  // Produce a sorted unique list of vendor names from the radio catalog.
  function uniqueVendors(radios) {
    return Array.from(new Set(radios.map((r) => r.vendor))).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  function formatRadioModelOption(radio, hasDuplicateModel) {
    const modelLabel = radio.isLiveRadio ? `⚡ ${radio.model}` : radio.model;
    return hasDuplicateModel ? `${modelLabel} (${radio.className})` : modelLabel;
  }

  // Populate model dropdown for selected vendor and refresh selection state.
  function refreshModelOptions() {
    const vendor = radioMakeEl.value;
    const models = radioCatalog.filter((r) => r.vendor === vendor);
    const modelCounts = new Map();
    for (const radio of models) {
      modelCounts.set(radio.model, (modelCounts.get(radio.model) || 0) + 1);
    }
    radioModelEl.innerHTML = "";

    for (const radio of models) {
      const option = document.createElement("option");
      option.value = radio.key;
      const hasDuplicateModel = (modelCounts.get(radio.model) || 0) > 1;
      option.textContent = formatRadioModelOption(radio, hasDuplicateModel);
      radioModelEl.appendChild(option);
    }

    const selectedKey = radioModelEl.value || models[0]?.key;
    selectedRadio = models.find((r) => r.key === selectedKey) || null;
    updateSerialActionState();
    if (selectedRadio) {
      radioModelEl.value = selectedRadio.key;
      logDebug(
        `RADIO SELECT ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
      );
    }
  }

  function selectRadioByDriver(moduleName, className) {
    const target = radioCatalog.find(
      (r) => r.module === moduleName && r.className === className,
    );
    if (!target) {
      return false;
    }
    radioMakeEl.value = target.vendor;
    refreshModelOptions();
    radioModelEl.value = target.key;
    selectedRadio = target;
    persistSelectedRadioCookie();
    return true;
  }

  function selectRadioByDetectedImage(loaded) {
    if (selectRadioByDriver(loaded.module, loaded.className)) {
      return true;
    }
    const vendor = String(loaded.vendor || "");
    const model = String(loaded.model || "");
    const fallback = radioCatalog.find(
      (r) =>
        r.module === loaded.module
        && r.vendor === vendor
        && r.model === model,
    );
    if (!fallback) {
      return false;
    }
    radioMakeEl.value = fallback.vendor;
    refreshModelOptions();
    radioModelEl.value = fallback.key;
    selectedRadio = fallback;
    persistSelectedRadioCookie();
    return true;
  }

  // Populate make dropdown from catalog and initialize model options.
  function refreshMakeOptions() {
    const vendors = uniqueVendors(radioCatalog);
    radioMakeEl.innerHTML = "";
    for (const vendor of vendors) {
      const option = document.createElement("option");
      option.value = vendor;
      option.textContent = vendor;
      radioMakeEl.appendChild(option);
    }
    if (vendors.length > 0) {
      radioMakeEl.value = vendors[0];
    }
    refreshModelOptions();
  }

  // Parse CHIRP-style frequency text (MHz) to integer Hz for validation checks.
  function parseFreqToHz(value) {
    const text = String(value || "").trim();
    if (!text) {
      return 0;
    }
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return null;
    }
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n)) {
      return null;
    }
    return Math.round(n * 1_000_000);
  }

  // Check whether a frequency in Hz falls within any allowed CHIRP band range.
  function inAnyBand(hz, bands) {
    if (!Array.isArray(bands) || bands.length === 0) {
      return true;
    }
    return bands.some(([lo, hi]) => hz >= Number(lo) && hz < Number(hi));
  }

  // Coerce and constrain edited cell values according to CHIRP column metadata.
  function normalizeValue(column, value, meta, previous) {
    let v = String(value ?? "");
    if (!meta || meta.editable === false) {
      return String(previous ?? v);
    }

    if (meta.kind === "text") {
      if (meta.validChars) {
        const allowed = new Set(String(meta.validChars).split(""));
        v = v
          .split("")
          .filter((ch) => allowed.has(ch))
          .join("");
      }
      if (Number.isFinite(meta.maxLength)) {
        v = v.slice(0, Number(meta.maxLength));
      }
      return v;
    }

    if (meta.kind === "int") {
      const parsed = Number.parseInt(v, 10);
      if (Number.isNaN(parsed)) {
        return String(previous ?? "");
      }
      let out = parsed;
      if (Number.isFinite(meta.min)) {
        out = Math.max(out, Number(meta.min));
      }
      if (Number.isFinite(meta.max)) {
        out = Math.min(out, Number(meta.max));
      }
      return String(out);
    }

    if (meta.kind === "freq") {
      const hz = parseFreqToHz(v);
      if (hz === null) {
        return String(previous ?? "");
      }
      const shouldCheckBands = column !== "Offset";
      if (shouldCheckBands && !inAnyBand(hz, meta.bands || [])) {
        return String(previous ?? "");
      }
      return v;
    }

    if (meta.kind === "enum") {
      const options = Array.isArray(meta.options) ? meta.options.map(String) : [];
      if (options.length > 0 && !options.includes(v)) {
        return String(previous ?? options[0] ?? "");
      }
      return v;
    }

    return v;
  }

  function defaultValueForColumn(column) {
    if (column === "Location") {
      return "";
    }
    const meta = radioMetadata.columns?.[column] || {};
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      return String(meta.options[0]);
    }
    if (meta.kind === "int" && Number.isFinite(meta.min)) {
      return String(meta.min);
    }
    return "";
  }

  function reindexLocationColumn() {
    if (!currentHeaders.includes("Location")) {
      return;
    }
    currentRows.forEach((row, idx) => {
      row.Location = String(idx);
    });
  }

  function createBlankChannelRow() {
    const row = {};
    for (const column of currentHeaders) {
      row[column] = defaultValueForColumn(column);
    }
    return row;
  }

  function insertNewChannelRow() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }

    const selectedIndexes = sortedSelectedRowIndexes();
    const insertAt = selectedIndexes.length > 0 ? selectedIndexes[0] : currentRows.length;
    currentRows.splice(insertAt, 0, createBlankChannelRow());
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set([insertAt]);
    selectionAnchorIndex = insertAt;
    renderTable();
    setStatus(`Inserted new channel at channel ${insertAt}.`);
  }

  function setChannelMenuOpen(open) {
    if (!channelMenuToggleEl || !channelMenuPopupEl) {
      return;
    }
    channelMenuPopupEl.classList.toggle("hidden", !open);
    channelMenuToggleEl.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function toggleChannelMenu() {
    if (!channelMenuPopupEl) {
      return;
    }
    const shouldOpen = channelMenuPopupEl.classList.contains("hidden");
    setChannelMenuOpen(shouldOpen);
  }

  function flagEmojiFromCountryCode(countryCode) {
    const code = String(countryCode || "").trim().toUpperCase();
    const emojiCode = code === "UK" ? "GB" : code;
    if (!/^[A-Z]{2}$/.test(emojiCode)) {
      return code;
    }
    return Array.from(emojiCode)
      .map((char) => String.fromCodePoint(char.charCodeAt(0) + 127397))
      .join("");
  }

  function replaceOptions(selectEl, options, placeholderLabel) {
    if (!selectEl) {
      return;
    }
    selectEl.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = placeholderLabel;
    selectEl.appendChild(placeholder);
    for (const option of options) {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.title) {
        opt.title = option.title;
      }
      selectEl.appendChild(opt);
    }
  }

  function replaceCheckboxOptions(containerEl, options, name) {
    if (!containerEl) {
      return;
    }
    containerEl.innerHTML = "";
    options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "modal-mode-option";
      label.title = option.title || option.label || option.value;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option.value;
      checkbox.name = name;
      const text = document.createElement("span");
      text.textContent = option.label || option.value;
      label.appendChild(checkbox);
      label.appendChild(text);
      containerEl.appendChild(label);
    });
  }

  function countryDisplayName(countryCode) {
    if (countryCode === "UK" || countryCode === "GB") {
      return "United Kingdom";
    }
    try {
      const displayNames = new Intl.DisplayNames([navigator.language || "en-US"], { type: "region" });
      return String(displayNames.of(countryCode) || countryCode);
    } catch {
      return countryCode;
    }
  }

  function populatePrzemiennikiCountryOptions(codes) {
    const countries = Array.from(codes || [])
      .map((code) => {
        const name = countryDisplayName(code);
        const flag = flagEmojiFromCountryCode(code);
        return {
          value: code,
          label: `${flag} ${name}`.trim(),
          title: name,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    replaceOptions(przemiennikiCountryEl, countries, "Any country");
  }

  function populatePrzemiennikiBandOptions(bands) {
    const options = Array.from(bands || [])
      .map((band) => ({ value: band, label: band, title: band }))
      .sort((a, b) => a.value.localeCompare(b.value));
    replaceCheckboxOptions(przemiennikiBandListEl, options, "band");
  }

  function populatePrzemiennikiModeOptions(modes) {
    replaceCheckboxOptions(przemiennikiModeListEl, Array.from(modes || []), "mode");
  }

  function activeRepeaterSourceConfig() {
    return repeaterQuerySources[activeRepeaterQuerySource] || repeaterQuerySources.przemienniki;
  }

  function setActiveRepeaterQuerySource(sourceKey) {
    if (!repeaterQuerySources[sourceKey]) {
      activeRepeaterQuerySource = "przemienniki";
    } else {
      activeRepeaterQuerySource = sourceKey;
    }
    if (przemiennikiModalTitleEl) {
      przemiennikiModalTitleEl.textContent = `Query ${activeRepeaterSourceConfig().label}`;
    }
  }

  function selectedPrzemiennikiModes() {
    if (!przemiennikiModeListEl) {
      return [];
    }
    return Array.from(przemiennikiModeListEl.querySelectorAll('input[name="mode"]:checked'))
      .map((el) => String(el.value || "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  function selectedPrzemiennikiBands() {
    if (!przemiennikiBandListEl) {
      return [];
    }
    return Array.from(przemiennikiBandListEl.querySelectorAll('input[name="band"]:checked'))
      .map((el) => String(el.value || "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  async function ensureRepeaterQueryDictionaryLoaded() {
    const source = activeRepeaterSourceConfig();
    const existingPromise = source.getDictionaryPromise();
    if (existingPromise) {
      return existingPromise;
    }
    const dictionaryPromise = (async () => {
      const response = await fetch(source.metaUrl);
      if (!response.ok) {
        throw new Error(`Dictionary request failed: HTTP ${response.status}`);
      }
      const jsonText = await response.text();
      const parsed = parsePrzemiennikiMetaJson(jsonText);
      populatePrzemiennikiCountryOptions(parsed.countries);
      populatePrzemiennikiBandOptions(parsed.bands);
      populatePrzemiennikiModeOptions(parsed.modes);
      logDebug(`Loaded ${source.label} filter options from /meta.`);
      return parsed;
    })();
    source.setDictionaryPromise(dictionaryPromise);
    try {
      return await dictionaryPromise;
    } catch (error) {
      source.setDictionaryPromise(null);
      throw error;
    }
  }

  function setPrzemiennikiModalOpen(open) {
    if (!przemiennikiModalEl) {
      return;
    }
    przemiennikiModalEl.classList.toggle("hidden", !open);
    if (open) {
      przemiennikiCountryEl?.focus();
    }
  }

  function isPrzemiennikiModalOpen() {
    return Boolean(przemiennikiModalEl && !przemiennikiModalEl.classList.contains("hidden"));
  }

  async function openRepeaterQueryModal(sourceKey) {
    setActiveRepeaterQuerySource(sourceKey);
    const source = activeRepeaterSourceConfig();
    setChannelMenuOpen(false);
    setStatus(`Loading ${source.label} query options...`);
    await ensureRepeaterQueryDictionaryLoaded();
    setPrzemiennikiModalOpen(true);
    setStatus(`Configure ${source.label} query.`);
  }

  function appendQueryParam(url, key, value) {
    const text = String(value ?? "").trim();
    if (!text) {
      return;
    }
    url.searchParams.set(key, text);
  }

  async function runRepeaterQuery() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }
    const source = activeRepeaterSourceConfig();
    const url = new URL(source.apiUrl);
    appendQueryParam(url, "country", String(przemiennikiCountryEl?.value || "").toLowerCase());
    const selectedBands = selectedPrzemiennikiBands();
    if (selectedBands.length > 0) {
      url.searchParams.set("band", selectedBands.join(","));
    }
    selectedPrzemiennikiModes().forEach((mode) => {
      url.searchParams.append("mode", mode);
    });
    if (przemiennikiOnlyWorkingEl?.checked) {
      url.searchParams.set("onlyworking", "true");
    }
    appendQueryParam(url, "latitude", przemiennikiLatitudeEl?.value || "");
    appendQueryParam(url, "longitude", przemiennikiLongitudeEl?.value || "");
    appendQueryParam(url, "range", przemiennikiRangeEl?.value || "");
    setStatus(`Querying ${source.label}...`);
    const response = await fetch(url.toString());
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${source.actionLabel} query failed: HTTP ${response.status}\n${body.slice(0, 800)}`);
    }
    const xmlText = await response.text();
    const parsed = parsePrzemiennikiXml(xmlText);
    const rowsToInsert = buildPrzemiennikiRows(parsed.repeaters, {
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
      findEnumOption,
    });
    insertRowsAtSelectionOrEnd(rowsToInsert, source.insertLabel);
    logDebug(`${source.actionLabel.toUpperCase()} QUERY ${url.toString()}`);
    logDebug(`${source.actionLabel.toUpperCase()} RESULTS ${parsed.repeaters.length}`);
  }

  async function geolocatePrzemiennikiQuery() {
    if (!navigator.geolocation) {
      throw new Error("Geolocation API is not available in this browser.");
    }
    setStatus("Requesting browser geolocation...");
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Geolocation did not return valid coordinates.");
    }
    if (przemiennikiLatitudeEl) {
      przemiennikiLatitudeEl.value = latitude.toFixed(6);
    }
    if (przemiennikiLongitudeEl) {
      przemiennikiLongitudeEl.value = longitude.toFixed(6);
    }
    setStatus("Geolocation loaded into latitude/longitude fields.");
    logDebug(`PRZEMIENNIKI GEO ${latitude.toFixed(6)},${longitude.toFixed(6)}`);
  }

  function setRowValueIfPresent(row, column, value) {
    if (!currentHeaders.includes(column)) {
      return;
    }
    const meta = radioMetadata.columns?.[column] || {};
    row[column] = normalizeValue(column, value, meta, row[column]);
  }

  function findEnumOption(column, choices, caseInsensitive = false) {
    if (!currentHeaders.includes(column)) {
      return "";
    }
    const meta = radioMetadata.columns?.[column] || {};
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

  function addPmr446Channels() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }
    const rowsToInsert = buildPmr446Rows({
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
      findEnumOption,
    });
    insertRowsAtSelectionOrEnd(rowsToInsert, "PMR446");
  }

  function addFrsChannels() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }
    const rowsToInsert = buildFrsRows({
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
      findEnumOption,
    });
    insertRowsAtSelectionOrEnd(rowsToInsert, "FRS");
  }

  function addGmrsChannels() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }
    const rowsToInsert = buildGmrsRows({
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
      findEnumOption,
    });
    insertRowsAtSelectionOrEnd(rowsToInsert, "GMRS");
  }

  function insertRowsAtSelectionOrEnd(rowsToInsert, label) {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return false;
    }
    if (!Array.isArray(rowsToInsert) || rowsToInsert.length === 0) {
      setStatus(`No ${label} entries to insert.`);
      return false;
    }
    const selectedIndexes = sortedSelectedRowIndexes();
    const insertAt = selectedIndexes.length > 0 ? selectedIndexes[0] : currentRows.length;
    currentRows.splice(insertAt, 0, ...rowsToInsert);
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(
      rowsToInsert.map((_, offset) => insertAt + offset),
    );
    selectionAnchorIndex = insertAt;
    renderTable();
    setStatus(`Inserted ${rowsToInsert.length} ${label} channel(s) at channel ${insertAt}.`);
    return true;
  }

  function removeSelectedChannelRows() {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      setStatus("Select one or more channels to remove.");
      return;
    }

    for (let i = selectedIndexes.length - 1; i >= 0; i -= 1) {
      currentRows.splice(selectedIndexes[i], 1);
    }
    reindexLocationColumn();
    clearInvalidHighlights();

    resetRowSelection();
    if (currentRows.length > 0) {
      const nextIndex = Math.min(selectedIndexes[0], currentRows.length - 1);
      selectedRowIndexes = new Set([nextIndex]);
      selectionAnchorIndex = nextIndex;
    }
    renderTable();
    setStatus(`Removed ${selectedIndexes.length} selected channel(s).`);
  }

  // Create a table cell editor (input/select) based on CHIRP column metadata.
  function createCellEditor(row, rowIdx, column) {
    const meta = radioMetadata.columns?.[column] || {};
    const current = String(row[column] ?? "");
    const readOnly = column === "Location" || meta.editable === false;
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
        currentRows[rowIdx][column] = next;
        select.value = next;
      });
      return select;
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
      currentRows[rowIdx][column] = next;
      input.value = next;
    });
    return input;
  }

  // Render the editable channel table using current rows and metadata rules.
  function renderTable() {
    const columns = currentHeaders.slice();

    tableHead.innerHTML = "";
    tableBody.innerHTML = "";

    const headerRow = document.createElement("tr");
    columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column;
      headerRow.appendChild(th);
    });
    tableHead.appendChild(headerRow);

    currentRows.forEach((row, rowIdx) => {
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

      tableBody.appendChild(tr);
    });

    applyRowSelectionVisuals();
  }

  // Load selected radio's CHIRP-derived column metadata from Python runtime.
  async function loadSelectedRadioMetadata() {
    if (!selectedRadio) {
      return;
    }
    const meta = await requireRuntimeApi().getRadioMetadata({
      module: selectedRadio.module,
      className: selectedRadio.className,
    });
    radioMetadata = meta || { headers: [], columns: {} };
    currentHeaders = radioMetadata.headers?.length ? radioMetadata.headers : currentHeaders;
  }

  async function loadSelectedRadioSettings(options = {}) {
    if (!selectedRadio) {
      radioSettingsState = {
        supported: false,
        available: false,
        requiresImage: false,
        message: "",
        groups: [],
      };
      clearInvalidSettings();
      updateViewButtons();
      renderSettingsPanel();
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
      const result = await requireRuntimeApi().getRadioSettings({
        module: selectedRadio.module,
        className: selectedRadio.className,
      });
      nextState = {
        supported: Boolean(result?.supported),
        available: Boolean(result?.available),
        requiresImage: Boolean(result?.requiresImage),
        message: String(result?.message || ""),
        groups: cloneSettingsGroups(result?.groups || []),
      };
    } catch (error) {
      logDebug(`SETTINGS LOAD FALLBACK ${errorSummary(error)}`);
      nextState.message = "Radio-wide settings could not be prepared.";
    }

    if (preserveCurrent && radioHasSettings() && nextState.supported) {
      const currentByKey = new Map();
      for (const field of flattenSettingsFields(radioSettingsState.groups)) {
        currentByKey.set(settingKey(field.path, field.valueIndex), field.current);
      }
      for (const field of flattenSettingsFields(nextState.groups)) {
        const key = settingKey(field.path, field.valueIndex);
        if (currentByKey.has(key)) {
          field.valueRef.current = currentByKey.get(key);
        }
      }
    }

    radioSettingsState = nextState;
    clearInvalidSettings();
    if (!radioHasSettings() && currentEditorView === "settings") {
      setEditorView("channels");
    }
    if (!activeSettingsTab || !radioSettingsState.groups.some((group) => group.id === activeSettingsTab)) {
      activeSettingsTab = radioSettingsState.groups[0]?.id || "";
    }
    updateViewButtons();
    renderSettingsPanel();
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
      invalidSettingKeys.add(key);
      invalidSettingMessages.set(key, result.error);
    } else {
      clearInvalidSetting(settingNode.path, valueIndex);
    }
    updateSettingsSummary();
    renderSettingsPanel();
  }

  function findSettingsTabNode(tabId) {
    return radioSettingsState.groups.find((group) => group.id === tabId) || null;
  }

  function tabHasInvalidSettings(group) {
    if (!group) {
      return false;
    }
    return flattenSettingsFields([group]).some((field) =>
      invalidSettingKeys.has(settingKey(field.path, field.valueIndex)));
  }

  function renderSettingControl(settingNode, valueMeta, valueIndex) {
    const wrapper = document.createElement("div");
    wrapper.className = "settings-field-control";
    const key = settingKey(settingNode.path, valueIndex);
    const immutable = settingNode.mutable === false || valueMeta.mutable === false;
    const errorText = invalidSettingMessages.get(key) || "";
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

  function renderSettingsPanel() {
    updateSettingsSummary();
    updateViewButtons();
    if (!settingsTabsEl || !settingsContentEl || !settingsEmptyEl) {
      return;
    }

    settingsTabsEl.innerHTML = "";
    settingsContentEl.innerHTML = "";
    settingsEmptyEl.textContent = settingsUnavailableMessage();

    if (!radioHasSettings()) {
      settingsEmptyEl.hidden = false;
      settingsContentEl.hidden = true;
      return;
    }

    settingsEmptyEl.hidden = true;
    settingsContentEl.hidden = false;

    const activeGroup = findSettingsTabNode(activeSettingsTab) || radioSettingsState.groups[0];
    if (!activeGroup) {
      settingsEmptyEl.hidden = false;
      settingsContentEl.hidden = true;
      return;
    }
    activeSettingsTab = activeGroup.id;

    radioSettingsState.groups.forEach((group) => {
      const tabButton = document.createElement("button");
      tabButton.type = "button";
      tabButton.className = "settings-tab";
      tabButton.textContent = group.label || group.id;
      tabButton.classList.toggle("is-active", group.id === activeSettingsTab);
      tabButton.classList.toggle("has-invalid", tabHasInvalidSettings(group));
      tabButton.addEventListener("click", () => {
        activeSettingsTab = group.id;
        renderSettingsPanel();
      });
      settingsTabsEl.appendChild(tabButton);
    });
    renderSettingNode(settingsContentEl, activeGroup);
  }

  // Parse CSV through Python runtime and refresh table rows and status text.
  async function loadCsvText(csvText) {
    setStatus("Parsing CSV with CHIRP Python...");
    const parsed = await requireRuntimeApi().parseCsv({ csvText });
    const headersFromMeta = radioMetadata.headers || [];
    const parsedHeaders = parsed.headers || [];
    currentHeaders = headersFromMeta.length ? headersFromMeta : parsedHeaders;
    currentRows = parsed.rows;
    clearInvalidHighlights();
    resetRowSelection();
    renderTable();

    const issues = parsed.errors.length
      ? ` (${parsed.errors.length} parse warnings)`
      : "";
    setStatus(`Loaded ${currentRows.length} channel(s)${issues}.`);
  }

  // Trigger client-side download of generated text content as a file.
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBytes(filename, bytes) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Ask Python runtime to normalize current rows and export as CSV file.
  async function exportCsv() {
    setStatus("Normalizing rows with CHIRP Python...");
    const csvText = await requireRuntimeApi().normalizeRows({
      rows: currentRows,
      module: selectedRadio?.module || "",
      className: selectedRadio?.className || "",
    });
    downloadText("webchirp-export.csv", csvText);
    setStatus("Exported webchirp-export.csv");
  }

  async function exportBinaryCodeplug() {
    if (!selectedRadio) {
      setStatus("Select a radio make/model first.");
      return;
    }
    setStatus("Preparing CHIRP binary codeplug...");
    const result = await requireRuntimeApi().exportImage({
      module: selectedRadio.module,
      className: selectedRadio.className,
      rows: currentRows,
      settings: radioSettingsState.groups,
    });
    radioSettingsState.groups = cloneSettingsGroups(result.settings || radioSettingsState.groups);
    renderSettingsPanel();
    const bytes = base64ToBytes(result.imageBase64 || "");
    const fileName = buildBinaryCodeplugFileName(
      result.vendor || selectedRadio.vendor,
      result.model || selectedRadio.model,
    );
    downloadBytes(fileName, bytes);
    setStatus(`Exported ${fileName}`);
  }

  async function importBinaryCodeplug(file) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const imageBase64 = bytesToBase64(raw);
    setStatus("Loading CHIRP binary codeplug...");
    const loaded = await requireRuntimeApi().loadImage({ imageBase64 });
    const selected = selectRadioByDetectedImage(loaded);
    if (!selected) {
      throw new Error(
        `Loaded image radio ${loaded.module}.${loaded.className} is not available in current radio catalog`,
      );
    }
    await loadSelectedRadioMetadata();
    radioSettingsState = {
      supported: Array.isArray(loaded.settings) && loaded.settings.length > 0,
      available: Array.isArray(loaded.settings) && loaded.settings.length > 0,
      requiresImage: false,
      message: "",
      groups: cloneSettingsGroups(loaded.settings || []),
    };
    clearInvalidSettings();
    activeSettingsTab = radioSettingsState.groups[0]?.id || "";
    currentHeaders = radioMetadata.headers?.length
      ? radioMetadata.headers
      : (loaded.headers || currentHeaders);
    currentRows = Array.isArray(loaded.rows) ? loaded.rows : [];
    clearInvalidHighlights();
    resetRowSelection();
    renderTable();
    updateViewButtons();
    renderSettingsPanel();
    setStatus(
      `Loaded binary codeplug for ${loaded.vendor || selectedRadio.vendor} ${loaded.model || selectedRadio.model}.`,
    );
  }

  async function runUploadPreflight() {
    if (!selectedRadio) {
      return { valid: false, issues: [{ rowIndex: -1, column: "", message: "No radio selected." }] };
    }
    const [rowResult, settingsResult] = await Promise.all([
      requireRuntimeApi().validateRowsForUpload({
        rows: currentRows,
        module: selectedRadio.module,
        className: selectedRadio.className,
      }),
      requireRuntimeApi().validateRadioSettings({
        settings: radioSettingsState.groups,
        module: selectedRadio.module,
        className: selectedRadio.className,
      }),
    ]);
    const result = rowResult;
    const settingsValidation = settingsResult || { valid: true, issues: [], settings: radioSettingsState.groups };
    radioSettingsState.groups = cloneSettingsGroups(settingsValidation.settings || radioSettingsState.groups);
    if (!activeSettingsTab || !radioSettingsState.groups.some((group) => group.id === activeSettingsTab)) {
      activeSettingsTab = radioSettingsState.groups[0]?.id || "";
    }
    clearInvalidSettings();
    (settingsValidation.issues || []).forEach((issue) => {
      const path = Array.isArray(issue?.path) ? issue.path : [];
      const valueIndex = Number(issue?.valueIndex || 0);
      const key = settingKey(path, valueIndex);
      invalidSettingKeys.add(key);
      invalidSettingMessages.set(key, String(issue?.message || "Invalid value"));
      logDebug(
        `PREFLIGHT INVALID setting=${path.join(".") || "<unknown>"} value=${valueIndex}: ${issue?.message || "Invalid value"}`,
      );
    });
    updateSettingsSummary();
    clearInvalidHighlights();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    for (const issue of issues) {
      const rowIdx = Number(issue?.rowIndex);
      const column = String(issue?.column || "");
      if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= currentRows.length || !column) {
        continue;
      }
      invalidCellKeys.add(invalidCellKey(rowIdx, column));
      const channel = currentRows[rowIdx]?.Location ?? rowIdx;
      logDebug(`PREFLIGHT INVALID channel=${channel} column=${column}: ${issue?.message || "Invalid value"}`);
    }
    if (issues.length > 0) {
      renderTable();
    }
    renderSettingsPanel();
    return {
      valid: Boolean(result?.valid) && Boolean(settingsValidation?.valid) && invalidSettingKeys.size === 0,
      issues: [...issues, ...(settingsValidation.issues || [])],
    };
  }

  // Register all UI event handlers and action bindings.
  function bindEvents() {
    channelInsertEl?.addEventListener("click", () => {
      insertNewChannelRow();
    });
    channelRemoveEl?.addEventListener("click", () => {
      removeSelectedChannelRows();
    });
    channelMenuToggleEl?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleChannelMenu();
    });
    channelAddGmrsEl?.addEventListener("click", () => {
      setChannelMenuOpen(false);
      addGmrsChannels();
    });
    channelAddFrsEl?.addEventListener("click", () => {
      setChannelMenuOpen(false);
      addFrsChannels();
    });
    channelAddPmr446El?.addEventListener("click", () => {
      setChannelMenuOpen(false);
      addPmr446Channels();
    });
    channelImportPrzemiennikiEl?.addEventListener("click", async () => {
      try {
        await openRepeaterQueryModal("przemienniki");
      } catch (error) {
        reportActionError("Przemienniki modal", error);
      }
    });
    channelImportRepeaterbookEl?.addEventListener("click", async () => {
      try {
        await openRepeaterQueryModal("repeaterbook");
      } catch (error) {
        reportActionError("RepeaterBook modal", error);
      }
    });
    przemiennikiCancelEl?.addEventListener("click", () => {
      const source = activeRepeaterSourceConfig();
      setPrzemiennikiModalOpen(false);
      setStatus(`Cancelled ${source.label} query.`);
    });
    przemiennikiGeolocateEl?.addEventListener("click", async () => {
      try {
        await geolocatePrzemiennikiQuery();
      } catch (error) {
        reportActionError("Przemienniki geolocation", error);
      }
    });
    przemiennikiModalEl?.addEventListener("click", (event) => {
      if (event.target === przemiennikiModalEl) {
        setPrzemiennikiModalOpen(false);
      }
    });
    przemiennikiFormEl?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await runRepeaterQuery();
        setPrzemiennikiModalOpen(false);
      } catch (error) {
        reportActionError(`${activeRepeaterSourceConfig().actionLabel} query`, error);
      }
    });

    document.addEventListener("click", (event) => {
      if (!channelMenuPopupEl || channelMenuPopupEl.classList.contains("hidden")) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (channelMenuPopupEl.contains(target) || channelMenuToggleEl?.contains(target)) {
        return;
      }
      setChannelMenuOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (isPrzemiennikiModalOpen()) {
          setPrzemiennikiModalOpen(false);
          return;
        }
        setChannelMenuOpen(false);
      }
    });

    document.querySelector("#load-sample").addEventListener("click", async () => {
      try {
        await loadCsvText(DEFAULT_SAMPLE_CSV);
      } catch (error) {
        reportActionError("Sample load", error);
      }
    });

    document.querySelector("#import-csv").addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        return;
      }

      try {
        const csvText = await file.text();
        await loadCsvText(csvText);
      } catch (error) {
        reportActionError("CSV import", error);
      } finally {
        fileInput.value = "";
      }
    });

    document.querySelector("#export-csv").addEventListener("click", async () => {
      try {
        await exportCsv();
      } catch (error) {
        reportActionError("Export", error);
      }
    });

    document.querySelector("#export-binary").addEventListener("click", async () => {
      try {
        await exportBinaryCodeplug();
      } catch (error) {
        reportActionError("Binary export", error);
      }
    });

    document.querySelector("#import-binary").addEventListener("click", () => {
      imgFileInput.click();
    });

    imgFileInput.addEventListener("change", async () => {
      const file = imgFileInput.files?.[0];
      if (!file) {
        return;
      }
      try {
        await importBinaryCodeplug(file);
      } catch (error) {
        reportActionError("Binary import", error);
      } finally {
        imgFileInput.value = "";
      }
    });

    radioMakeEl.addEventListener("change", () => {
      refreshModelOptions();
      updateSerialActionState();
      persistSelectedRadioCookie();
      clearInvalidHighlights();
      clearInvalidSettings();
      Promise.all([
        loadSelectedRadioMetadata(),
        loadSelectedRadioSettings(),
      ])
        .then(() => renderTable())
        .catch((error) => reportActionError("Metadata load", error));
    });

    radioModelEl.addEventListener("change", () => {
      const key = radioModelEl.value;
      selectedRadio = radioCatalog.find((r) => r.key === key) || null;
      if (selectedRadio) {
        logDebug(
          `RADIO SELECT ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
        );
      }
      updateSerialActionState();
      persistSelectedRadioCookie();
      clearInvalidHighlights();
      clearInvalidSettings();
      Promise.all([
        loadSelectedRadioMetadata(),
        loadSelectedRadioSettings(),
      ])
        .then(() => renderTable())
        .catch((error) => reportActionError("Metadata load", error));
    });

    viewChannelsEl?.addEventListener("click", () => {
      setEditorView("channels");
    });

    viewSettingsEl?.addEventListener("click", () => {
      if (!radioHasSettings()) {
        setStatus(settingsUnavailableMessage());
        return;
      }
      setEditorView("settings");
      renderSettingsPanel();
    });

    serialConnectToggleEl?.addEventListener("click", async () => {
      serialConnectToggleEl.disabled = true;
      try {
        if (serialConnected) {
          setStatus("Disconnecting serial...");
          const result = await requireRuntimeApi().serialDisconnect();
          serialConnected = Boolean(result?.connected);
          refreshSerialConnectToggleLabel();
          setStatus(result.message || "Serial disconnected.");
          return;
        }

        const baudRate = Number(selectedRadio?.baudRate || 9600);
        setStatus("Connecting serial...");
        const result = await requireRuntimeApi().serialConnect({ baudRate });
        serialConnected = Boolean(result?.connected);
        refreshSerialConnectToggleLabel();
        if (result?.deviceName) {
          logDebug(`SERIAL DEVICE ${result.deviceName}`);
        }
        if (result?.usbVendorId) {
          lastUsbVendorId = result.usbVendorId;
        }
        if (result?.usbProductId) {
          lastUsbProductId = result.usbProductId;
        }
        if (lastUsbVendorId || lastUsbProductId) {
          logDebug(`SERIAL USB ID ${lastUsbVendorId || "unknown"}:${lastUsbProductId || "unknown"}`);
        }
        setStatus(result.message || "Serial connected.");
      } catch (error) {
        const action = serialConnected ? "Serial disconnect" : "Serial connect";
        reportActionError(action, error);
        logSerial(`ERROR ${errorSummary(error)}`);
      } finally {
        serialConnectToggleEl.disabled = false;
      }
    });

    document.querySelector("#serial-transaction").addEventListener("click", async () => {
      const txHex = document.querySelector("#tx-hex").value;
      const rxBytes = Number(document.querySelector("#rx-bytes").value || 32);
      const timeoutMs = Number(document.querySelector("#rx-timeout").value || 1200);

      try {
        setStatus("Running Python serial transaction...");
        const result = await requireRuntimeApi().serialTxRx({ txHex, rxBytes, timeoutMs });
        setStatus("Python serial transaction complete.");
        logSerial(`PY TX ${result.tx.hex} | PY RX ${result.rx.hex || "<none>"}`);
      } catch (error) {
        reportActionError("Serial transaction", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#debug-clear").addEventListener("click", () => {
      debugOutputEl.value = "";
      lastErrorSummary = "";
    });

    reportIssueEl?.addEventListener("click", () => {
      openPrefilledIssue();
    });

    window.addEventListener("error", (event) => {
      logDebug(`WINDOW ERROR ${event.message}`);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const msg = event.reason?.message || String(event.reason || "Unhandled rejection");
      logDebug(`PROMISE ERROR ${msg}`);
    });

    document.querySelector("#radio-download").addEventListener("click", async () => {
      if (!selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        setStatus(`Downloading from ${makeModelLabel(selectedRadio)}...`);
        const result = await requireRuntimeApi().downloadSelectedRadio({
          module: selectedRadio.module,
          className: selectedRadio.className,
        });
        currentHeaders = radioMetadata.headers?.length
          ? radioMetadata.headers
          : (result.headers || []);
        currentRows = result.rows;
        radioSettingsState = {
          supported: Array.isArray(result.settings) && result.settings.length > 0,
          available: Array.isArray(result.settings) && result.settings.length > 0,
          requiresImage: false,
          message: "",
          groups: cloneSettingsGroups(result.settings || []),
        };
        activeSettingsTab = radioSettingsState.groups[0]?.id || "";
        clearInvalidHighlights();
        clearInvalidSettings();
        resetRowSelection();
        renderTable();
        updateViewButtons();
        renderSettingsPanel();
        setStatus(`${makeModelLabel(selectedRadio)} download complete (${currentRows.length} channels).`);
        if (result.ident) {
          logSerial(`IDENT ${result.ident}`);
        }
      } catch (error) {
        reportActionError("Download", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#radio-upload").addEventListener("click", async () => {
      if (!selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        setStatus("Running upload preflight validation...");
        const preflight = await runUploadPreflight();
        if (!preflight.valid) {
          const count = Array.isArray(preflight.issues) ? preflight.issues.length : 0;
          setStatus(
            count > 0
              ? `Upload blocked: ${count} invalid value(s) highlighted in red in ${currentViewLabel()}.`
              : "Upload blocked: preflight validation failed.",
          );
          return;
        }
        setStatus(`Uploading to ${makeModelLabel(selectedRadio)}...`);
        const uploadResult = await requireRuntimeApi().uploadSelectedRadio({
          module: selectedRadio.module,
          className: selectedRadio.className,
          rows: currentRows,
          settings: radioSettingsState.groups,
        });
        radioSettingsState.groups = cloneSettingsGroups(uploadResult.settings || radioSettingsState.groups);
        clearInvalidSettings();
        renderSettingsPanel();
        setStatus(`${makeModelLabel(selectedRadio)} upload complete.`);
      } catch (error) {
        reportActionError("Upload", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });
  }

  // Bootstrap UI: capability checks, catalog load, metadata load, sample data.
  async function init(serialSupported) {
    bindEvents();
    refreshSerialConnectToggleLabel();
    setSerialSupportWarningVisible(!serialSupported);
    setSidebarControlsEnabled(false);
    try {
      if (!serialSupported) {
        logSerial("Web Serial unsupported in this browser.");
      } else {
        logSerial("Web Serial available.");
      }
      const catalog = await requireRuntimeApi().listRadios();
      radioCatalog = catalog.radios || [];
      runtimeInfo = (await requireRuntimeApi().getRuntimeInfo()) || runtimeInfo;
      refreshMakeOptions();
      restoreSelectedRadioCookie();
      await loadSelectedRadioMetadata();
      await loadSelectedRadioSettings();
      setStatus(`Loaded ${radioCatalog.length} radio definitions from CHIRP sources.`);
      await loadCsvText(DEFAULT_SAMPLE_CSV);
      renderSettingsPanel();
      setSidebarControlsEnabled(true);
    } catch (error) {
      reportActionError("Initialization", error);
      setStatus("Initialization failed; sidebar controls remain disabled.");
    }
  }

  return {
    setRuntimeApi,
    setStatus,
    logSerial,
    logDebug,
    init,
    selectedRowsForOperations,
    onRuntimeCrash(message) {
      logDebug(`RUNTIME CRASH ${message}`);
    },
  };
}

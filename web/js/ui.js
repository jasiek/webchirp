import {
  buildGmrsRows,
  buildFrsRows,
  DEFAULT_REPEATER_API_BASE,
  buildRepeaterEndpoints,
  buildPmr446Rows,
  buildPrzemiennikiRows,
  parsePrzemiennikiMetaJson,
  parsePrzemiennikiXml,
} from "./datasources.js";
import {
  buildRowsFromClipboardText,
  computeMovedRowOrder,
  looksLikeChannelTsv,
  rowLooksNonEmpty,
  serializeRowsToTsv,
} from "./clipboard.js";

const REPEATER_API_BASE_META = "webchirp-repeater-api-base";

// Resolve the repeater-query API base for this deployment. A
// <meta name="webchirp-repeater-api-base"> tag overrides the built-in default:
// its content (a proxy base URL, or blank to disable the online-query
// features) wins when the tag is present; without the tag the default applies.
function resolveRepeaterApiBase() {
  const meta = document.querySelector(`meta[name="${REPEATER_API_BASE_META}"]`);
  if (meta) {
    return String(meta.getAttribute("content") || "").trim();
  }
  return DEFAULT_REPEATER_API_BASE;
}

const DEFAULT_SAMPLE_CSV = `Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment\n0,Simplex1,146.520000,,0.600000,,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,National Calling\n1,RepeaterA,146.940000,-,0.600000,TSQL,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,Local repeater\n`;
const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";
const LAST_RADIO_COOKIE = "webchirp_last_radio";
const RADIO_SEARCH_MAX_RESULTS = 50;

function sanitizeFileNamePart(text) {
  return String(text || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "radio";
}

function dateStampForFileName(date) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}${m}${d}`;
}

// Derive an export file name like Baofeng_BF-888_20231218.img
// (<brand>_<model>_<date>.<format>).
export function buildExportFileName(vendor, model, extension, date = new Date()) {
  const vendorPart = sanitizeFileNamePart(vendor);
  const modelPart = sanitizeFileNamePart(model);
  return `${vendorPart}_${modelPart}_${dateStampForFileName(date)}.${extension}`;
}

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
  const radioSearchEl = document.querySelector("#radio-search");
  const radioSearchResultsEl = document.querySelector("#radio-search-results");
  const radioMakeEl = document.querySelector("#radio-make");
  const radioModelEl = document.querySelector("#radio-model");
  const serialConnectToggleEl = document.querySelector("#serial-connect-toggle");
  const webusbConnectToggleEl = document.querySelector("#serial-connect-webusb");
  const radioDownloadEl = document.querySelector("#radio-download");
  const radioUploadEl = document.querySelector("#radio-upload");
  const cloneProgressEl = document.querySelector("#clone-progress");
  const cloneProgressBarEl = document.querySelector("#clone-progress-bar");
  const cloneProgressLabelEl = document.querySelector("#clone-progress-label");
  const cloneProgressPercentEl = document.querySelector("#clone-progress-percent");
  const channelInsertEl = document.querySelector("#channel-insert");
  const channelRemoveEl = document.querySelector("#channel-remove");
  const channelMoveUpEl = document.querySelector("#channel-move-up");
  const channelMoveDownEl = document.querySelector("#channel-move-down");
  const channelCopyEl = document.querySelector("#channel-copy");
  const channelCutEl = document.querySelector("#channel-cut");
  const channelPasteEl = document.querySelector("#channel-paste");
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
  const importChoiceModalEl = document.querySelector("#import-choice-modal");
  const importChoiceMessageEl = document.querySelector("#import-choice-message");
  const importChoiceReplaceEl = document.querySelector("#import-choice-replace");
  const importChoiceMergeEl = document.querySelector("#import-choice-merge");
  const importChoiceCancelEl = document.querySelector("#import-choice-cancel");
  const sidebarControlEls = Array.from(
    document.querySelectorAll(".left-panel select, .left-panel button, .left-panel input"),
  );

  let runtimeApi = null;
  let currentHeaders = [];
  let currentRows = [];
  let radioCatalog = [];
  let radioSearchMatches = [];
  let radioSearchActiveIndex = -1;
  let selectedRadio = null;
  let radioMetadata = { headers: [], columns: {} };
  let radioSettingsState = { supported: false, available: false, requiresImage: false, message: "", groups: [] };
  // Only the newest metadata/settings load may apply its results; older
  // in-flight responses would otherwise overwrite state for a radio the user
  // has already navigated away from.
  let radioLoadSequence = 0;
  let lastLoadedRadioKey = "";
  let runtimeInfo = { chirpRevision: "" };
  let lastUsbVendorId = "";
  let lastUsbProductId = "";
  let serialTransportController = null;
  let serialCapability = { supported: false, native: false, webusb: false };
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
  let importChoiceResolve = null;
  // Transport of the active connection ("webserial" or "webusb"), used to
  // collapse the two connect toggles to a single Disconnect button when both
  // are visible (Android).
  let serialTransport = "";

  // Online repeater queries depend on a CORS proxy; when none is configured
  // (blank base) the endpoints are null and these features are disabled: the
  // menu items are hidden so they can't fire requests that will fail.
  const repeaterEndpoints = buildRepeaterEndpoints(resolveRepeaterApiBase());
  const repeaterQueryEnabled = repeaterEndpoints !== null;
  if (!repeaterQueryEnabled) {
    if (channelImportPrzemiennikiEl) {
      channelImportPrzemiennikiEl.hidden = true;
    }
    if (channelImportRepeaterbookEl) {
      channelImportRepeaterbookEl.hidden = true;
    }
  }

  const repeaterQuerySources = {
    przemienniki: {
      key: "przemienniki",
      label: "przemienniki.net",
      actionLabel: "Przemienniki",
      insertLabel: "przemienniki",
      apiUrl: repeaterEndpoints?.przemienniki.apiUrl || "",
      metaUrl: repeaterEndpoints?.przemienniki.metaUrl || "",
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
      apiUrl: repeaterEndpoints?.repeaterbook.apiUrl || "",
      metaUrl: repeaterEndpoints?.repeaterbook.metaUrl || "",
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

  // Wire the serial bridge's transport controls (capability + forced transport)
  // so the UI can offer an explicit WebUSB connect path.
  function setSerialController(controller) {
    serialTransportController = controller || null;
    serialCapability = controller?.capability || serialCapability;
    updateSerialActionState();
  }

  function setSerialButtonsBusy(busy) {
    if (serialConnectToggleEl) {
      serialConnectToggleEl.disabled = busy;
    }
    if (webusbConnectToggleEl) {
      webusbConnectToggleEl.disabled = busy;
    }
  }

  // Connect using the requested transport ("auto" or "webusb").
  async function connectSerial(preferredTransport) {
    if (serialConnected) {
      return;
    }
    serialTransportController?.setPreferredTransport(preferredTransport);
    setSerialButtonsBusy(true);
    try {
      const baudRate = Number(selectedRadio?.baudRate || 9600);
      setStatus(`Connecting serial${preferredTransport === "webusb" ? " via WebUSB" : ""}...`);
      const result = await requireRuntimeApi().serialConnect({ baudRate });
      serialConnected = Boolean(result?.connected);
      if (result?.deviceName) {
        logDebug(`SERIAL DEVICE ${result.deviceName}`);
      }
      serialTransport = result?.transport || "";
      if (result?.transport) {
        logSerial(`Transport: ${result.transport}`);
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
      reportActionError("Serial connect", error);
      logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      setSerialButtonsBusy(false);
      refreshSerialConnectToggleLabel();
      updateSerialActionState();
    }
  }

  async function disconnectSerial() {
    setSerialButtonsBusy(true);
    try {
      setStatus("Disconnecting serial...");
      const result = await requireRuntimeApi().serialDisconnect();
      serialConnected = Boolean(result?.connected);
      if (!serialConnected) {
        serialTransport = "";
      }
      setStatus(result.message || "Serial disconnected.");
    } catch (error) {
      reportActionError("Serial disconnect", error);
      logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      setSerialButtonsBusy(false);
      refreshSerialConnectToggleLabel();
      updateSerialActionState();
    }
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
    // Mobile has no hover tooltips, so on Android the labels themselves say
    // what each transport is for.
    const mobile = isAndroidPlatform();
    if (serialConnectToggleEl) {
      serialConnectToggleEl.textContent = serialConnected
        ? "Disconnect"
        : (mobile ? "Connect via WebSerial (Bluetooth)" : "Connect via WebSerial");
    }
    if (webusbConnectToggleEl) {
      webusbConnectToggleEl.textContent = serialConnected
        ? "Disconnect"
        : (mobile ? "Connect via WebUSB (wired adapter)" : "Connect via WebUSB");
    }
  }

  // Show the clone progress bar in its indeterminate state until the driver's
  // first status report arrives with real block counts.
  function beginCloneProgress(label) {
    if (!cloneProgressEl) {
      return;
    }
    if (cloneProgressLabelEl) {
      cloneProgressLabelEl.textContent = String(label || "Working...");
    }
    if (cloneProgressPercentEl) {
      cloneProgressPercentEl.textContent = "";
    }
    cloneProgressBarEl?.removeAttribute?.("value");
    cloneProgressEl.hidden = false;
  }

  // CHIRP drivers report status once per transferred block (cur/max may be -1
  // when a driver reports no counts; the bar then stays indeterminate).
  function updateCloneProgress(cur, max, msg) {
    if (!cloneProgressEl) {
      return;
    }
    cloneProgressEl.hidden = false;
    if (msg && cloneProgressLabelEl) {
      cloneProgressLabelEl.textContent = msg;
    }
    if (Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur >= 0) {
      const percent = Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
      if (cloneProgressBarEl) {
        cloneProgressBarEl.value = percent;
      }
      if (cloneProgressPercentEl) {
        cloneProgressPercentEl.textContent = `${percent}%`;
      }
    } else {
      // A no-count report must not leave the previous phase's percentage on
      // screen: removing value makes the <progress> bar indeterminate again.
      cloneProgressBarEl?.removeAttribute?.("value");
      if (cloneProgressPercentEl) {
        cloneProgressPercentEl.textContent = "";
      }
    }
  }

  function endCloneProgress() {
    if (cloneProgressEl) {
      cloneProgressEl.hidden = true;
    }
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
    clearRadioFilter();
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

  function trackRadioEvent(eventName, radio) {
    if (!radio || typeof globalThis.gtag !== "function") {
      return;
    }
    globalThis.gtag("event", eventName, {
      radio_make: String(radio.vendor || ""),
      radio_model: String(radio.model || ""),
      radio_module: String(radio.module || ""),
      radio_class: String(radio.className || ""),
    });
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

  // Android's native Web Serial only reaches Bluetooth RFCOMM serial ports, so
  // the WebUSB connect path must stay available there for wired USB adapters.
  function isAndroidPlatform() {
    return /\bAndroid\b/i.test(navigator.userAgent || "");
  }

  function updateSerialActionState() {
    const liveRadioUnsupported = selectedRadioIsLiveMode();
    const actionsAllowed = sidebarControlsEnabled && !liveRadioUnsupported;

    setLiveRadioSupportWarningVisible(liveRadioUnsupported);

    // Connect controls by platform capability:
    // - Desktop with native Web Serial: WebSerial toggle only.
    // - Android with native Web Serial (Bluetooth RFCOMM serial ports): both
    //   toggles — WebSerial for Bluetooth serial, WebUSB for wired USB
    //   adapters, which Android's native Web Serial cannot drive.
    // - WebUSB-only browsers (older Android Chrome): WebUSB toggle only.
    // - Neither API: the WebSerial toggle stays visible (disabled) alongside
    //   the unsupported-browser warning.
    const webusbOnly = serialCapability.webusb && !serialCapability.native;
    let showWebSerialToggle = !webusbOnly;
    let showWebUsbToggle =
      serialCapability.webusb && (!serialCapability.native || isAndroidPlatform());
    // While connected, collapse to a single Disconnect button on the toggle
    // matching the active transport.
    if (serialConnected && showWebSerialToggle && showWebUsbToggle) {
      showWebUsbToggle = serialTransport === "webusb";
      showWebSerialToggle = !showWebUsbToggle;
    }

    if (serialConnectToggleEl) {
      serialConnectToggleEl.hidden = !showWebSerialToggle;
      serialConnectToggleEl.disabled = !actionsAllowed;
      serialConnectToggleEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : (isAndroidPlatform()
          ? "Connect over native Web Serial, for use with Bluetooth serial ports"
          : "");
    }

    if (webusbConnectToggleEl) {
      webusbConnectToggleEl.hidden = !showWebUsbToggle;
      webusbConnectToggleEl.disabled = !actionsAllowed;
      webusbConnectToggleEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : "Connect over WebUSB, for use with FTDI FT231X/FT232R or Prolific PL2303";
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

  // Match a radio against a search query; every whitespace-separated token must
  // appear somewhere in the "vendor model class" text (case-insensitive).
  function radioMatchesFilter(radio, tokens) {
    if (tokens.length === 0) {
      return true;
    }
    const haystack = `${radio.vendor} ${radio.model} ${radio.className}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  // Catalog entries matching a free-text search query.
  function matchingRadios(query) {
    const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return [];
    }
    return radioCatalog.filter((radio) => radioMatchesFilter(radio, tokens));
  }

  // "<Make> <Model>" label for a search suggestion; the driver class is added
  // when several catalog entries share the same vendor+model text.
  function radioSearchLabel(radio, hasDuplicateLabel) {
    const base = makeModelLabel(radio);
    const label = radio.isLiveRadio ? `⚡ ${base}` : base;
    return hasDuplicateLabel ? `${label} (${radio.className})` : label;
  }

  function hideRadioSearchResults() {
    radioSearchMatches = [];
    radioSearchActiveIndex = -1;
    if (radioSearchResultsEl) {
      radioSearchResultsEl.hidden = true;
      radioSearchResultsEl.innerHTML = "";
    }
    radioSearchEl?.setAttribute("aria-expanded", "false");
  }

  // Clear the search box and close its suggestion list (programmatic selections).
  function clearRadioFilter() {
    if (radioSearchEl) {
      radioSearchEl.value = "";
    }
    hideRadioSearchResults();
  }

  // Render the autocomplete dropdown for the current search box contents.
  function renderRadioSearchResults() {
    if (!radioSearchResultsEl) {
      return;
    }
    const query = String(radioSearchEl?.value || "").trim();
    if (!query) {
      hideRadioSearchResults();
      return;
    }
    const matches = matchingRadios(query);
    radioSearchMatches = matches.slice(0, RADIO_SEARCH_MAX_RESULTS);
    radioSearchActiveIndex = radioSearchMatches.length > 0 ? 0 : -1;
    radioSearchResultsEl.innerHTML = "";

    if (matches.length === 0) {
      const li = document.createElement("li");
      li.classList.add("radio-search-empty");
      li.textContent = "No matching radios";
      radioSearchResultsEl.appendChild(li);
    } else {
      const labelCounts = new Map();
      for (const radio of radioSearchMatches) {
        const label = makeModelLabel(radio);
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }
      radioSearchMatches.forEach((radio, index) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.dataset.index = String(index);
        const hasDuplicateLabel = (labelCounts.get(makeModelLabel(radio)) || 0) > 1;
        li.textContent = radioSearchLabel(radio, hasDuplicateLabel);
        if (index === radioSearchActiveIndex) {
          li.classList.add("is-active");
        }
        radioSearchResultsEl.appendChild(li);
      });
      if (matches.length > radioSearchMatches.length) {
        const li = document.createElement("li");
        li.classList.add("radio-search-more");
        li.textContent = `${matches.length - radioSearchMatches.length} more — keep typing to narrow down`;
        radioSearchResultsEl.appendChild(li);
      }
    }

    radioSearchResultsEl.hidden = false;
    radioSearchEl?.setAttribute("aria-expanded", "true");
  }

  // Move the keyboard highlight in the suggestion list by delta and keep it in view.
  function moveRadioSearchActive(delta) {
    if (radioSearchMatches.length === 0) {
      return;
    }
    const count = radioSearchMatches.length;
    radioSearchActiveIndex = (radioSearchActiveIndex + delta + count) % count;
    const items = radioSearchResultsEl?.querySelectorAll("li[role='option']") || [];
    items.forEach((li, index) => {
      li.classList.toggle("is-active", index === radioSearchActiveIndex);
    });
    items[radioSearchActiveIndex]?.scrollIntoView({ block: "nearest" });
  }

  // Apply a suggestion: sync the make/model dropdowns and load the radio.
  function applyRadioSearchSelection(radio) {
    if (!radio) {
      return;
    }
    if (radioSearchEl) {
      radioSearchEl.value = makeModelLabel(radio);
    }
    hideRadioSearchResults();
    radioMakeEl.value = radio.vendor;
    refreshModelOptions();
    radioModelEl.value = radio.key;
    selectedRadio = radio;
    logDebug(
      `RADIO SELECT ${makeModelLabel(radio)} (${radio.module}.${radio.className})`,
    );
    reloadForSelectedRadio();
  }

  // Shared side effects after the selected radio changes via make/model/search.
  function reloadForSelectedRadio() {
    updateSerialActionState();
    persistSelectedRadioCookie();
    clearInvalidHighlights();
    clearInvalidSettings();
    if (selectedRadio && selectedRadio.key === lastLoadedRadioKey) {
      renderTable();
      return;
    }
    const loadToken = nextRadioLoadToken();
    Promise.all([
      loadSelectedRadioMetadata(loadToken),
      loadSelectedRadioSettings({ loadToken }),
    ])
      .then(() => {
        if (isStaleRadioLoad(loadToken)) {
          return;
        }
        lastLoadedRadioKey = selectedRadio?.key || "";
        renderTable();
      })
      .catch((error) => {
        if (!isStaleRadioLoad(loadToken)) {
          reportActionError("Metadata load", error);
        }
      });
  }

  function nextRadioLoadToken() {
    radioLoadSequence += 1;
    return radioLoadSequence;
  }

  function isStaleRadioLoad(loadToken) {
    return loadToken !== radioLoadSequence;
  }

  function formatRadioModelOption(radio, hasDuplicateModel) {
    const modelLabel = radio.isLiveRadio ? `⚡ ${radio.model}` : radio.model;
    return hasDuplicateModel ? `${modelLabel} (${radio.className})` : modelLabel;
  }

  function setRadioSelectPlaceholder(label) {
    const text = String(label || "");
    for (const selectEl of [radioMakeEl, radioModelEl]) {
      if (!selectEl) {
        continue;
      }
      selectEl.innerHTML = "";
      const option = document.createElement("option");
      option.value = "";
      option.textContent = text;
      selectEl.appendChild(option);
      selectEl.value = "";
    }
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
    clearRadioFilter();
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
    clearRadioFilter();
    radioMakeEl.value = fallback.vendor;
    refreshModelOptions();
    radioModelEl.value = fallback.key;
    selectedRadio = fallback;
    persistSelectedRadioCookie();
    return true;
  }

  // Populate make dropdown from the catalog and initialize model options,
  // preserving the current vendor when it is still present.
  function refreshMakeOptions() {
    const previousVendor = radioMakeEl.value;
    const vendors = uniqueVendors(radioCatalog);
    radioMakeEl.innerHTML = "";

    if (vendors.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No matching radios";
      radioMakeEl.appendChild(option);
      radioModelEl.innerHTML = "";
      selectedRadio = null;
      updateSerialActionState();
      return;
    }

    for (const vendor of vendors) {
      const option = document.createElement("option");
      option.value = vendor;
      option.textContent = vendor;
      radioMakeEl.appendChild(option);
    }
    radioMakeEl.value = vendors.includes(previousVendor) ? previousVendor : vendors[0];
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
  // allowReadOnly lets programmatic row builders (paste, repeater imports) fill
  // columns the grid renders read-only (e.g. TStep on radios with
  // has_tuning_step=False); kind/options validation still applies.
  function normalizeValue(column, value, meta, previous, { allowReadOnly = false } = {}) {
    let v = String(value ?? "");
    if (!meta || (meta.editable === false && !allowReadOnly)) {
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
        // Numeric enums (TStep "5.00", rToneFreq "88.5", DtcsCode "023") may
        // arrive from spreadsheets without CHIRP's zero padding ("5", "23");
        // match them by numeric value before giving up.
        const numeric = Number.parseFloat(v);
        const numericMatch = Number.isFinite(numeric)
          ? options.find((option) => Number.parseFloat(option) === numeric)
          : undefined;
        if (numericMatch !== undefined) {
          return numericMatch;
        }
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

  function isImportChoiceModalOpen() {
    return Boolean(importChoiceModalEl && !importChoiceModalEl.classList.contains("hidden"));
  }

  function resolveImportChoice(choice) {
    if (!importChoiceResolve) {
      return;
    }
    const resolve = importChoiceResolve;
    importChoiceResolve = null;
    importChoiceModalEl?.classList.add("hidden");
    resolve(choice);
  }

  // Ask the user what to do with imported channels when the editor already
  // holds real ones. Resolves to "replace", "merge", or "cancel".
  function askImportChoice(message) {
    if (!importChoiceModalEl) {
      return Promise.resolve("replace");
    }
    if (importChoiceMessageEl) {
      importChoiceMessageEl.textContent = message;
    }
    importChoiceModalEl.classList.remove("hidden");
    return new Promise((resolve) => {
      importChoiceResolve = resolve;
    });
  }

  // A row counts as a real channel when it has a usable frequency or a name;
  // blank inserted rows should not trigger the data-loss prompt.
  function hasRealChannels() {
    return currentRows.some((row) => {
      const frequency = Number.parseFloat(String(row?.Frequency ?? ""));
      if (Number.isFinite(frequency) && frequency > 0) {
        return true;
      }
      return String(row?.Name ?? "").trim() !== "";
    });
  }

  async function openRepeaterQueryModal(sourceKey) {
    if (!repeaterQueryEnabled) {
      return;
    }
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
    row[column] = normalizeValue(column, value, meta, row[column], { allowReadOnly: true });
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

  // Remove exactly these row objects. Identity-based so a removal captured
  // before an await (Cut's clipboard write) deletes the rows that were
  // serialized even if the selection or row order changed while it was
  // pending. Returns how many rows were actually removed.
  function removeChannelRows(rowsToRemove) {
    const identity = new Set(rowsToRemove);
    const firstIndex = currentRows.findIndex((row) => identity.has(row));
    const before = currentRows.length;
    currentRows = currentRows.filter((row) => !identity.has(row));
    const removed = before - currentRows.length;
    if (removed === 0) {
      return 0;
    }
    reindexLocationColumn();
    clearInvalidHighlights();

    resetRowSelection();
    if (currentRows.length > 0) {
      const nextIndex = Math.min(firstIndex, currentRows.length - 1);
      selectedRowIndexes = new Set([nextIndex]);
      selectionAnchorIndex = nextIndex;
    }
    renderTable();
    return removed;
  }

  function removeSelectedChannelRows() {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      setStatus("Select one or more channels to remove.");
      return;
    }
    const removed = removeChannelRows(selectedIndexes.map((idx) => currentRows[idx]));
    setStatus(`Removed ${removed} selected channel(s).`);
  }

  function hasDomTextSelection() {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && String(selection).trim() !== "");
  }

  // Channel clipboard/reorder shortcuts only apply in the channel view, with
  // no modal open and no cell editor (or other field) focused. Copy/cut also
  // defer to a regular DOM text selection (e.g. copying Debug Output text).
  function channelShortcutsActive(event, { respectTextSelection = false } = {}) {
    if (currentEditorView !== "channels") {
      return false;
    }
    if (isPrzemiennikiModalOpen()) {
      return false;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, select, textarea, [contenteditable='true'], [contenteditable='']")
    ) {
      return false;
    }
    if (respectTextSelection && hasDomTextSelection()) {
      return false;
    }
    return true;
  }

  // Serialize the explicitly selected rows (never the select-nothing-means-
  // all-rows fallback: cut would otherwise silently delete every channel).
  function selectedChannelTsv(actionLabel) {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      setStatus(`Select one or more channels to ${actionLabel}.`);
      return null;
    }
    const rows = selectedIndexes.map((idx) => currentRows[idx]);
    return {
      tsv: serializeRowsToTsv(rows),
      count: rows.length,
      rows,
    };
  }

  function copySelectedChannels(event) {
    const payload = selectedChannelTsv("copy");
    if (!payload) {
      return;
    }
    event.clipboardData.setData("text/plain", payload.tsv);
    event.preventDefault();
    setStatus(`Copied ${payload.count} channel(s) to clipboard.`);
  }

  function cutSelectedChannels(event) {
    const payload = selectedChannelTsv("cut");
    if (!payload) {
      return;
    }
    event.clipboardData.setData("text/plain", payload.tsv);
    event.preventDefault();
    const removed = removeChannelRows(payload.rows);
    setStatus(`Cut ${removed} channel(s) to clipboard.`);
  }

  async function writeChannelTsvToClipboard(actionLabel, remove) {
    const payload = selectedChannelTsv(actionLabel);
    if (!payload) {
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setStatus(`Clipboard write not available; press Ctrl+${remove ? "X" : "C"} / Cmd+${remove ? "X" : "C"} instead.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.tsv);
    } catch (error) {
      logDebug(`CLIPBOARD write failed: ${error}`);
      setStatus(`Clipboard write blocked; press Ctrl+${remove ? "X" : "C"} / Cmd+${remove ? "X" : "C"} instead.`);
      return;
    }
    if (remove) {
      // The write may have been parked behind a permission prompt; delete the
      // rows that were serialized, not whatever is selected now.
      const removed = removeChannelRows(payload.rows);
      setStatus(`Cut ${removed} channel(s) to clipboard.`);
    } else {
      setStatus(`Copied ${payload.count} channel(s) to clipboard.`);
    }
  }

  // Paste-overwrite starting at the first selected row (CHIRP desktop
  // semantics): pasted rows replace existing rows downward, extend the list
  // past the end, and require confirmation when non-empty rows would be
  // overwritten. With no selection, pasted rows append at the end.
  function pasteChannelsFromText(text) {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }
    if (!looksLikeChannelTsv(text)) {
      setStatus("Clipboard does not contain tab-separated channel data.");
      return;
    }
    const built = buildRowsFromClipboardText(text, {
      createBlankRow: createBlankChannelRow,
      setRowValue: setRowValueIfPresent,
    });
    const rows = built?.rows ?? [];
    if (rows.length === 0) {
      setStatus("No channels found in pasted text.");
      return;
    }
    const selectedIndexes = sortedSelectedRowIndexes();
    const startAt = selectedIndexes.length > 0 ? selectedIndexes[0] : currentRows.length;
    const overwriteLocations = [];
    for (let offset = 0; offset < rows.length && startAt + offset < currentRows.length; offset += 1) {
      const target = currentRows[startAt + offset];
      if (rowLooksNonEmpty(target)) {
        overwriteLocations.push(String(target.Location ?? startAt + offset));
      }
    }
    if (overwriteLocations.length > 0) {
      const summary =
        overwriteLocations.length === 1
          ? `channel ${overwriteLocations[0]}`
          : overwriteLocations.length > 10
            ? `${overwriteLocations.length} existing channels`
            : `channels ${overwriteLocations.join(", ")}`;
      if (!window.confirm(`Pasted channels will overwrite ${summary}. Continue?`)) {
        setStatus("Paste cancelled.");
        return;
      }
    }
    rows.forEach((row, offset) => {
      const at = startAt + offset;
      if (at < currentRows.length) {
        currentRows[at] = row;
      } else {
        currentRows.push(row);
      }
    });
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(rows.map((_, offset) => startAt + offset));
    selectionAnchorIndex = startAt;
    renderTable();
    setStatus(`Pasted ${rows.length} channel(s) at channel ${startAt}.`);
  }

  async function pasteChannelsViaApi() {
    if (!navigator.clipboard?.readText) {
      setStatus("Clipboard read not available; press Ctrl+V / Cmd+V in the channel view instead.");
      return;
    }
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (error) {
      logDebug(`CLIPBOARD read failed: ${error}`);
      setStatus("Clipboard read blocked; press Ctrl+V / Cmd+V in the channel view instead.");
      return;
    }
    pasteChannelsFromText(text);
  }

  // Move each selected row by one position, preserving relative order and
  // clamping at the edges; Location renumbers to match the new order.
  function moveSelectedChannelRows(direction) {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      setStatus("Select one or more channels to move.");
      return;
    }
    const { order, selected, moved } = computeMovedRowOrder(
      currentRows.length,
      selectedIndexes,
      direction,
    );
    if (!moved) {
      setStatus(
        direction < 0
          ? "Selected channels are already at the top."
          : "Selected channels are already at the bottom.",
      );
      return;
    }
    currentRows = order.map((idx) => currentRows[idx]);
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(selected);
    selectionAnchorIndex = direction < 0 ? Math.min(...selected) : Math.max(...selected);
    renderTable();
    setStatus(`Moved ${selected.length} channel(s) ${direction < 0 ? "up" : "down"}.`);
  }

  // Create a table cell editor (input/select) based on CHIRP column metadata.
  function createCellEditor(row, rowIdx, column) {
    const meta = radioMetadata.columns?.[column] || {};
    const current = String(row[column] ?? "");
    const readOnly = column === "Location" || meta.editable === false;

    // Grey out read-only cells and explain why; Location is excluded because
    // its button is the row-selection handle, not a disabled editor.
    function markReadOnly(editor) {
      if (readOnly && column !== "Location") {
        editor.classList.add("readonly-cell");
        editor.title = `${column} is read-only for this radio.`;
      }
      return editor;
    }
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
      return markReadOnly(select);
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
    return markReadOnly(input);
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
      // Mirror the cell treatment: grey + tooltip on headers of columns the
      // selected radio marks read-only (Location stays the selection handle).
      const meta = radioMetadata.columns?.[column] || {};
      if (meta.editable === false && column !== "Location") {
        th.classList.add("readonly-cell");
        th.title = `${column} is read-only for this radio.`;
      }
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
  async function loadSelectedRadioMetadata(loadToken = nextRadioLoadToken()) {
    if (!selectedRadio) {
      return;
    }
    const meta = await requireRuntimeApi().getRadioMetadata({
      module: selectedRadio.module,
      className: selectedRadio.className,
    });
    if (isStaleRadioLoad(loadToken)) {
      return;
    }
    radioMetadata = meta || { headers: [], columns: {} };
    currentHeaders = radioMetadata.headers?.length ? radioMetadata.headers : currentHeaders;
  }

  async function loadSelectedRadioSettings(options = {}) {
    const loadToken = options.loadToken ?? nextRadioLoadToken();
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

    if (isStaleRadioLoad(loadToken)) {
      return;
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
  async function parseCsvViaRuntime(csvText) {
    setStatus("Parsing CSV with CHIRP Python...");
    return requireRuntimeApi().parseCsv({ csvText });
  }

  // Apply a parsed CSV to the editor: "replace" swaps the channel list out
  // wholesale (Locations come from the file); "merge" appends the imported
  // channels below the existing ones and renumbers Locations.
  function applyParsedCsv(parsed, mode = "replace") {
    const headersFromMeta = radioMetadata.headers || [];
    const parsedHeaders = parsed.headers || [];
    currentHeaders = headersFromMeta.length ? headersFromMeta : parsedHeaders;
    const imported = parsed.rows || [];
    if (mode === "merge") {
      currentRows = currentRows.concat(imported);
      reindexLocationColumn();
    } else {
      currentRows = imported;
    }
    clearInvalidHighlights();
    resetRowSelection();
    renderTable();

    const issues = parsed.errors.length
      ? ` (${parsed.errors.length} parse warnings)`
      : "";
    if (mode === "merge") {
      setStatus(`Merged ${imported.length} imported channel(s); ${currentRows.length} total${issues}.`);
    } else {
      setStatus(`Loaded ${currentRows.length} channel(s)${issues}.`);
    }
  }

  async function loadCsvText(csvText) {
    applyParsedCsv(await parseCsvViaRuntime(csvText), "replace");
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
    const fileName = buildExportFileName(
      selectedRadio?.vendor || "webchirp",
      selectedRadio?.model || "export",
      "csv",
    );
    downloadText(fileName, csvText);
    setStatus(`Exported ${fileName}`);
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
    const fileName = buildExportFileName(
      result.vendor || selectedRadio.vendor,
      result.model || selectedRadio.model,
      "img",
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
    channelMoveUpEl?.addEventListener("click", () => {
      moveSelectedChannelRows(-1);
    });
    channelMoveDownEl?.addEventListener("click", () => {
      moveSelectedChannelRows(1);
    });
    channelMenuToggleEl?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleChannelMenu();
    });
    channelCopyEl?.addEventListener("click", async () => {
      setChannelMenuOpen(false);
      await writeChannelTsvToClipboard("copy", false);
    });
    channelCutEl?.addEventListener("click", async () => {
      setChannelMenuOpen(false);
      await writeChannelTsvToClipboard("cut", true);
    });
    channelPasteEl?.addEventListener("click", async () => {
      setChannelMenuOpen(false);
      await pasteChannelsViaApi();
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
    importChoiceReplaceEl?.addEventListener("click", () => {
      resolveImportChoice("replace");
    });
    importChoiceMergeEl?.addEventListener("click", () => {
      resolveImportChoice("merge");
    });
    importChoiceCancelEl?.addEventListener("click", () => {
      resolveImportChoice("cancel");
    });
    importChoiceModalEl?.addEventListener("click", (event) => {
      if (event.target === importChoiceModalEl) {
        resolveImportChoice("cancel");
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
        if (isImportChoiceModalOpen()) {
          resolveImportChoice("cancel");
          return;
        }
        if (isPrzemiennikiModalOpen()) {
          setPrzemiennikiModalOpen(false);
          return;
        }
        setChannelMenuOpen(false);
        return;
      }
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        if (!channelShortcutsActive(event)) {
          return;
        }
        event.preventDefault();
        moveSelectedChannelRows(event.key === "ArrowUp" ? -1 : 1);
      }
    });

    // Ctrl/Cmd+C, X, V arrive as native clipboard events, which supply
    // clipboardData synchronously and need no permission prompt (unlike the
    // async navigator.clipboard API used by the menu items). The guard defers
    // to normal browser behavior inside inputs/selects and text selections.
    document.addEventListener("copy", (event) => {
      if (!channelShortcutsActive(event, { respectTextSelection: true })) {
        return;
      }
      copySelectedChannels(event);
    });

    document.addEventListener("cut", (event) => {
      if (!channelShortcutsActive(event, { respectTextSelection: true })) {
        return;
      }
      cutSelectedChannels(event);
    });

    document.addEventListener("paste", (event) => {
      if (!channelShortcutsActive(event)) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      pasteChannelsFromText(text);
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
        const parsed = await parseCsvViaRuntime(csvText);
        let mode = "replace";
        if (hasRealChannels()) {
          const choice = await askImportChoice(
            `The editor holds ${currentRows.length} channel(s) that will be lost if replaced. `
            + `The selected file contains ${(parsed.rows || []).length} channel(s). `
            + "Replace the existing channels, or merge by appending the imported channels below them?",
          );
          if (choice === "cancel") {
            setStatus("CSV import cancelled.");
            return;
          }
          mode = choice;
        }
        applyParsedCsv(parsed, mode);
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

    // Typing opens an autocomplete list of "<Make> <Model>" suggestions; the
    // (Pyodide-backed) metadata/settings load only happens once the user picks
    // a suggestion via keyboard or mouse.
    radioSearchEl?.addEventListener("input", () => {
      renderRadioSearchResults();
    });

    radioSearchEl?.addEventListener("focus", () => {
      renderRadioSearchResults();
    });

    radioSearchEl?.addEventListener("keydown", (event) => {
      const isOpen = radioSearchResultsEl && !radioSearchResultsEl.hidden;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen) {
          renderRadioSearchResults();
          return;
        }
        moveRadioSearchActive(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        if (isOpen && radioSearchActiveIndex >= 0) {
          event.preventDefault();
          applyRadioSearchSelection(radioSearchMatches[radioSearchActiveIndex]);
        }
      } else if (event.key === "Escape") {
        if (isOpen) {
          event.stopPropagation();
          hideRadioSearchResults();
        }
      }
    });

    radioSearchEl?.addEventListener("blur", () => {
      // Delay so a click on a suggestion (which blurs the input) still lands.
      setTimeout(() => hideRadioSearchResults(), 150);
    });

    radioSearchResultsEl?.addEventListener("mousedown", (event) => {
      // Prevent the input blur so the click handler below sees the list open.
      event.preventDefault();
      const li = event.target.closest("li[role='option']");
      if (!li) {
        return;
      }
      const index = Number(li.dataset.index);
      applyRadioSearchSelection(radioSearchMatches[index]);
    });

    radioMakeEl.addEventListener("change", () => {
      refreshModelOptions();
      reloadForSelectedRadio();
    });

    radioModelEl.addEventListener("change", () => {
      const key = radioModelEl.value;
      selectedRadio = radioCatalog.find((r) => r.key === key) || null;
      if (selectedRadio) {
        logDebug(
          `RADIO SELECT ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
        );
      }
      reloadForSelectedRadio();
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

    serialConnectToggleEl?.addEventListener("click", () => {
      if (serialConnected) {
        disconnectSerial();
      } else {
        connectSerial("auto");
      }
    });

    webusbConnectToggleEl?.addEventListener("click", () => {
      if (serialConnected) {
        disconnectSerial();
      } else {
        connectSerial("webusb");
      }
    });


    document.querySelector("#serial-transaction")?.addEventListener("click", async () => {
      const txHex = document.querySelector("#tx-hex")?.value || "";
      const rxBytes = Number(document.querySelector("#rx-bytes")?.value || 32);
      const timeoutMs = Number(document.querySelector("#rx-timeout")?.value || 1200);

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

    document.querySelector("#debug-copy")?.addEventListener("click", async () => {
      const text = debugOutputEl.value || "";
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // Fallback for browsers/contexts without the async clipboard API.
          debugOutputEl.focus();
          debugOutputEl.select();
          document.execCommand("copy");
        }
        setStatus("Debug log copied to clipboard.");
      } catch {
        // Last resort: select the text so the user can copy manually.
        debugOutputEl.focus();
        debugOutputEl.select();
        setStatus("Could not copy automatically; log text is selected — copy it manually.");
      }
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
        trackRadioEvent("radio_download", selectedRadio);
        setStatus(`Downloading from ${makeModelLabel(selectedRadio)}...`);
        beginCloneProgress(`Downloading from ${makeModelLabel(selectedRadio)}...`);
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
      } finally {
        endCloneProgress();
      }
    });

    document.querySelector("#radio-upload").addEventListener("click", async () => {
      if (!selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        trackRadioEvent("radio_upload", selectedRadio);
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
        beginCloneProgress(`Uploading to ${makeModelLabel(selectedRadio)}...`);
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
      } finally {
        endCloneProgress();
      }
    });
  }

  // Bootstrap UI: capability checks, catalog load, metadata load, sample data.
  async function init(serialSupported) {
    bindEvents();
    refreshSerialConnectToggleLabel();
    setSerialSupportWarningVisible(!serialSupported);
    setSidebarControlsEnabled(false);
    setRadioSelectPlaceholder("Loading...");
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
      setRadioSelectPlaceholder("Unavailable");
      reportActionError("Initialization", error);
      setStatus("Initialization failed; sidebar controls remain disabled.");
    }
  }

  return {
    setRuntimeApi,
    setSerialController,
    setStatus,
    logSerial,
    logDebug,
    updateCloneProgress,
    init,
    selectedRowsForOperations,
    onRuntimeCrash(message) {
      logDebug(`RUNTIME CRASH ${message}`);
    },
  };
}

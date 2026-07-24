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
import {
  base64ToBytes,
  buildExportFileName,
  bytesToBase64,
  countryDisplayName,
  detectBrowserVersion,
  detectOperatingSystem,
  errorDetails,
  errorSummary,
  flagEmojiFromCountryCode,
  isAndroidPlatform,
  makeModelLabel,
} from "./ui/format.js";
import { normalizeValue } from "./ui/channel-values.js";
import { queryUiElements } from "./ui/dom.js";
import {
  createUiState,
  exposeCurrentRowsForDebugging,
  isStaleRadioLoad,
  nextRadioLoadToken,
  requireRuntimeApi,
} from "./ui/state.js";
import { createDebugLog } from "./ui/debug-log.js";
import { createIssueReporter } from "./ui/issue-report.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { createChannelTable } from "./ui/channel-table.js";
import { createRadioCatalog } from "./ui/radio-catalog.js";

// Re-exported so existing importers (and tests) keep a stable entry point.
export { buildExportFileName };

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

// Create and manage all DOM/UI state and user interaction behavior.
export function createUiController() {
  const dom = queryUiElements();
  const state = createUiState();
  const log = createDebugLog({ dom });
  const issueReporter = createIssueReporter({ dom, state, log });
  // Late-bound so modules can call across to each other without import cycles;
  // every entry is resolved at call time, not at construction.
  const actions = {
    updateSerialActionState: () => updateSerialActionState(),
    setEditorView: (view) => setEditorView(view),
    isRepeaterModalOpen: () => isPrzemiennikiModalOpen(),
  };
  // Modules are hung off one context object so siblings can call each other
  // through it; every such call happens after construction, so the forward
  // references below are resolved by the time they run.
  const ctx = { dom, state, log, actions };
  const settings = createSettingsPanel(ctx);
  const table = createChannelTable(ctx);
  const catalog = createRadioCatalog(ctx);
  Object.assign(ctx, { settings, table, catalog });

  const {
    tableHead,
    tableBody,
    channelEditorEl,
    settingsEditorEl,
    viewChannelsEl,
    viewSettingsEl,
    settingsTabsEl,
    settingsSummaryEl,
    settingsEmptyEl,
    settingsContentEl,
    fileInput,
    imgFileInput,
    debugOutputEl,
    reportIssueEl,
    serialSupportWarningEl,
    liveRadioSupportWarningEl,
    radioSearchEl,
    radioSearchResultsEl,
    radioMakeEl,
    radioModelEl,
    serialConnectToggleEl,
    webusbConnectToggleEl,
    radioDownloadEl,
    radioUploadEl,
    cloneProgressEl,
    cloneProgressBarEl,
    cloneProgressLabelEl,
    cloneProgressPercentEl,
    channelInsertEl,
    channelRemoveEl,
    channelMoveUpEl,
    channelMoveDownEl,
    channelCopyEl,
    channelCutEl,
    channelPasteEl,
    channelMenuToggleEl,
    channelMenuPopupEl,
    channelAddGmrsEl,
    channelAddFrsEl,
    channelAddPmr446El,
    channelImportPrzemiennikiEl,
    channelImportRepeaterbookEl,
    przemiennikiModalEl,
    przemiennikiFormEl,
    przemiennikiModalTitleEl,
    przemiennikiCountryEl,
    przemiennikiBandListEl,
    przemiennikiModeListEl,
    przemiennikiOnlyWorkingEl,
    przemiennikiLatitudeEl,
    przemiennikiLongitudeEl,
    przemiennikiRangeEl,
    przemiennikiGeolocateEl,
    przemiennikiCancelEl,
    importChoiceModalEl,
    importChoiceMessageEl,
    importChoiceReplaceEl,
    importChoiceMergeEl,
    importChoiceCancelEl,
    sidebarControlEls,
  } = dom;

  const { logDebug, logSerial, setStatus, reportActionError } = log;

  let serialTransportController = null;
  let serialCapability = { supported: false, native: false, webusb: false };
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

  exposeCurrentRowsForDebugging(state);

  function setRuntimeApi(api) {
    state.runtimeApi = api;
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
      const baudRate = Number(state.selectedRadio?.baudRate || 9600);
      setStatus(`Connecting serial${preferredTransport === "webusb" ? " via WebUSB" : ""}...`);
      const result = await requireRuntimeApi(state).serialConnect({ baudRate });
      serialConnected = Boolean(result?.connected);
      if (result?.deviceName) {
        logDebug(`SERIAL DEVICE ${result.deviceName}`);
      }
      serialTransport = result?.transport || "";
      if (result?.transport) {
        logSerial(`Transport: ${result.transport}`);
      }
      if (result?.usbVendorId) {
        state.lastUsbVendorId = result.usbVendorId;
      }
      if (result?.usbProductId) {
        state.lastUsbProductId = result.usbProductId;
      }
      if (state.lastUsbVendorId || state.lastUsbProductId) {
        logDebug(`SERIAL USB ID ${state.lastUsbVendorId || "unknown"}:${state.lastUsbProductId || "unknown"}`);
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
      const result = await requireRuntimeApi(state).serialDisconnect();
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

  function currentViewLabel() {
    return state.currentEditorView === "settings" ? "radio settings" : "channels";
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

  function setEditorView(nextView) {
    state.currentEditorView = nextView === "settings" ? "settings" : "channels";
    const channelsActive = state.currentEditorView === "channels";
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

  function selectedRadioIsLiveMode() {
    return Boolean(state.selectedRadio?.isLiveRadio);
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

    radioUploadEl.disabled = !actionsAllowed || settings.hasInvalidSettings();
    if (liveRadioUnsupported) {
      radioUploadEl.title = "Live-mode radios are not supported in this UI yet";
      return;
    }
    radioUploadEl.title = settings.hasInvalidSettings()
      ? "Fix invalid radio settings before upload"
      : "";
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

  async function openRepeaterQueryModal(sourceKey) {
    if (!repeaterQueryEnabled) {
      return;
    }
    setActiveRepeaterQuerySource(sourceKey);
    const source = activeRepeaterSourceConfig();
    table.setMenuOpen(false);
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
    if (!state.currentHeaders.length) {
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
    const rowsToInsert = buildPrzemiennikiRows(parsed.repeaters, table.rowBuilderHooks());
    table.insertRowsAtSelectionOrEnd(rowsToInsert, source.insertLabel);
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

  // Parse CSV through Python runtime and refresh table rows and status text.
  async function parseCsvViaRuntime(csvText) {
    setStatus("Parsing CSV with CHIRP Python...");
    return requireRuntimeApi(state).parseCsv({ csvText });
  }

  // Apply a parsed CSV to the editor: "replace" swaps the channel list out
  // wholesale (Locations come from the file); "merge" appends the imported
  // channels below the existing ones and renumbers Locations.
  function applyParsedCsv(parsed, mode = "replace") {
    const headersFromMeta = state.radioMetadata.headers || [];
    const parsedHeaders = parsed.headers || [];
    state.currentHeaders = headersFromMeta.length ? headersFromMeta : parsedHeaders;
    const imported = parsed.rows || [];
    if (mode === "merge") {
      state.currentRows = state.currentRows.concat(imported);
      table.reindexLocationColumn();
    } else {
      state.currentRows = imported;
    }
    table.clearInvalidHighlights();
    table.resetRowSelection();
    table.render();

    const issues = parsed.errors.length
      ? ` (${parsed.errors.length} parse warnings)`
      : "";
    if (mode === "merge") {
      setStatus(`Merged ${imported.length} imported channel(s); ${state.currentRows.length} total${issues}.`);
    } else {
      setStatus(`Loaded ${state.currentRows.length} channel(s)${issues}.`);
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
    const csvText = await requireRuntimeApi(state).normalizeRows({
      rows: state.currentRows,
      module: state.selectedRadio?.module || "",
      className: state.selectedRadio?.className || "",
    });
    const fileName = buildExportFileName(
      state.selectedRadio?.vendor || "webchirp",
      state.selectedRadio?.model || "export",
      "csv",
    );
    downloadText(fileName, csvText);
    setStatus(`Exported ${fileName}`);
  }

  async function exportBinaryCodeplug() {
    if (!state.selectedRadio) {
      setStatus("Select a radio make/model first.");
      return;
    }
    setStatus("Preparing CHIRP binary codeplug...");
    const result = await requireRuntimeApi(state).exportImage({
      module: state.selectedRadio.module,
      className: state.selectedRadio.className,
      rows: state.currentRows,
      settings: settings.getGroups(),
    });
    settings.setGroups(result.settings);
    settings.render();
    const bytes = base64ToBytes(result.imageBase64 || "");
    const fileName = buildExportFileName(
      result.vendor || state.selectedRadio.vendor,
      result.model || state.selectedRadio.model,
      "img",
    );
    downloadBytes(fileName, bytes);
    setStatus(`Exported ${fileName}`);
  }

  async function importBinaryCodeplug(file) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const imageBase64 = bytesToBase64(raw);
    setStatus("Loading CHIRP binary codeplug...");
    const loaded = await requireRuntimeApi(state).loadImage({ imageBase64 });
    const selected = catalog.selectRadioByDetectedImage(loaded);
    if (!selected) {
      throw new Error(
        `Loaded image radio ${loaded.module}.${loaded.className} is not available in current radio catalog`,
      );
    }
    await catalog.loadSelectedRadioMetadata();
    settings.replaceState({
      supported: Array.isArray(loaded.settings) && loaded.settings.length > 0,
      available: Array.isArray(loaded.settings) && loaded.settings.length > 0,
      requiresImage: false,
      message: "",
      groups: settings.cloneGroups(loaded.settings || []),
    });
    settings.clearInvalid();
    state.currentHeaders = state.radioMetadata.headers?.length
      ? state.radioMetadata.headers
      : (loaded.headers || state.currentHeaders);
    state.currentRows = Array.isArray(loaded.rows) ? loaded.rows : [];
    table.clearInvalidHighlights();
    table.resetRowSelection();
    table.render();
    settings.updateViewButtons();
    settings.render();
    setStatus(
      `Loaded binary codeplug for ${loaded.vendor || state.selectedRadio.vendor} ${loaded.model || state.selectedRadio.model}.`,
    );
  }

  async function runUploadPreflight() {
    if (!state.selectedRadio) {
      return { valid: false, issues: [{ rowIndex: -1, column: "", message: "No radio selected." }] };
    }
    const [rowResult, settingsResult] = await Promise.all([
      requireRuntimeApi(state).validateRowsForUpload({
        rows: state.currentRows,
        module: state.selectedRadio.module,
        className: state.selectedRadio.className,
      }),
      requireRuntimeApi(state).validateRadioSettings({
        settings: settings.getGroups(),
        module: state.selectedRadio.module,
        className: state.selectedRadio.className,
      }),
    ]);
    const result = rowResult;
    const settingsValidation = settingsResult || { valid: true, issues: [], settings: settings.getGroups() };
    settings.setGroups(settingsValidation.settings);
    settings.ensureActiveTab();
    settings.clearInvalid();
    settings.applyValidationIssues(settingsValidation.issues);
    settings.updateSummary();
    table.clearInvalidHighlights();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    table.applyValidationIssues(issues);
    if (issues.length > 0) {
      table.render();
    }
    settings.render();
    return {
      valid: Boolean(result?.valid) && Boolean(settingsValidation?.valid) && settings.invalidCount() === 0,
      issues: [...issues, ...(settingsValidation.issues || [])],
    };
  }

  // Register all UI event handlers and action bindings.
  function bindEvents() {
    table.bindEvents();
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
        table.setMenuOpen(false);
        return;
      }
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        if (!table.channelShortcutsActive(event)) {
          return;
        }
        event.preventDefault();
        table.moveSelectedChannelRows(event.key === "ArrowUp" ? -1 : 1);
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
        const parsed = await parseCsvViaRuntime(csvText);
        let mode = "replace";
        if (table.hasRealChannels()) {
          const choice = await askImportChoice(
            `The editor holds ${state.currentRows.length} channel(s) that will be lost if replaced. `
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

    catalog.bindEvents();

    viewChannelsEl?.addEventListener("click", () => {
      setEditorView("channels");
    });

    viewSettingsEl?.addEventListener("click", () => {
      if (!settings.radioHasSettings()) {
        setStatus(settings.settingsUnavailableMessage());
        return;
      }
      setEditorView("settings");
      settings.render();
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
        const result = await requireRuntimeApi(state).serialTxRx({ txHex, rxBytes, timeoutMs });
        setStatus("Python serial transaction complete.");
        logSerial(`PY TX ${result.tx.hex} | PY RX ${result.rx.hex || "<none>"}`);
      } catch (error) {
        reportActionError("Serial transaction", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#debug-clear").addEventListener("click", () => {
      log.clear();
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
      issueReporter.openPrefilledIssue();
    });

    window.addEventListener("error", (event) => {
      logDebug(`WINDOW ERROR ${event.message}`);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const msg = event.reason?.message || String(event.reason || "Unhandled rejection");
      logDebug(`PROMISE ERROR ${msg}`);
    });

    document.querySelector("#radio-download").addEventListener("click", async () => {
      if (!state.selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        trackRadioEvent("radio_download", state.selectedRadio);
        setStatus(`Downloading from ${makeModelLabel(state.selectedRadio)}...`);
        beginCloneProgress(`Downloading from ${makeModelLabel(state.selectedRadio)}...`);
        const result = await requireRuntimeApi(state).downloadSelectedRadio({
          module: state.selectedRadio.module,
          className: state.selectedRadio.className,
        });
        state.currentHeaders = state.radioMetadata.headers?.length
          ? state.radioMetadata.headers
          : (result.headers || []);
        state.currentRows = result.rows;
        settings.replaceState({
          supported: Array.isArray(result.settings) && result.settings.length > 0,
          available: Array.isArray(result.settings) && result.settings.length > 0,
          requiresImage: false,
          message: "",
          groups: settings.cloneGroups(result.settings || []),
        });
        table.clearInvalidHighlights();
        settings.clearInvalid();
        table.resetRowSelection();
        table.render();
        settings.updateViewButtons();
        settings.render();
        setStatus(`${makeModelLabel(state.selectedRadio)} download complete (${state.currentRows.length} channels).`);
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
      if (!state.selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        trackRadioEvent("radio_upload", state.selectedRadio);
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
        setStatus(`Uploading to ${makeModelLabel(state.selectedRadio)}...`);
        beginCloneProgress(`Uploading to ${makeModelLabel(state.selectedRadio)}...`);
        const uploadResult = await requireRuntimeApi(state).uploadSelectedRadio({
          module: state.selectedRadio.module,
          className: state.selectedRadio.className,
          rows: state.currentRows,
          settings: settings.getGroups(),
        });
        settings.setGroups(uploadResult.settings);
        settings.clearInvalid();
        settings.render();
        setStatus(`${makeModelLabel(state.selectedRadio)} upload complete.`);
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
    catalog.setRadioSelectPlaceholder("Loading...");
    try {
      if (!serialSupported) {
        logSerial("Web Serial unsupported in this browser.");
      } else {
        logSerial("Web Serial available.");
      }
      const catalogResponse = await requireRuntimeApi(state).listRadios();
      state.radioCatalog = catalogResponse.radios || [];
      state.runtimeInfo = (await requireRuntimeApi(state).getRuntimeInfo()) || state.runtimeInfo;
      catalog.refreshMakeOptions();
      catalog.restoreSelectedRadioCookie();
      await catalog.loadSelectedRadioMetadata();
      await settings.load();
      setStatus(`Loaded ${state.radioCatalog.length} radio definitions from CHIRP sources.`);
      await loadCsvText(DEFAULT_SAMPLE_CSV);
      settings.render();
      setSidebarControlsEnabled(true);
    } catch (error) {
      catalog.setRadioSelectPlaceholder("Unavailable");
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
    selectedRowsForOperations: table.selectedRowsForOperations,
    onRuntimeCrash(message) {
      logDebug(`RUNTIME CRASH ${message}`);
    },
  };
}

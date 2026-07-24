import {
  base64ToBytes,
  buildExportFileName,
  bytesToBase64,
  errorSummary,
  isAndroidPlatform,
  makeModelLabel,
} from "./ui/format.js";
import { queryUiElements } from "./ui/dom.js";
import {
  createUiState,
  exposeCurrentRowsForDebugging,
  requireRuntimeApi,
} from "./ui/state.js";
import { createDebugLog } from "./ui/debug-log.js";
import { createIssueReporter } from "./ui/issue-report.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { createChannelTable } from "./ui/channel-table.js";
import { createRadioCatalog } from "./ui/radio-catalog.js";
import { createRepeaterQuery } from "./ui/repeater-query.js";

// Re-exported so existing importers (and tests) keep a stable entry point.
export { buildExportFileName };

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
    isRepeaterModalOpen: () => ctx.repeaterQuery.isModalOpen(),
  };
  // Modules are hung off one context object so siblings can call each other
  // through it; every such call happens after construction, so the forward
  // references below are resolved by the time they run.
  const ctx = { dom, state, log, actions };
  const settings = createSettingsPanel(ctx);
  const table = createChannelTable(ctx);
  const catalog = createRadioCatalog(ctx);
  const repeaterQuery = createRepeaterQuery(ctx);
  Object.assign(ctx, { settings, table, catalog, repeaterQuery });

  const {
    channelEditorEl,
    settingsEditorEl,
    viewChannelsEl,
    viewSettingsEl,
    fileInput,
    imgFileInput,
    debugOutputEl,
    reportIssueEl,
    serialSupportWarningEl,
    liveRadioSupportWarningEl,
    serialConnectToggleEl,
    webusbConnectToggleEl,
    radioDownloadEl,
    radioUploadEl,
    cloneProgressEl,
    cloneProgressBarEl,
    cloneProgressLabelEl,
    cloneProgressPercentEl,
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
  let sidebarControlsEnabled = false;
  let serialConnected = false;
  let importChoiceResolve = null;
  // Transport of the active connection ("webserial" or "webusb"), used to
  // collapse the two connect toggles to a single Disconnect button when both
  // are visible (Android).
  let serialTransport = "";

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
    repeaterQuery.bindEvents();
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
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (isImportChoiceModalOpen()) {
          resolveImportChoice("cancel");
          return;
        }
        if (repeaterQuery.isModalOpen()) {
          repeaterQuery.setModalOpen(false);
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

import {
  errorSummary,
  isAndroidPlatform,
  isIosPlatform,
  makeModelLabel,
  undecodedChannelsNote,
} from "./format.js";
import {
  classifyErrorKind,
  codeplugParams,
  errorTypeName,
  firstIssueColumn,
  radioEventParams,
  trackEvent,
} from "./analytics.js";
import {
  PORT_SELECTION_CANCELLED_MESSAGE,
  isPortSelectionCancelled,
} from "../serial-errors.js";
import { requireRuntimeApi } from "./state.js";

const LIVE_RADIO_TITLE = "Live-mode radios are not supported in this UI yet";
const NO_RADIO_SELECTED_TITLE = "Search for and select a radio first";

// Everything on the serial path: connect/disconnect over Web Serial or WebUSB,
// the enabled/visible state of the sidebar's radio actions, the clone progress
// bar, and the download/upload clone operations with their preflight. Owns the
// connection and capability state.
export function createSerialActions(ctx) {
  const { dom, state, log, actions } = ctx;

  let transportController = null;
  let capability = { supported: false, native: false, webusb: false };
  let sidebarControlsEnabled = false;
  let connected = false;
  // Transport of the active connection ("webserial" or "webusb"), used to
  // collapse the two connect toggles to a single Disconnect button when both
  // are visible (Android).
  let transport = "";

  // Wire the serial bridge's transport controls (capability + forced transport)
  // so the UI can offer an explicit WebUSB connect path.
  function setSerialController(controller) {
    transportController = controller || null;
    capability = controller?.capability || capability;
    updateSerialActionState();
  }

  function setSerialButtonsBusy(busy) {
    dom.serialConnectToggleEl.disabled = busy;
    dom.webusbConnectToggleEl.disabled = busy;
  }

  // Connect using the requested transport ("auto" or "webusb").
  async function connectSerial(preferredTransport) {
    if (connected) {
      return;
    }
    transportController?.setPreferredTransport(preferredTransport);
    setSerialButtonsBusy(true);
    try {
      const baudRate = Number(state.selectedRadio?.baudRate || 9600);
      log.setStatus(`Connecting serial${preferredTransport === "webusb" ? " via WebUSB" : ""}...`);
      const result = await requireRuntimeApi(state).serialConnect({ baudRate });
      connected = Boolean(result?.connected);
      if (result?.deviceName) {
        log.logDebug(`SERIAL DEVICE ${result.deviceName}`);
      }
      transport = result?.transport || "";
      if (result?.transport) {
        log.logSerial(`Transport: ${result.transport}`);
      }
      if (result?.usbVendorId) {
        state.lastUsbVendorId = result.usbVendorId;
      }
      if (result?.usbProductId) {
        state.lastUsbProductId = result.usbProductId;
      }
      if (state.lastUsbVendorId || state.lastUsbProductId) {
        log.logDebug(`SERIAL USB ID ${state.lastUsbVendorId || "unknown"}:${state.lastUsbProductId || "unknown"}`);
      }
      log.setStatus(result.message || "Serial connected.");
      trackEvent("serial_connected", {
        ...radioEventParams(state.selectedRadio),
        transport: transport || "unknown",
      });
    } catch (error) {
      // A user who closes the browser's port picker lands here too; error_kind
      // separates that from an adapter the browser could not open.
      trackEvent("serial_connect_failed", {
        ...radioEventParams(state.selectedRadio),
        error_kind: classifyErrorKind(error),
        error_type: errorTypeName(error),
      });
      // Dismissing the chooser is the one outcome here the user already knows
      // about, so it gets a sentence rather than the Pyodide traceback the
      // failure path dumps. It still has to be said out loud: with no visible
      // status surface in this app, saying nothing left Connect-then-Cancel
      // looking exactly like a button that does not work.
      if (isPortSelectionCancelled(error)) {
        log.reportActionCancelled("Serial connect", PORT_SELECTION_CANCELLED_MESSAGE);
        return;
      }
      log.reportActionError("Serial connect", error);
      log.logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      setSerialButtonsBusy(false);
      refreshSerialConnectToggleLabel();
      updateSerialActionState();
    }
  }

  async function disconnectSerial() {
    setSerialButtonsBusy(true);
    try {
      log.setStatus("Disconnecting serial...");
      const result = await requireRuntimeApi(state).serialDisconnect();
      connected = Boolean(result?.connected);
      if (!connected) {
        transport = "";
      }
      log.setStatus(result.message || "Serial disconnected.");
    } catch (error) {
      log.reportActionError("Serial disconnect", error);
      log.logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      setSerialButtonsBusy(false);
      refreshSerialConnectToggleLabel();
      updateSerialActionState();
    }
  }

  // The open port is gone: unplugged, powered down with the radio on cables
  // that draw from it, or refused when the bridge reopened it for a driver with
  // a different baud rate. The bridge has already torn the port down, so the
  // UI's job is to stop claiming there is a connection — otherwise
  // Download/Upload stay lit against a port that is gone.
  function handlePortLost(deviceName, reason) {
    if (!connected) {
      return;
    }
    const lostTransport = transport || "unknown";
    connected = false;
    transport = "";
    const cause = reason === "baud-rate-change"
      ? "Serial port closed while switching to the selected radio's baud rate"
      : "Serial port disconnected";
    log.setStatus(`${cause}; reconnect to continue.`);
    log.logSerial(`${cause}${deviceName ? ` (${deviceName})` : ""}.`);
    trackEvent("serial_port_lost", {
      ...radioEventParams(state.selectedRadio),
      transport: lostTransport,
    });
    refreshSerialConnectToggleLabel();
    updateSerialActionState();
  }

  function setSidebarControlsEnabled(enabled) {
    sidebarControlsEnabled = Boolean(enabled);
    for (const el of dom.sidebarControlEls) {
      el.disabled = !enabled;
    }
    updateSerialActionState();
  }

  // The unsupported-browser treatment is two synchronized pieces: the
  // explanation overlay and the greyscale on the app shell behind it. Toggle
  // them together so the page never ends up grey with no explanation (or the
  // reverse). `problems` picks which explanations the card shows — they are
  // independent, not variants: Safari lacks both serial transports AND WASM
  // stack switching, so both blocks appear there at once. iOS/iPadOS is the
  // exception: whatever the capability gap is there, it is the platform rather
  // than the browser choice, so its block replaces both generic ones instead
  // of telling people to install a browser that would be the same WebKit.
  function setBrowserUnsupportedOverlayVisible(visible, problems = { serial: true }) {
    const show = Boolean(visible);
    const iosShown = isIosPlatform();
    const serialShown = !iosShown && Boolean(problems.serial);
    const jspiShown = !iosShown && Boolean(problems.jspi);
    dom.unsupportedBrowserIosInfoEl.hidden = !iosShown;
    dom.unsupportedBrowserSerialInfoEl.hidden = !serialShown;
    dom.unsupportedBrowserJspiInfoEl.hidden = !jspiShown;
    // Label the dialog by the more fundamental problem when both apply.
    let labelledBy = "unsupported-browser-serial-title";
    if (iosShown) {
      labelledBy = "unsupported-browser-ios-title";
    } else if (jspiShown) {
      labelledBy = "unsupported-browser-jspi-title";
    }
    dom.unsupportedBrowserOverlayEl.setAttribute("aria-labelledby", labelledBy);
    dom.unsupportedBrowserOverlayEl.classList.toggle("hidden", !show);
    dom.appShellEl.classList.toggle("browser-unsupported", show);
  }

  function setLiveRadioSupportWarningVisible(visible) {
    dom.liveRadioSupportWarningEl.hidden = !visible;
  }

  function refreshSerialConnectToggleLabel() {
    // Mobile has no hover tooltips, so on Android the labels themselves say
    // what each transport is for.
    const mobile = isAndroidPlatform();
    dom.serialConnectToggleEl.textContent = connected
      ? "Disconnect"
      : (mobile ? "Connect via WebSerial (Bluetooth)" : "Connect via WebSerial");
    dom.webusbConnectToggleEl.textContent = connected
      ? "Disconnect"
      : (mobile ? "Connect via WebUSB (wired adapter)" : "Connect via WebUSB");
  }

  // Show the clone progress bar in its indeterminate state until the driver's
  // first status report arrives with real block counts.
  function beginCloneProgress(label) {
    dom.cloneProgressLabelEl.textContent = String(label || "Working...");
    dom.cloneProgressPercentEl.textContent = "";
    dom.cloneProgressBarEl.removeAttribute?.("value");
    dom.cloneProgressEl.hidden = false;
  }

  // CHIRP drivers report status once per transferred block (cur/max may be -1
  // when a driver reports no counts; the bar then stays indeterminate).
  function updateCloneProgress(cur, max, msg) {
    dom.cloneProgressEl.hidden = false;
    if (msg) {
      dom.cloneProgressLabelEl.textContent = msg;
    }
    if (Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur >= 0) {
      const percent = Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
      dom.cloneProgressBarEl.value = percent;
      dom.cloneProgressPercentEl.textContent = `${percent}%`;
    } else {
      // A no-count report must not leave the previous phase's percentage on
      // screen: removing value makes the <progress> bar indeterminate again.
      dom.cloneProgressBarEl.removeAttribute?.("value");
      dom.cloneProgressPercentEl.textContent = "";
    }
  }

  function endCloneProgress() {
    dom.cloneProgressEl.hidden = true;
  }

  function selectedRadioIsLiveMode() {
    return Boolean(state.selectedRadio?.isLiveRadio);
  }

  function updateSerialActionState() {
    const liveRadioUnsupported = selectedRadioIsLiveMode();
    // Radios are chosen by searching, so a fresh session has none selected and
    // every serial action has to explain that rather than act on nothing.
    const noRadioSelected = !state.selectedRadio;
    const actionsAllowed =
      sidebarControlsEnabled && !liveRadioUnsupported && !noRadioSelected;
    // Why the radio itself blocks these controls, if it does. Checked before
    // the connection state so the buttons name the first thing to fix.
    const selectionBlockedTitle = noRadioSelected
      ? NO_RADIO_SELECTED_TITLE
      : (liveRadioUnsupported ? LIVE_RADIO_TITLE : "");

    setLiveRadioSupportWarningVisible(liveRadioUnsupported);

    // Connect controls by platform capability:
    // - Desktop with native Web Serial: WebSerial toggle only.
    // - Android with native Web Serial (Bluetooth RFCOMM serial ports): both
    //   toggles — WebSerial for Bluetooth serial, WebUSB for wired USB
    //   adapters, which Android's native Web Serial cannot drive.
    // - WebUSB-only browsers (older Android Chrome): WebUSB toggle only.
    // - Neither API: the WebSerial toggle stays visible (disabled) alongside
    //   the unsupported-browser warning.
    const webusbOnly = capability.webusb && !capability.native;
    let showWebSerialToggle = !webusbOnly;
    let showWebUsbToggle =
      capability.webusb && (!capability.native || isAndroidPlatform());
    // While connected, collapse to a single Disconnect button on the toggle
    // matching the active transport.
    if (connected && showWebSerialToggle && showWebUsbToggle) {
      showWebUsbToggle = transport === "webusb";
      showWebSerialToggle = !showWebUsbToggle;
    }

    dom.serialConnectToggleEl.hidden = !showWebSerialToggle;
    dom.serialConnectToggleEl.disabled = !actionsAllowed;
    dom.serialConnectToggleEl.title = selectionBlockedTitle
      || (isAndroidPlatform()
        ? "Connect over native Web Serial, for use with Bluetooth serial ports"
        : "");

    dom.webusbConnectToggleEl.hidden = !showWebUsbToggle;
    dom.webusbConnectToggleEl.disabled = !actionsAllowed;
    dom.webusbConnectToggleEl.title = selectionBlockedTitle
      || "Connect over WebUSB, for use with FTDI, Prolific PL2303, "
        + "WCH CH340/CH341 or Silicon Labs CP2102 adapters";

    // Both clone operations talk to an open port, so neither is offered until
    // a port has been picked and opened through one of the connect buttons.
    const cloneAllowed = actionsAllowed && connected;
    const notConnectedTitle = "Connect to a serial port first";

    dom.radioDownloadEl.disabled = !cloneAllowed;
    dom.radioDownloadEl.title = selectionBlockedTitle
      || (connected ? "" : notConnectedTitle);

    dom.radioUploadEl.disabled = !cloneAllowed || ctx.settings.hasInvalidSettings();
    if (selectionBlockedTitle) {
      dom.radioUploadEl.title = selectionBlockedTitle;
      return;
    }
    if (!connected) {
      dom.radioUploadEl.title = notConnectedTitle;
      return;
    }
    dom.radioUploadEl.title = ctx.settings.hasInvalidSettings()
      ? "Fix invalid radio settings before upload"
      : "";
  }

  function trackRadioEvent(eventName, radio, params = {}) {
    if (!radio) {
      return;
    }
    trackEvent(eventName, { ...radioEventParams(radio), ...params });
  }

  // Report how a clone ended. The attempt events on their own only count who
  // pressed the button; pairing them with an outcome is what turns the reports
  // into a per-driver record of which radios actually work in the browser.
  function trackCloneOutcome(eventName, radio, startedAt, params = {}) {
    trackRadioEvent(eventName, radio, {
      duration_ms: Date.now() - startedAt,
      ...params,
    });
  }

  function cloneFailureParams(error, stage) {
    return {
      stage,
      error_kind: classifyErrorKind(error),
      error_type: errorTypeName(error),
    };
  }

  // Validate rows and radio-wide settings before a write, highlighting every
  // rejected value so the user can see what blocked the upload.
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
        settings: ctx.settings.getGroups(),
        module: state.selectedRadio.module,
        className: state.selectedRadio.className,
      }),
    ]);
    const result = rowResult;
    const settingsValidation = settingsResult
      || { valid: true, issues: [], settings: ctx.settings.getGroups() };
    ctx.settings.setGroups(settingsValidation.settings);
    ctx.settings.ensureActiveTab();
    ctx.settings.clearInvalid();
    ctx.settings.applyValidationIssues(settingsValidation.issues);
    ctx.settings.updateSummary();
    ctx.table.clearInvalidHighlights();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    for (const warning of warnings) {
      const rowIdx = Number(warning?.rowIndex);
      const channel = state.currentRows[rowIdx]?.Location ?? rowIdx;
      log.logDebug(
        `PREFLIGHT WARNING channel=${channel} column=${warning?.column || "unknown"}: ${warning?.message || "Driver warning"}`,
      );
    }
    ctx.table.applyValidationIssues(issues);
    if (issues.length > 0) {
      ctx.table.render();
    }
    ctx.settings.render();
    return {
      valid: Boolean(result?.valid)
        && Boolean(settingsValidation?.valid)
        && ctx.settings.invalidCount() === 0,
      issues: [...issues, ...(settingsValidation.issues || [])],
    };
  }

  async function downloadFromRadio() {
    if (!state.selectedRadio) {
      log.setStatus("Search for and select a radio first.");
      return;
    }
    // Captured up front: a clone runs long enough for the user to pick a
    // different radio while it is in flight, and the outcome belongs to the
    // radio the transfer actually ran against.
    const radio = state.selectedRadio;
    const startedAt = Date.now();
    try {
      trackRadioEvent("radio_download", radio);
      log.setStatus(`Downloading from ${makeModelLabel(radio)}...`);
      beginCloneProgress(`Downloading from ${makeModelLabel(radio)}...`);
      const result = await requireRuntimeApi(state).downloadSelectedRadio({
        module: radio.module,
        className: radio.className,
      });
      state.currentHeaders = state.radioMetadata.headers?.length
        ? state.radioMetadata.headers
        : (result.headers || []);
      state.currentRows = result.rows;
      ctx.table.sortRowsByLocation();
      state.codeplugSource = "radio";
      ctx.settings.replaceState({
        supported: Array.isArray(result.settings) && result.settings.length > 0,
        available: Array.isArray(result.settings) && result.settings.length > 0,
        requiresImage: false,
        message: "",
        groups: ctx.settings.cloneGroups(result.settings || []),
      });
      ctx.table.clearInvalidHighlights();
      ctx.settings.clearInvalid();
      ctx.table.resetRowSelection();
      ctx.table.render();
      ctx.settings.updateViewButtons();
      ctx.settings.render();
      log.setStatus(
        `${makeModelLabel(radio)} download complete (${state.currentRows.length} channels).`
          + undecodedChannelsNote(result.unreadableChannels),
      );
      trackCloneOutcome("radio_download_success", radio, startedAt, codeplugParams(state));
      if (result.ident) {
        log.logSerial(`IDENT ${result.ident}`);
      }
    } catch (error) {
      trackCloneOutcome("radio_download_failure", radio, startedAt, cloneFailureParams(error, "transfer"));
      log.reportActionError("Download", error);
      log.logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      endCloneProgress();
    }
  }

  async function uploadToRadio() {
    if (!state.selectedRadio) {
      log.setStatus("Search for and select a radio first.");
      return;
    }
    // Captured for the same reason as in downloadFromRadio(): the selection can
    // change while the write is in flight, and every label, payload and event
    // below has to keep meaning the radio the upload started against.
    const radio = state.selectedRadio;
    const startedAt = Date.now();
    // Distinguishes a codeplug CHIRP itself rejected from a transfer that
    // reached the radio and failed there.
    let stage = "preflight";
    try {
      trackRadioEvent("radio_upload", radio);
      log.setStatus("Running upload preflight validation...");
      const preflight = await runUploadPreflight();
      if (!preflight.valid) {
        const count = Array.isArray(preflight.issues) ? preflight.issues.length : 0;
        trackRadioEvent("upload_blocked_preflight", radio, {
          ...codeplugParams(state),
          issue_count: count,
          first_column: firstIssueColumn(preflight.issues),
        });
        log.setStatus(
          count > 0
            ? `Upload blocked: ${count} invalid value(s) highlighted in red in ${actions.currentViewLabel()}.`
            : "Upload blocked: preflight validation failed.",
        );
        return;
      }
      stage = "transfer";
      log.setStatus(`Uploading to ${makeModelLabel(radio)}...`);
      beginCloneProgress(`Uploading to ${makeModelLabel(radio)}...`);
      const uploadResult = await requireRuntimeApi(state).uploadSelectedRadio({
        module: radio.module,
        className: radio.className,
        rows: state.currentRows,
        settings: ctx.settings.getGroups(),
      });
      ctx.settings.setGroups(uploadResult.settings);
      ctx.settings.clearInvalid();
      ctx.settings.render();
      log.setStatus(`${makeModelLabel(radio)} upload complete.`);
      // codeplug_source is the question this event exists to answer on the
      // write path: whether people upload what they just read off the radio,
      // or a file they brought with them.
      trackCloneOutcome("radio_upload_success", radio, startedAt, codeplugParams(state));
    } catch (error) {
      trackCloneOutcome("radio_upload_failure", radio, startedAt, cloneFailureParams(error, stage));
      log.reportActionError("Upload", error);
      log.logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      endCloneProgress();
    }
  }

  function bindEvents() {
    dom.serialConnectToggleEl.addEventListener("click", () => {
      if (connected) {
        disconnectSerial();
      } else {
        connectSerial("auto");
      }
    });

    dom.webusbConnectToggleEl.addEventListener("click", () => {
      if (connected) {
        disconnectSerial();
      } else {
        connectSerial("webusb");
      }
    });

    dom.radioDownloadEl.addEventListener("click", () => {
      downloadFromRadio();
    });

    dom.radioUploadEl.addEventListener("click", () => {
      uploadToRadio();
    });

    dom.unsupportedBrowserContinueEl.addEventListener("click", () => {
      setBrowserUnsupportedOverlayVisible(false);
      log.logSerial("Continuing without serial support; radio download/upload stays unavailable.");
    });
  }

  return {
    bindEvents,
    setSerialController,
    handlePortLost,
    setSidebarControlsEnabled,
    setBrowserUnsupportedOverlayVisible,
    refreshSerialConnectToggleLabel,
    updateSerialActionState,
    updateCloneProgress,
  };
}

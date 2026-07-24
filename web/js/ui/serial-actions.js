import { errorSummary, isAndroidPlatform, makeModelLabel } from "./format.js";
import { requireRuntimeApi } from "./state.js";

// Everything on the serial path: connect/disconnect over Web Serial or WebUSB,
// the enabled/visible state of the sidebar's radio actions, the clone progress
// bar, and the download/upload clone operations with their preflight. Owns the
// connection and capability state.
export function createSerialActions(ctx) {
  const { dom, state, log } = ctx;

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
    if (dom.serialConnectToggleEl) {
      dom.serialConnectToggleEl.disabled = busy;
    }
    if (dom.webusbConnectToggleEl) {
      dom.webusbConnectToggleEl.disabled = busy;
    }
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
    } catch (error) {
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

  function setSidebarControlsEnabled(enabled) {
    sidebarControlsEnabled = Boolean(enabled);
    for (const el of dom.sidebarControlEls) {
      el.disabled = !enabled;
    }
    updateSerialActionState();
  }

  function setSerialSupportWarningVisible(visible) {
    if (!dom.serialSupportWarningEl) {
      return;
    }
    dom.serialSupportWarningEl.hidden = !visible;
  }

  function setLiveRadioSupportWarningVisible(visible) {
    if (!dom.liveRadioSupportWarningEl) {
      return;
    }
    dom.liveRadioSupportWarningEl.hidden = !visible;
  }

  function refreshSerialConnectToggleLabel() {
    // Mobile has no hover tooltips, so on Android the labels themselves say
    // what each transport is for.
    const mobile = isAndroidPlatform();
    if (dom.serialConnectToggleEl) {
      dom.serialConnectToggleEl.textContent = connected
        ? "Disconnect"
        : (mobile ? "Connect via WebSerial (Bluetooth)" : "Connect via WebSerial");
    }
    if (dom.webusbConnectToggleEl) {
      dom.webusbConnectToggleEl.textContent = connected
        ? "Disconnect"
        : (mobile ? "Connect via WebUSB (wired adapter)" : "Connect via WebUSB");
    }
  }

  // Show the clone progress bar in its indeterminate state until the driver's
  // first status report arrives with real block counts.
  function beginCloneProgress(label) {
    if (!dom.cloneProgressEl) {
      return;
    }
    if (dom.cloneProgressLabelEl) {
      dom.cloneProgressLabelEl.textContent = String(label || "Working...");
    }
    if (dom.cloneProgressPercentEl) {
      dom.cloneProgressPercentEl.textContent = "";
    }
    dom.cloneProgressBarEl?.removeAttribute?.("value");
    dom.cloneProgressEl.hidden = false;
  }

  // CHIRP drivers report status once per transferred block (cur/max may be -1
  // when a driver reports no counts; the bar then stays indeterminate).
  function updateCloneProgress(cur, max, msg) {
    if (!dom.cloneProgressEl) {
      return;
    }
    dom.cloneProgressEl.hidden = false;
    if (msg && dom.cloneProgressLabelEl) {
      dom.cloneProgressLabelEl.textContent = msg;
    }
    if (Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur >= 0) {
      const percent = Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
      if (dom.cloneProgressBarEl) {
        dom.cloneProgressBarEl.value = percent;
      }
      if (dom.cloneProgressPercentEl) {
        dom.cloneProgressPercentEl.textContent = `${percent}%`;
      }
    } else {
      // A no-count report must not leave the previous phase's percentage on
      // screen: removing value makes the <progress> bar indeterminate again.
      dom.cloneProgressBarEl?.removeAttribute?.("value");
      if (dom.cloneProgressPercentEl) {
        dom.cloneProgressPercentEl.textContent = "";
      }
    }
  }

  function endCloneProgress() {
    if (dom.cloneProgressEl) {
      dom.cloneProgressEl.hidden = true;
    }
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

    if (dom.serialConnectToggleEl) {
      dom.serialConnectToggleEl.hidden = !showWebSerialToggle;
      dom.serialConnectToggleEl.disabled = !actionsAllowed;
      dom.serialConnectToggleEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : (isAndroidPlatform()
          ? "Connect over native Web Serial, for use with Bluetooth serial ports"
          : "");
    }

    if (dom.webusbConnectToggleEl) {
      dom.webusbConnectToggleEl.hidden = !showWebUsbToggle;
      dom.webusbConnectToggleEl.disabled = !actionsAllowed;
      dom.webusbConnectToggleEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : "Connect over WebUSB, for use with FTDI FT231X/FT232R or Prolific PL2303";
    }

    if (dom.radioDownloadEl) {
      dom.radioDownloadEl.disabled = !actionsAllowed;
      dom.radioDownloadEl.title = liveRadioUnsupported
        ? "Live-mode radios are not supported in this UI yet"
        : "";
    }

    if (!dom.radioUploadEl) {
      return;
    }

    dom.radioUploadEl.disabled = !actionsAllowed || ctx.settings.hasInvalidSettings();
    if (liveRadioUnsupported) {
      dom.radioUploadEl.title = "Live-mode radios are not supported in this UI yet";
      return;
    }
    dom.radioUploadEl.title = ctx.settings.hasInvalidSettings()
      ? "Fix invalid radio settings before upload"
      : "";
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
      log.setStatus("Select a radio make/model first.");
      return;
    }
    try {
      trackRadioEvent("radio_download", state.selectedRadio);
      log.setStatus(`Downloading from ${makeModelLabel(state.selectedRadio)}...`);
      beginCloneProgress(`Downloading from ${makeModelLabel(state.selectedRadio)}...`);
      const result = await requireRuntimeApi(state).downloadSelectedRadio({
        module: state.selectedRadio.module,
        className: state.selectedRadio.className,
      });
      state.currentHeaders = state.radioMetadata.headers?.length
        ? state.radioMetadata.headers
        : (result.headers || []);
      state.currentRows = result.rows;
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
      log.setStatus(`${makeModelLabel(state.selectedRadio)} download complete (${state.currentRows.length} channels).`);
      if (result.ident) {
        log.logSerial(`IDENT ${result.ident}`);
      }
    } catch (error) {
      log.reportActionError("Download", error);
      log.logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      endCloneProgress();
    }
  }

  async function uploadToRadio() {
    if (!state.selectedRadio) {
      log.setStatus("Select a radio make/model first.");
      return;
    }
    try {
      trackRadioEvent("radio_upload", state.selectedRadio);
      log.setStatus("Running upload preflight validation...");
      const preflight = await runUploadPreflight();
      if (!preflight.valid) {
        const count = Array.isArray(preflight.issues) ? preflight.issues.length : 0;
        log.setStatus(
          count > 0
            ? `Upload blocked: ${count} invalid value(s) highlighted in red in ${ctx.actions.currentViewLabel()}.`
            : "Upload blocked: preflight validation failed.",
        );
        return;
      }
      log.setStatus(`Uploading to ${makeModelLabel(state.selectedRadio)}...`);
      beginCloneProgress(`Uploading to ${makeModelLabel(state.selectedRadio)}...`);
      const uploadResult = await requireRuntimeApi(state).uploadSelectedRadio({
        module: state.selectedRadio.module,
        className: state.selectedRadio.className,
        rows: state.currentRows,
        settings: ctx.settings.getGroups(),
      });
      ctx.settings.setGroups(uploadResult.settings);
      ctx.settings.clearInvalid();
      ctx.settings.render();
      log.setStatus(`${makeModelLabel(state.selectedRadio)} upload complete.`);
    } catch (error) {
      log.reportActionError("Upload", error);
      log.logSerial(`ERROR ${errorSummary(error)}`);
    } finally {
      endCloneProgress();
    }
  }

  function bindEvents() {
    dom.serialConnectToggleEl?.addEventListener("click", () => {
      if (connected) {
        disconnectSerial();
      } else {
        connectSerial("auto");
      }
    });

    dom.webusbConnectToggleEl?.addEventListener("click", () => {
      if (connected) {
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
        log.setStatus("Running Python serial transaction...");
        const result = await requireRuntimeApi(state).serialTxRx({ txHex, rxBytes, timeoutMs });
        log.setStatus("Python serial transaction complete.");
        log.logSerial(`PY TX ${result.tx.hex} | PY RX ${result.rx.hex || "<none>"}`);
      } catch (error) {
        log.reportActionError("Serial transaction", error);
        log.logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#radio-download").addEventListener("click", () => {
      downloadFromRadio();
    });

    document.querySelector("#radio-upload").addEventListener("click", () => {
      uploadToRadio();
    });
  }

  return {
    bindEvents,
    setSerialController,
    setSidebarControlsEnabled,
    setSerialSupportWarningVisible,
    refreshSerialConnectToggleLabel,
    updateSerialActionState,
    updateCloneProgress,
  };
}

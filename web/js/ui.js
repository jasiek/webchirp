import { buildExportFileName } from "./ui/format.js";
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
import { createCodeplugIo } from "./ui/codeplug-io.js";
import { createSerialActions } from "./ui/serial-actions.js";

// Re-exported so existing importers (and tests) keep a stable entry point.
export { buildExportFileName };

// Compose the UI from its feature modules and expose the controller the app
// shell drives. Each module owns one area (channel grid, radio settings, radio
// selection, repeater imports, file import/export, serial actions); this file
// wires them together, owns the channels/settings view switch, and runs the
// bootstrap sequence.
export function createUiController() {
  const dom = queryUiElements();
  const state = createUiState();
  const log = createDebugLog({ dom });
  const issueReporter = createIssueReporter({ state, log });

  // Cross-module calls go through this registry rather than direct imports, so
  // no module has to import a sibling that imports it back. Every entry is
  // resolved when called, never at construction time.
  const actions = {
    updateSerialActionState: () => ctx.serial.updateSerialActionState(),
    setEditorView: (view) => setEditorView(view),
    isRepeaterModalOpen: () => ctx.repeaterQuery.isModalOpen(),
    currentViewLabel: () => currentViewLabel(),
  };

  // Modules hang off one context object so siblings can reach each other
  // through it. The forward references above and below are only dereferenced
  // after every module has been constructed.
  const ctx = { dom, state, log, actions };
  const settings = createSettingsPanel(ctx);
  const table = createChannelTable(ctx);
  const catalog = createRadioCatalog(ctx);
  const repeaterQuery = createRepeaterQuery(ctx);
  const codeplugIo = createCodeplugIo(ctx);
  const serial = createSerialActions(ctx);
  Object.assign(ctx, { settings, table, catalog, repeaterQuery, codeplugIo, serial });

  exposeCurrentRowsForDebugging(state);

  function setRuntimeApi(api) {
    state.runtimeApi = api;
  }

  function currentViewLabel() {
    return state.currentEditorView === "settings" ? "radio settings" : "channels";
  }

  function setEditorView(nextView) {
    state.currentEditorView = nextView === "settings" ? "settings" : "channels";
    const channelsActive = state.currentEditorView === "channels";
    dom.channelEditorEl.classList.toggle("is-active", channelsActive);
    dom.settingsEditorEl.classList.toggle("is-active", !channelsActive);
    dom.channelEditorEl.hidden = !channelsActive;
    dom.settingsEditorEl.hidden = channelsActive;
    dom.viewChannelsEl.classList.toggle("is-active", channelsActive);
    dom.viewSettingsEl.classList.toggle("is-active", !channelsActive);
    dom.viewChannelsEl.setAttribute("aria-selected", channelsActive ? "true" : "false");
    dom.viewSettingsEl.setAttribute("aria-selected", channelsActive ? "false" : "true");
  }

  // Register the handlers that are not owned by a single feature module: the
  // view switch, the global Escape key, the issue link and the window-level
  // error sinks.
  function bindEvents() {
    log.bindEvents();
    table.bindEvents();
    repeaterQuery.bindEvents();
    codeplugIo.bindEvents();
    catalog.bindEvents();
    serial.bindEvents();

    // Escape closes the topmost open surface: the import prompt, then the
    // repeater modal, then the channel actions menu.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (codeplugIo.isImportChoiceModalOpen()) {
          codeplugIo.resolveImportChoice("cancel");
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

    dom.viewChannelsEl.addEventListener("click", () => {
      setEditorView("channels");
      // The grid sizes its rendered window against its viewport, which has no
      // height while the settings view is showing.
      table.refreshVisibleRows();
    });

    dom.viewSettingsEl.addEventListener("click", () => {
      if (!settings.radioHasSettings()) {
        log.setStatus(settings.settingsUnavailableMessage());
        return;
      }
      setEditorView("settings");
      settings.render();
    });


    dom.reportIssueEl.addEventListener("click", () => {
      issueReporter.openPrefilledIssue();
    });

    window.addEventListener("error", (event) => {
      log.logDebug(`WINDOW ERROR ${event.message}`);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const msg = event.reason?.message || String(event.reason || "Unhandled rejection");
      log.logDebug(`PROMISE ERROR ${msg}`);
    });
  }

  // Bootstrap UI: capability checks, catalog load, metadata load, sample data.
  async function init(serialSupported) {
    bindEvents();
    serial.refreshSerialConnectToggleLabel();
    serial.setSerialSupportWarningVisible(!serialSupported);
    serial.setSidebarControlsEnabled(false);
    catalog.setRadioSelectPlaceholder("Loading...");
    try {
      if (!serialSupported) {
        log.logSerial("Web Serial unsupported in this browser.");
      } else {
        log.logSerial("Web Serial available.");
      }
      const catalogResponse = await requireRuntimeApi(state).listRadios();
      state.radioCatalog = catalogResponse.radios || [];
      state.runtimeInfo = (await requireRuntimeApi(state).getRuntimeInfo()) || state.runtimeInfo;
      catalog.refreshMakeOptions();
      catalog.restoreSelectedRadioCookie();
      await catalog.loadSelectedRadioMetadata();
      await settings.load();
      log.setStatus(`Loaded ${state.radioCatalog.length} radio definitions from CHIRP sources.`);
      await codeplugIo.loadSampleCsv();
      settings.render();
      serial.setSidebarControlsEnabled(true);
    } catch (error) {
      catalog.setRadioSelectPlaceholder("Unavailable");
      log.reportActionError("Initialization", error);
      log.setStatus("Initialization failed; sidebar controls remain disabled.");
    }
  }

  return {
    setRuntimeApi,
    setSerialController: serial.setSerialController,
    setStatus: log.setStatus,
    logSerial: log.logSerial,
    logDebug: log.logDebug,
    updateCloneProgress: serial.updateCloneProgress,
    init,
    selectedRowsForOperations: table.selectedRowsForOperations,
    onRuntimeCrash(message) {
      log.logDebug(`RUNTIME CRASH ${message}`);
    },
  };
}

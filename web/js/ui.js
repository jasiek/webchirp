import { buildExportFileName } from "./ui/format.js";
import { queryUiElements } from "./ui/dom.js";
import {
  createUiState,
  exposeCurrentRowsForDebugging,
  requireRuntimeApi,
} from "./ui/state.js";
import { createDebugLog } from "./ui/debug-log.js";
import { createProgress } from "./ui/progress.js";
import { createIssueReporter } from "./ui/issue-report.js";
import { createSettingsPanel } from "./ui/settings-panel.js";
import { createChannelTable } from "./ui/channel-table.js";
import { createRadioCatalog } from "./ui/radio-catalog.js";
import { createRepeaterQuery } from "./ui/repeater-query.js";
import { createRepeaterMap } from "./ui/repeater-map.js";
import { createCodeplugIo } from "./ui/codeplug-io.js";
import { createSerialActions } from "./ui/serial-actions.js";
import {
  classifyErrorKind,
  errorTypeName,
  radioEventParams,
  trackEvent,
} from "./ui/analytics.js";

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
  const progress = createProgress({ dom });
  const issueReporter = createIssueReporter({ state, log });

  // Cross-module calls go through this registry rather than direct imports, so
  // no module has to import a sibling that imports it back. Every entry is
  // resolved when called, never at construction time.
  const actions = {
    updateSerialActionState: () => ctx.serial.updateSerialActionState(),
    setEditorView: (view) => setEditorView(view),
    isRepeaterModalOpen: () =>
      ctx.repeaterQuery.isModalOpen() || ctx.repeaterMap.isModalOpen(),
    currentViewLabel: () => currentViewLabel(),
  };

  // Modules hang off one context object so siblings can reach each other
  // through it. The forward references above and below are only dereferenced
  // after every module has been constructed.
  const ctx = { dom, state, log, progress, actions };
  const settings = createSettingsPanel(ctx);
  const table = createChannelTable(ctx);
  const catalog = createRadioCatalog(ctx);
  const repeaterQuery = createRepeaterQuery(ctx);
  const repeaterMap = createRepeaterMap(ctx);
  const codeplugIo = createCodeplugIo(ctx);
  const serial = createSerialActions(ctx);
  Object.assign(ctx, { settings, table, catalog, repeaterQuery, repeaterMap, codeplugIo, serial });

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
    repeaterMap.bindEvents();
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
        if (repeaterMap.isModalOpen()) {
          repeaterMap.closeModal();
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
      // Not reported: updateViewButtons() disables this tab on exactly this
      // condition, so the branch is unreachable defence rather than something
      // a user can hit, and an event here would always read as zero.
      if (!settings.radioHasSettings()) {
        log.setStatus(settings.settingsUnavailableMessage());
        return;
      }
      trackEvent("settings_view_opened", radioEventParams(state.selectedRadio));
      setEditorView("settings");
      settings.render();
    });


    dom.reportIssueEl.addEventListener("click", () => {
      // A frustration signal, and one that pairs with the clone failure events:
      // it says how much of what breaks is actually being reported to us.
      trackEvent("report_issue_clicked", radioEventParams(state.selectedRadio));
      issueReporter.openPrefilledIssue();
    });

    window.addEventListener("error", (event) => {
      log.logError(`WINDOW ERROR ${event.message}`);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const msg = event.reason?.message || String(event.reason || "Unhandled rejection");
      log.logError(`PROMISE ERROR ${msg}`);
    });
  }

  // Bootstrap UI: capability checks, catalog load, metadata load, empty grid.
  // The two capability gaps are independent (Safari has both): missing serial
  // only disables radio programming, while missing JSPI means driver imports
  // fail and init itself will land in the catch below.
  async function init(serialSupported, jspiSupported = true) {
    // Covers the whole cold start the user waits through — including the
    // Pyodide boot the metadata and settings loads below trigger — so this is
    // the number that decides whether people wait or leave.
    const startedAt = Date.now();
    bindEvents();
    serial.refreshSerialConnectToggleLabel();
    serial.setBrowserUnsupportedOverlayVisible(!serialSupported || !jspiSupported, {
      serial: !serialSupported,
      jspi: !jspiSupported,
    });
    serial.setSidebarControlsEnabled(false);
    catalog.setRadioSelectPlaceholder("Loading...");
    try {
      if (!serialSupported) {
        log.logSerial("Web Serial unsupported in this browser.");
      } else {
        log.logSerial("Web Serial available.");
      }
      if (!jspiSupported) {
        log.logDebug(
          "WASM stack switching (JSPI) unsupported; CHIRP driver imports will fail in this browser.",
        );
      }
      const catalogResponse = await requireRuntimeApi(state).listRadios();
      state.radioCatalog = catalogResponse.radios || [];
      state.runtimeInfo = (await requireRuntimeApi(state).getRuntimeInfo()) || state.runtimeInfo;
      catalog.refreshMakeOptions();
      catalog.restoreSelectedRadioCookie();
      await catalog.loadSelectedRadioMetadata();
      await settings.load();
      // Schema only: the grid starts empty and shows its own "load something"
      // notice, so the status line stays on the catalog result.
      await codeplugIo.loadEmptySchema();
      log.setStatus(`Loaded ${state.radioCatalog.length} radio definitions from CHIRP sources.`);
      settings.render();
      serial.setSidebarControlsEnabled(true);
      trackEvent("app_ready", {
        duration_ms: Date.now() - startedAt,
        // "sources" means the prebuilt catalog was missing or stale and every
        // driver had to be imported in Pyodide first — a much slower start.
        catalog_source: catalogResponse.source || "unknown",
      });
    } catch (error) {
      catalog.setRadioSelectPlaceholder("Unavailable");
      trackEvent("app_init_failed", {
        duration_ms: Date.now() - startedAt,
        error_kind: classifyErrorKind(error),
        error_type: errorTypeName(error),
      });
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
    beginProgress: progress.begin,
    init,
    selectedRowsForOperations: table.selectedRowsForOperations,
    onRuntimeCrash(message) {
      log.logError(`RUNTIME CRASH ${message}`);
    },
  };
}

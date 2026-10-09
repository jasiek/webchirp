// Every element the UI requires, keyed by the name modules refer to it by.
// index.html always provides all of them — there is no deployment or page state
// where one is legitimately absent — so a missing element is an authoring error
// (a renamed or deleted id), not a runtime condition. queryUiElements() fails
// fast and names every missing element, rather than letting modules no-op their
// way into a half-wired UI where a control silently does nothing.
export const REQUIRED_ELEMENTS = {
  tableHead: "#mem-table thead",
  tableBody: "#mem-table tbody",
  // The channel grid's scroll viewport: what the table virtualizes against.
  tableScrollEl: "#mem-table-scroll",
  // Centred notice shown in place of the grid while no channels are loaded.
  channelEmptyStateEl: "#channel-empty-state",
  channelEditorEl: "#channel-editor",
  settingsEditorEl: "#settings-editor",
  viewChannelsEl: "#view-channels",
  viewSettingsEl: "#view-settings",
  settingsTabsEl: "#settings-tabs",
  settingsSummaryEl: "#settings-summary",
  settingsEmptyEl: "#settings-empty",
  settingsContentEl: "#settings-content",
  fileInput: "#codeplug-file",
  dropOverlayEl: "#drop-overlay",
  debugToggleEl: "#debug-toggle",
  debugActionsEl: "#debug-actions",
  debugOutputContentEl: "#debug-output-content",
  debugOutputEl: "#debug-output",
  debugClearEl: "#debug-clear",
  debugCopyEl: "#debug-copy",
  reportIssueEl: "#report-issue",
  // Toolbar install affordance, hidden until the browser parks an install
  // prompt for web/js/install-prompt.ts to raise.
  installAppEl: "#install-app",
  // Global badge shown only while the browser reports that it is offline.
  offlineIndicatorEl: "#offline-indicator",
  // The shell is greyed out (class toggle) while the unsupported-browser
  // overlay explains why serial cannot work here.
  appShellEl: "#app-shell",
  unsupportedBrowserOverlayEl: "#unsupported-browser-overlay",
  unsupportedBrowserIosInfoEl: "#unsupported-browser-ios-info",
  unsupportedBrowserSerialInfoEl: "#unsupported-browser-serial-info",
  unsupportedBrowserContinueEl: "#unsupported-browser-continue",
  liveRadioSupportWarningEl: "#live-radio-support-warning",
  radioSearchEl: "#radio-search",
  useQuanshengDriversEl: "#use-quansheng-drivers",
  useChirpDriversEl: "#use-chirp-drivers",
  sidebarWarningEl: "#sidebar-warning",
  standardDriverWarningEl: "#standard-driver-warning",
  unofficialDriverWarningEl: "#unofficial-driver-warning",
  radioSearchResultsEl: "#radio-search-results",
  // The sidebar readout of which radio the app is currently working with.
  radioSelectionEl: "#radio-selection",
  radioSelectionNameEl: "#radio-selection-name",
  serialConnectToggleEl: "#serial-connect-toggle",
  webusbConnectToggleEl: "#serial-connect-webusb",
  webbluetoothConnectToggleEl: "#serial-connect-webbluetooth",
  radioDownloadEl: "#radio-download",
  radioUploadEl: "#radio-upload",
  cloneProgressEl: "#clone-progress",
  cloneProgressBarEl: "#clone-progress-bar",
  cloneProgressLabelEl: "#clone-progress-label",
  cloneProgressPercentEl: "#clone-progress-percent",
  appProgressEl: "#app-progress",
  appProgressBarEl: "#app-progress-bar",
  appProgressLabelEl: "#app-progress-label",
  appProgressCountEl: "#app-progress-count",
  loadCodeplugEl: "#load-codeplug",
  exportMenuToggleEl: "#export-menu-toggle",
  exportMenuEl: "#export-menu",
  exportCsvEl: "#export-csv",
  exportBinaryEl: "#export-binary",
  channelInsertEl: "#channel-insert",
  channelRemoveEl: "#channel-remove",
  channelMoveUpEl: "#channel-move-up",
  channelMoveDownEl: "#channel-move-down",
  channelCopyEl: "#channel-copy",
  channelCutEl: "#channel-cut",
  channelPasteEl: "#channel-paste",
  // Opens the bulk editor; disabled until the grid has a selection.
  channelBulkEditEl: "#channel-bulk-edit",
  channelAddGmrsEl: "#channel-add-gmrs",
  channelAddFrsEl: "#channel-add-frs",
  channelAddPmr446El: "#channel-add-pmr446",
  channelImportPrzemiennikiEl: "#channel-import-przemienniki",
  channelImportRepeaterbookEl: "#channel-import-repeaterbook",
  channelImportIrtsEl: "#channel-import-irts",
  // The per-channel driver-settings editor behind the grid's Extra column.
  channelExtraModalEl: "#channel-extra-modal",
  channelExtraFormEl: "#channel-extra-form",
  channelExtraTitleEl: "#channel-extra-title",
  channelExtraMessageEl: "#channel-extra-message",
  channelExtraGridEl: "#channel-extra-grid",
  channelExtraCancelEl: "#channel-extra-cancel",
  channelExtraSaveEl: "#channel-extra-save",
  // The bulk channel editor: one value written to every selected channel.
  channelBulkEditModalEl: "#channel-bulk-edit-modal",
  channelBulkEditFormEl: "#channel-bulk-edit-form",
  channelBulkEditTitleEl: "#channel-bulk-edit-title",
  channelBulkEditMessageEl: "#channel-bulk-edit-message",
  channelBulkEditGridEl: "#channel-bulk-edit-grid",
  channelBulkEditExtraMessageEl: "#channel-bulk-edit-extra-message",
  channelBulkEditExtraGridEl: "#channel-bulk-edit-extra-grid",
  channelBulkEditCancelEl: "#channel-bulk-edit-cancel",
  channelBulkEditApplyEl: "#channel-bulk-edit-apply",
  repeaterQueryModalEl: "#repeater-query-modal",
  repeaterQueryFormEl: "#repeater-query-form",
  repeaterQueryTitleEl: "#repeater-query-title",
  repeaterQueryGridEl: "#repeater-query-grid",
  repeaterQueryCancelEl: "#repeater-query-cancel",
  repeaterQuerySubmitEl: "#repeater-query-submit",
  channelImportRsgbEl: "#channel-import-rsgb",
  repeaterMapTooltipEl: "#repeater-map-tooltip",
  repeaterMapTooltipCoordsEl: "#repeater-map-tooltip-coords",
  repeaterMapTooltipCanvasEl: "#repeater-map-tooltip-canvas",
  repeaterMapTooltipAttributionEl: "#repeater-map-tooltip-attribution",
  repeaterMapModalEl: "#repeater-map-modal",
  repeaterMapModalCoordsEl: "#repeater-map-modal-coords",
  repeaterMapModalCanvasEl: "#repeater-map-modal-canvas",
  repeaterMapModalAttributionEl: "#repeater-map-modal-attribution",
  repeaterMapCloseEl: "#repeater-map-close",
  importChoiceModalEl: "#import-choice-modal",
  importChoiceMessageEl: "#import-choice-message",
  importChoiceReplaceEl: "#import-choice-replace",
  importChoiceMergeEl: "#import-choice-merge",
  importChoiceCancelEl: "#import-choice-cancel",
  noticeModalEl: "#notice-modal",
  noticeTitleEl: "#notice-title",
  noticeMessageEl: "#notice-message",
  noticeDismissEl: "#notice-dismiss",
};

// Resolved with querySelectorAll. Matching nothing is not an error: these are
// whole-group lookups, not identified elements.
export const ELEMENT_COLLECTIONS = {
  sidebarControlEls: ".left-panel button, .left-panel input",
};

/**
 * The element interface of each REQUIRED_ELEMENTS entry that is more than a
 * plain HTMLElement in index.html (a button's disabled, an input's value, a
 * progress bar's value). Every other entry is an HTMLElement. Keep it in step
 * with the markup when an element changes tag.
 */
export type UiElementTypes = {
  tableHead: HTMLTableSectionElement;
  tableBody: HTMLTableSectionElement;
  viewChannelsEl: HTMLButtonElement;
  viewSettingsEl: HTMLButtonElement;
  fileInput: HTMLInputElement;
  debugToggleEl: HTMLButtonElement;
  debugOutputEl: HTMLTextAreaElement;
  debugClearEl: HTMLButtonElement;
  debugCopyEl: HTMLButtonElement;
  reportIssueEl: HTMLButtonElement;
  installAppEl: HTMLButtonElement;
  unsupportedBrowserContinueEl: HTMLButtonElement;
  radioSearchEl: HTMLInputElement;
  useQuanshengDriversEl: HTMLAnchorElement;
  useChirpDriversEl: HTMLAnchorElement;
  radioSearchResultsEl: HTMLUListElement;
  serialConnectToggleEl: HTMLButtonElement;
  webusbConnectToggleEl: HTMLButtonElement;
  webbluetoothConnectToggleEl: HTMLButtonElement;
  radioDownloadEl: HTMLButtonElement;
  radioUploadEl: HTMLButtonElement;
  cloneProgressBarEl: HTMLProgressElement;
  appProgressBarEl: HTMLProgressElement;
  loadCodeplugEl: HTMLButtonElement;
  exportMenuToggleEl: HTMLButtonElement;
  exportCsvEl: HTMLButtonElement;
  exportBinaryEl: HTMLButtonElement;
  channelInsertEl: HTMLButtonElement;
  channelRemoveEl: HTMLButtonElement;
  channelMoveUpEl: HTMLButtonElement;
  channelMoveDownEl: HTMLButtonElement;
  channelCopyEl: HTMLButtonElement;
  channelCutEl: HTMLButtonElement;
  channelPasteEl: HTMLButtonElement;
  channelBulkEditEl: HTMLButtonElement;
  channelAddGmrsEl: HTMLButtonElement;
  channelAddFrsEl: HTMLButtonElement;
  channelAddPmr446El: HTMLButtonElement;
  channelImportPrzemiennikiEl: HTMLButtonElement;
  channelImportRepeaterbookEl: HTMLButtonElement;
  channelImportIrtsEl: HTMLButtonElement;
  channelExtraFormEl: HTMLFormElement;
  channelExtraCancelEl: HTMLButtonElement;
  channelExtraSaveEl: HTMLButtonElement;
  channelBulkEditFormEl: HTMLFormElement;
  channelBulkEditCancelEl: HTMLButtonElement;
  channelBulkEditApplyEl: HTMLButtonElement;
  repeaterQueryFormEl: HTMLFormElement;
  repeaterQueryCancelEl: HTMLButtonElement;
  repeaterQuerySubmitEl: HTMLButtonElement;
  channelImportRsgbEl: HTMLButtonElement;
  repeaterMapCloseEl: HTMLButtonElement;
  importChoiceReplaceEl: HTMLButtonElement;
  importChoiceMergeEl: HTMLButtonElement;
  importChoiceCancelEl: HTMLButtonElement;
  noticeDismissEl: HTMLButtonElement;
};

/**
 * What queryUiElements() returns: every REQUIRED_ELEMENTS name bound to its
 * element, plus each ELEMENT_COLLECTIONS group as an array.
 */
export type UiDom = {
  [K in keyof typeof REQUIRED_ELEMENTS]: K extends keyof UiElementTypes ? UiElementTypes[K] : HTMLElement;
} & { sidebarControlEls: Array<HTMLButtonElement | HTMLInputElement> };

// Single place where the UI resolves its document elements. Every module
// receives the returned object rather than querying the document itself, which
// keeps the id list in one place and lets the headless tests stub the DOM once.
export function queryUiElements(): UiDom {
  const dom: Record<string, Element | Element[]> = {};
  const missing: string[] = [];

  for (const [name, selector] of Object.entries(REQUIRED_ELEMENTS)) {
    const element = document.querySelector(selector);
    if (!element) {
      missing.push(`${name} -> ${selector}`);
      continue;
    }
    dom[name] = element;
  }

  if (missing.length > 0) {
    throw new Error(
      `index.html is missing ${missing.length} required element(s); `
      + `check for renamed or removed ids:\n  ${missing.join("\n  ")}`,
    );
  }

  for (const [name, selector] of Object.entries(ELEMENT_COLLECTIONS)) {
    dom[name] = Array.from(document.querySelectorAll(selector));
  }

  // Every name was bound above or the throw fired, so the record is whole;
  // the element types are the markup's, which UiElementTypes states.
  return dom as unknown as UiDom;
}

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
  channelEditorEl: "#channel-editor",
  settingsEditorEl: "#settings-editor",
  viewChannelsEl: "#view-channels",
  viewSettingsEl: "#view-settings",
  settingsTabsEl: "#settings-tabs",
  settingsSummaryEl: "#settings-summary",
  settingsEmptyEl: "#settings-empty",
  settingsContentEl: "#settings-content",
  fileInput: "#csv-file",
  imgFileInput: "#img-file",
  dropOverlayEl: "#drop-overlay",
  debugOutputEl: "#debug-output",
  debugClearEl: "#debug-clear",
  debugCopyEl: "#debug-copy",
  reportIssueEl: "#report-issue",
  serialSupportWarningEl: "#webserial-support-warning",
  liveRadioSupportWarningEl: "#live-radio-support-warning",
  radioSearchEl: "#radio-search",
  radioSearchResultsEl: "#radio-search-results",
  radioMakeEl: "#radio-make",
  radioModelEl: "#radio-model",
  serialConnectToggleEl: "#serial-connect-toggle",
  webusbConnectToggleEl: "#serial-connect-webusb",
  radioDownloadEl: "#radio-download",
  radioUploadEl: "#radio-upload",
  cloneProgressEl: "#clone-progress",
  cloneProgressBarEl: "#clone-progress-bar",
  cloneProgressLabelEl: "#clone-progress-label",
  cloneProgressPercentEl: "#clone-progress-percent",
  loadSampleEl: "#load-sample",
  importCsvEl: "#import-csv",
  exportCsvEl: "#export-csv",
  importBinaryEl: "#import-binary",
  exportBinaryEl: "#export-binary",
  channelInsertEl: "#channel-insert",
  channelRemoveEl: "#channel-remove",
  channelMoveUpEl: "#channel-move-up",
  channelMoveDownEl: "#channel-move-down",
  channelCopyEl: "#channel-copy",
  channelCutEl: "#channel-cut",
  channelPasteEl: "#channel-paste",
  channelMenuToggleEl: "#channel-menu-toggle",
  channelMenuPopupEl: "#channel-menu-popup",
  channelAddGmrsEl: "#channel-add-gmrs",
  channelAddFrsEl: "#channel-add-frs",
  channelAddPmr446El: "#channel-add-pmr446",
  channelImportPrzemiennikiEl: "#channel-import-przemienniki",
  channelImportRepeaterbookEl: "#channel-import-repeaterbook",
  przemiennikiModalEl: "#przemienniki-modal",
  przemiennikiFormEl: "#przemienniki-form",
  przemiennikiModalTitleEl: "#przemienniki-modal-title",
  przemiennikiCountryEl: "#przemienniki-country",
  przemiennikiBandListEl: "#przemienniki-band-list",
  przemiennikiModeListEl: "#przemienniki-mode-list",
  przemiennikiOnlyWorkingEl: "#przemienniki-onlyworking",
  przemiennikiLatitudeEl: "#przemienniki-latitude",
  przemiennikiLongitudeEl: "#przemienniki-longitude",
  przemiennikiRangeEl: "#przemienniki-range",
  przemiennikiGeolocateEl: "#przemienniki-geolocate",
  przemiennikiCancelEl: "#przemienniki-cancel",
  importChoiceModalEl: "#import-choice-modal",
  importChoiceMessageEl: "#import-choice-message",
  importChoiceReplaceEl: "#import-choice-replace",
  importChoiceMergeEl: "#import-choice-merge",
  importChoiceCancelEl: "#import-choice-cancel",
};

// Resolved with querySelectorAll. Matching nothing is not an error: these are
// whole-group lookups, not identified elements.
export const ELEMENT_COLLECTIONS = {
  sidebarControlEls: ".left-panel select, .left-panel button, .left-panel input",
};

// Single place where the UI resolves its document elements. Every module
// receives the returned object rather than querying the document itself, which
// keeps the id list in one place and lets the headless tests stub the DOM once.
export function queryUiElements() {
  const dom = {};
  const missing = [];

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

  return dom;
}

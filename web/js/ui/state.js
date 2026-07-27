// Cross-module UI state. Only state that genuinely spans several UI modules
// lives here; state used by a single module (row selection, settings validation
// keys, serial connection flags) stays private to that module and is reached
// through its accessors.
export function createUiState() {
  return {
    runtimeApi: null,
    // Channel grid contents. The channel-table module owns mutation; other
    // modules read these for export, upload and repeater-import payloads.
    currentHeaders: [],
    currentRows: [],
    // Where the rows in the editor came from: "radio", "csv", "img", "sample",
    // or "mixed" once an import has been merged into them. Reporting-only —
    // no behaviour reads this.
    codeplugSource: "",
    // Radio catalog and the entry the user has selected.
    radioCatalog: [],
    selectedRadio: null,
    radioMetadata: { headers: [], columns: {} },
    // Only the newest metadata/settings load may apply its results; older
    // in-flight responses would otherwise overwrite state for a radio the user
    // has already navigated away from.
    radioLoadSequence: 0,
    lastLoadedRadioKey: "",
    runtimeInfo: { chirpRevision: "" },
    currentEditorView: "channels",
    // Recorded on serial connect, reported back in pre-filled issue forms.
    lastUsbVendorId: "",
    lastUsbProductId: "",
  };
}

export function requireRuntimeApi(state) {
  if (!state.runtimeApi) {
    throw new Error("Runtime API client is not initialized");
  }
  return state.runtimeApi;
}

// Metadata and settings loads are tagged with a token so results arriving after
// the user has moved to another radio can be discarded.
export function nextRadioLoadToken(state) {
  state.radioLoadSequence += 1;
  return state.radioLoadSequence;
}

export function isStaleRadioLoad(state, loadToken) {
  return loadToken !== state.radioLoadSequence;
}

// Expose the live channel rows for debugging from the browser console. Defined
// as a getter so it always reflects the current array identity, which the
// channel operations replace rather than mutate in place.
export function exposeCurrentRowsForDebugging(state) {
  if (Object.getOwnPropertyDescriptor(globalThis, "currentRows")) {
    return;
  }
  Object.defineProperty(globalThis, "currentRows", {
    configurable: true,
    get: () => state.currentRows,
  });
}

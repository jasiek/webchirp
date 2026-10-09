// Cross-module UI state. Only state that genuinely spans several UI modules
// lives here; state used by a single module (row selection, settings validation
// keys, serial connection flags) stays private to that module and is reached
// through its accessors.

/** @typedef {import("../runtime-rpc.ts").RuntimeApi} RuntimeApi */
/** @typedef {import("../runtime-rpc.ts").CatalogRadio} CatalogRadio */
/** @typedef {import("../python-sources.ts").RuntimeInfo} RuntimeInfo */
/** @typedef {import("./channel-values.js").ChannelRow} ChannelRow */
/** @typedef {import("./channel-values.js").RadioMetadata} RadioMetadata */

/**
 * The handle web/js/ui/radio-session.js keeps for the runtime session behind
 * the selected radio. Created synchronously at selection; its id arrives when
 * the runtime answers, through ready.
 * @typedef {Object} RadioSessionHandle
 * @property {CatalogRadio|null} radio  The selection the session is for.
 * @property {string} id  The runtime's session id; "" until ready settles.
 * @property {boolean} loaded  Metadata and settings have both been applied.
 * @property {boolean} loading  A metadata/settings load is in flight.
 * @property {boolean} closed  The session was released; nothing may use it.
 * @property {boolean} failed  The runtime refused to open it.
 * @property {Promise<string>} ready  Resolves to id once open.
 */

/**
 * State that genuinely spans UI modules; see the comment above.
 * @typedef {Object} UiState
 * @property {RuntimeApi|null} runtimeApi  Read through requireRuntimeApi().
 * @property {string[]} currentHeaders  The grid's CHIRP columns, in order.
 * @property {ChannelRow[]} currentRows  Replaced, not mutated, by row operations.
 * @property {""|"radio"|"csv"|"img"|"mixed"} codeplugSource
 * @property {CatalogRadio[]} radioCatalog
 * @property {CatalogRadio|null} selectedRadio
 * @property {RadioSessionHandle|null} radioSession
 * @property {RadioMetadata} radioMetadata
 * @property {RuntimeInfo|{chirpRevision: string}} runtimeInfo
 * @property {"channels"|"settings"} currentEditorView
 * @property {string} lastUsbVendorId
 * @property {string} lastUsbProductId
 */

/** @returns {UiState} */
export function createUiState() {
  return {
    runtimeApi: null,
    // Channel grid contents. The channel-table module owns mutation; other
    // modules read these for export, upload and repeater-import payloads.
    currentHeaders: [],
    currentRows: [],
    // Where the rows in the editor came from: "radio", "csv", "img", or
    // "mixed" once anything has been merged into them — a merged CSV import, a
    // repeater query, a band-plan preset. Reporting-only: no behaviour reads
    // this.
    codeplugSource: "",
    // Radio catalog and the entry the user has selected.
    radioCatalog: [],
    selectedRadio: null,
    // The runtime session for the selected radio, opened and replaced by
    // web/js/ui/radio-session.js. selectedRadio and radioSession move
    // together: a selection opens a session, and every radio-bound runtime
    // call carries its id. A response is applied only while the handle it was
    // made for is still this one, which is how a stale load is told from a
    // current one -- by identity, not by counting.
    radioSession: null,
    radioMetadata: { headers: [], columns: {} },
    runtimeInfo: { chirpRevision: "" },
    currentEditorView: "channels",
    // Recorded on serial connect, reported back in pre-filled issue forms.
    lastUsbVendorId: "",
    lastUsbProductId: "",
  };
}

// The runtime client, or a clear error before web/app.js has installed one.
/**
 * @param {UiState} state
 * @returns {RuntimeApi}
 */
export function requireRuntimeApi(state) {
  if (!state.runtimeApi) {
    throw new Error("Runtime API client is not initialized");
  }
  return state.runtimeApi;
}

// Expose the live channel rows for debugging from the browser console. Defined
// as a getter so it always reflects the current array identity, which the
// channel operations replace rather than mutate in place.
/** @param {UiState} state */
export function exposeCurrentRowsForDebugging(state) {
  if (Object.getOwnPropertyDescriptor(globalThis, "currentRows")) {
    return;
  }
  Object.defineProperty(globalThis, "currentRows", {
    configurable: true,
    get: () => state.currentRows,
  });
}

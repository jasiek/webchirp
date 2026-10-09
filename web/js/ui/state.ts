import type { RuntimeInfo } from "../python-sources.ts";
import type { CatalogRadio, RuntimeApi } from "../runtime-rpc.ts";
import type { ChannelRow, RadioMetadata } from "./channel-values.ts";

// Cross-module UI state. Only state that genuinely spans several UI modules
// lives here; state used by a single module (row selection, settings validation
// keys, serial connection flags) stays private to that module and is reached
// through its accessors.

/**
 * The handle web/js/ui/radio-session.js keeps for the runtime session behind
 * the selected radio. Created synchronously at selection; its id arrives when
 * the runtime answers, through ready.
 */
export interface RadioSessionHandle {
  /** The selection the session is for. */
  radio: CatalogRadio | null;
  /** The runtime's session id; "" until ready settles. */
  id: string;
  /** Metadata and settings have both been applied. */
  loaded: boolean;
  /** A metadata/settings load is in flight. */
  loading: boolean;
  /** The session was released; nothing may use it. */
  closed: boolean;
  /** The runtime refused to open it. */
  failed: boolean;
  /** Resolves to id once open. */
  ready: Promise<string>;
}

/** State that genuinely spans UI modules; see the comment above. */
export interface UiState {
  /** Read through requireRuntimeApi(). */
  runtimeApi: RuntimeApi | null;
  /** The grid's CHIRP columns, in order. */
  currentHeaders: string[];
  /** Replaced, not mutated, by row operations. */
  currentRows: ChannelRow[];
  codeplugSource: "" | "radio" | "csv" | "img" | "mixed";
  radioCatalog: CatalogRadio[];
  selectedRadio: CatalogRadio | null;
  radioSession: RadioSessionHandle | null;
  radioMetadata: RadioMetadata;
  runtimeInfo: RuntimeInfo | {chirpRevision: string};
  currentEditorView: "channels" | "settings";
  lastUsbVendorId: string;
  lastUsbProductId: string;
}

export function createUiState(): UiState {
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
export function requireRuntimeApi(state: UiState): RuntimeApi {
  if (!state.runtimeApi) {
    throw new Error("Runtime API client is not initialized");
  }
  return state.runtimeApi;
}

// Expose the live channel rows for debugging from the browser console. Defined
// as a getter so it always reflects the current array identity, which the
// channel operations replace rather than mutate in place.
export function exposeCurrentRowsForDebugging(state: UiState) {
  if (Object.getOwnPropertyDescriptor(globalThis, "currentRows")) {
    return;
  }
  Object.defineProperty(globalThis, "currentRows", {
    configurable: true,
    get: () => state.currentRows,
  });
}

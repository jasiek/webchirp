import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs";
import { createCallQueue } from "./call-queue.ts";
import {
  PORT_SELECTION_CANCELLED_MESSAGE,
  createPortSelectionCancelledError,
  isPortSelectionCancelled,
} from "./serial-errors.ts";
import {
  findCatalogRadioForImageMetadata,
  loadImageWithDriverFallback,
} from "./image-metadata.ts";
import {
  createBootstrapCrashReporter,
  markBootstrapFailure,
} from "./runtime-bootstrap.ts";
import { createSelectedDriverRuntime } from "./selected-driver-runtime.ts";
import { installSerialBridgeGlobals } from "./serial-globals.ts";
import { rpcDispatcherFor } from "./rpc-dispatch.ts";
import { runtimeErrorDetail } from "./runtime-errors.ts";
import { RUNTIME_PYTHON_URLS } from "./runtime-python-urls.ts";
import {
  CHIRP_BUNDLE_DIR,
  createBrowserPythonSource,
  DEFAULT_CHIRP_REVISION,
  driverSetFromSearch,
  listDriverModules,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
  seedPyodideRuntime,
} from "./python-sources.ts";
import type { RuntimeInfo } from "./python-sources.ts";
import type { RpcMethodName, RpcParams } from "./rpc-dispatch.ts";
import type { SerialRpcHandler, SerialRpcMessage } from "./serial-globals.ts";
import type { SerialConnectResult } from "./serial-bridge.ts";
import type { ChannelRow, RadioMetadata } from "./ui/channel-values.ts";
import type { ExtraField, SettingValueMeta } from "./ui/setting-fields.ts";
import type { PyodideInterface } from "pyodide";

/**
 * One radio the catalog offers, as list_registered_radios
 * (web/python/webchirp_bridge/chirp_loader.py) and the prebuilt
 * web/radio-catalog.json describe it.
 */
export interface CatalogRadio {
  /** "module:ClassName", unique per driver class. */
  key: string;
  /** The driver module's short name. */
  module: string;
  className: string;
  vendor: string;
  model: string;
  baudRate?: number;
  /** Live-mode drivers have no clone image. */
  isLiveRadio?: boolean;
  /** Separates drivers that share vendor and model. */
  variant?: string;
  /** Rebadges of the same radio, searchable by their own names. */
  aliases?: {vendor: string, model: string, variant?: string}[];
}

/** A payload naming the radio session a call is for. */
export interface SessionPayload {
  sessionId?: string;
}

/** A session-bound payload that carries the grid's rows. */
export type RowsPayload = SessionPayload & {rows?: object[]};

/** A session-bound payload that carries rows and serialized radio settings. */
export type CodeplugPayload = SessionPayload & { rows?: object[]; settings?: SettingNode[] };

/** What the app shell hands createRuntimeRpcClient(). */
export interface RuntimeRpcClientOptions {
  /** Answers the serial ops Python sends through the bridge globals. */
  handleSerialRpc: SerialRpcHandler;
  logDebug?: (message: string, options?: {isError?: boolean}) => void;
  onProgress?: (label: string, total: number) => {update(done: number): void, end(): void};
  onRuntimeCrash?: (message: string) => void;
}

/** A setting's place in the settings tree: the ids from the root down. */
export type SettingPath = string[];

/**
 * One node of a radio's settings tree, as _serialize_setting_node
 * (web/python/webchirp_bridge/radio_settings.py) writes it: a group of nodes,
 * or a setting with one or more values.
 */
export type SettingNode = SettingGroupNode | SettingLeafNode;

interface SettingNodeBase {
  id: string;
  label: string;
  doc: string | null;
  path: SettingPath;
}

export interface SettingGroupNode extends SettingNodeBase {
  kind: "group";
  children: SettingNode[];
}

export interface SettingLeafNode extends SettingNodeBase {
  kind: "setting";
  mutable: boolean;
  volatile: boolean;
  warning: string | null;
  values: SettingValueMeta[];
}

/** One problem with one setting value: where it is and what is wrong. */
export interface SettingIssue {
  path: SettingPath;
  valueIndex: number;
  message: string;
}

/** get_radio_settings: the settings tree, or why there is none. */
export interface RadioSettingsResult {
  supported: boolean;
  available: boolean;
  requiresImage: boolean;
  message: string;
  error: string;
  groups: SettingNode[];
}

/** validate_radio_settings: what the edited tree would write, and what not. */
export interface SettingsValidationResult {
  valid: boolean;
  issues: SettingIssue[];
  settings: SettingNode[];
  available: boolean;
  requiresImage: boolean;
  message: string;
  error: string;
}

/** One preflight finding: the row, the grid column to mark and the message. */
export interface RowIssue {
  rowIndex: number;
  column: string;
  message: string;
}

/** validate_rows_for_upload: errors block an upload, warnings do not. */
export interface RowsValidationResult {
  valid: boolean;
  issues: RowIssue[];
  warnings: RowIssue[];
}

/**
 * One write the grid makes to a row, as normalize_and_validate_rows
 * (web/python/webchirp_bridge/row_validation.py) applies it: the column, the
 * text as typed, and whether a column the grid renders read-only may take it
 * (row builders and paste fill those; a cell edit does not).
 */
export interface RowEdit {
  column: string;
  value: string;
  allowReadOnly?: boolean;
}

/** One row to check: the row as stored, and the edits to apply to it in order. */
export interface RowEditRequest {
  row: ChannelRow;
  edits: RowEdit[];
}

/** What one edit stored, and whether that is what was asked for. */
export interface CellOutcome {
  column: string;
  /** The value the cell now holds. */
  value: string;
  /** False when value is a fallback or a clamp, not the caller's value. */
  accepted: boolean;
  /** What happened, in a few words, or "" when the value was stored as typed. */
  note: string;
}

/** One finding on one cell of a checked row. */
export interface CellFinding {
  column: string;
  message: string;
}

/** One checked row: its edits' outcomes, then what the driver said about the row. */
export interface RowEditResult {
  cells: CellOutcome[];
  /** Errors: the radio will refuse this row as it stands. */
  issues: CellFinding[];
  warnings: CellFinding[];
}

/** normalize_and_validate_rows: one result per request, in request order. */
export interface RowEditsResult {
  rows: RowEditResult[];
}

/** parse_csv: the rows CHIRP's CSV driver read, and its complaints. */
export interface ParsedCsv {
  headers: string[];
  rows: ChannelRow[];
  errors: string[];
}

/** A codeplug read out of a radio instance (_read_radio_payload). */
export interface RadioContents {
  rows: ChannelRow[];
  headers: string[];
  settings: SettingNode[];
  /** Memory numbers the driver could not decode. */
  unreadableChannels: number[];
}

/** download_selected_radio: the codeplug read, plus its CSV text. */
export interface DownloadResult extends RadioContents {
  csvText: string;
  /**
   * Read by the download path's IDENT log line, but no runtime method sends
   * it today (clone.py returns rows, headers, settings, unreadableChannels
   * and csvText), so that line never prints.
   */
  ident?: string;
}

/** load_image_base64: the session the image opened, and its codeplug. */
export interface LoadedImage extends RadioContents {
  sessionId: string;
  module: string;
  className: string;
  vendor: string;
  model: string;
  variant: string;
}

/** export_image_base64: the image the rows and settings make. */
export interface ExportedImage {
  imageBase64: string;
  size: number;
  vendor: string;
  model: string;
  variant: string;
  settings: SettingNode[];
}

/** upload_selected_radio: the settings as the radio now holds them. */
export interface UploadResult {
  uploaded: true;
  settings: SettingNode[];
}

/** get_channel_extra: one memory's extra settings, or why there are none. */
export interface ChannelExtraResult {
  available: boolean;
  message: string;
  fields: ExtraField[];
}

/** open_session: the session's id and what it holds (RadioSession.describe()). */
export interface SessionDescription {
  sessionId: string;
  module: string;
  className: string;
  detectedClass: string;
  imageOrigin: string;
  hasBackingImage: boolean;
  imageSize: number;
  unreadableChannels: number[];
}

/** read_image_metadata_base64: the identity an image's trailer records. */
export interface ImageMetadata {
  hasMetadata: boolean;
  rclass?: string;
  vendor?: string;
  model?: string;
  /** null when the trailer records none, which CHIRP reads as any. */
  variant?: string | null;
}

/** import_all_driver_modules: how the sweep went. */
export interface DriverImportResult {
  imported: number;
  /** Module name to the reason it would not import. */
  failed: Record<string, string>;
  registered: number;
}

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const CHIRP_REVISION = DEFAULT_CHIRP_REVISION;
const DRIVER_SET = driverSetFromSearch(globalThis.location?.search);

// The CHIRP archive and its manifest live beside the app under web/chirp/
// (scripts/build-chirp-bundle.ts), named by the pin rather than hashed, so
// the directory is resolved from this module's own URL the way the static
// catalog is below and needs no entry in RUNTIME_PYTHON_URLS
// (web/js/runtime-python-urls.ts). scripts/build-dist.ts puts every bundled
// module in dist/js/, the depth this file has in web/js/, so the relative
// URL resolves the same in whichever chunk this code lands in.
const pythonSource = createBrowserPythonSource({
  chirpRevision: CHIRP_REVISION,
  driverSet: DRIVER_SET,
  runtimeFileUrls: RUNTIME_PYTHON_URLS,
  chirpBundleBaseUrl: new URL(`../${CHIRP_BUNDLE_DIR}/`, import.meta.url),
});

let pyodide: PyodideInterface | undefined;
let radioCatalogCache: CatalogRadio[] | null = null;
// Which path filled radioCatalogCache: "static" (prebuilt file) or "sources"
// (every driver imported in Pyodide). Reported to callers because the fallback
// is otherwise silent, and it costs a user the whole Pyodide boot before the
// dropdowns can appear.
let radioCatalogSource = "";
let allDriverModulesPromise: Promise<DriverImportResult> | null = null;
let handleSerialRpc: RuntimeRpcClientOptions["handleSerialRpc"] | null = null;
let debugLog: RuntimeRpcClientOptions["logDebug"] | null = null;
let beginProgress: RuntimeRpcClientOptions["onProgress"] | null = null;

// One debug line per driver would bury every other diagnostic in the panel, and
// none per driver leaves a stalled sweep looking identical to a working one.
// Narrate every Nth module instead; the progress strip carries the rest.
const DRIVER_LOG_INTERVAL = 25;

// All Pyodide-backed methods must run one at a time; see web/js/call-queue.ts.
const enqueueRuntimeCall = createCallQueue();

// Dispatch one serial op message to the app's browser-serial bridge handler,
// which createRuntimeRpcClient() supplies after the globals are installed.
async function serialRpc(msg: SerialRpcMessage): Promise<unknown> {
  if (!handleSerialRpc) {
    throw new Error("Serial RPC handler is not configured");
  }
  return handleSerialRpc(msg);
}

// Import the selected driver from the mounted CHIRP tree before any radio-bound call.
async function ensureSelectedRadioModules(moduleShortName: string): Promise<void> {
  if (!moduleShortName) {
    await ensurePyodide();
    return;
  }
  pyodide = await runtimeBootstrap.select(moduleShortName);
  await rpc("ensure_radio_module", { module_short_name: moduleShortName });
}

// Import every driver module once per session. Only the metadata-less image
// path needs this: it is the one case where nothing identifies the driver up
// front, so detection has to try them all. Importing ~190 modules takes seconds
// of main-thread time, so this is deliberately not done eagerly.
async function ensureAllDriverModules() {
  if (DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    throw new Error("Select the matching firmware release before opening an image.");
  }
  if (!allDriverModulesPromise) {
    allDriverModulesPromise = (async () => {
      const modules = await listDriverModules(pythonSource);
      await ensurePyodide();

      // Every driver module is executed on the main thread, so this is by far
      // the longest operation the app runs. Report it: an unannounced multi-
      // second freeze is indistinguishable from a hang.
      const progress = beginProgress
        ? beginProgress("Identifying radio: loading CHIRP drivers", modules.length)
        : null;
      if (debugLog) {
        debugLog(
          `DRIVERS image identifies no driver; importing all ${modules.length} `
          + "driver modules so match_model can run",
        );
      }

      const reportProgress = (done: number, total: number, moduleShort: string) => {
        progress?.update(done);
        if (debugLog && (done % DRIVER_LOG_INTERVAL === 0 || done === total)) {
          debugLog(`DRIVERS ${done}/${total} imported (latest ${moduleShort})`);
        }
      };

      try {
        const result = await rpc<DriverImportResult>("import_all_driver_modules", {
          module_short_names: modules,
          callback: reportProgress,
        });
        if (debugLog) {
          const failed = Object.entries(result.failed || {});
          debugLog(
            `DRIVERS imported ${result.imported}/${modules.length} modules, `
            + `${result.registered} radio classes registered`,
          );
          for (const [moduleName, error] of failed) {
            debugLog(`DRIVERS SKIP ${moduleName}: ${error}`);
          }
        }
        return result;
      } finally {
        // The strip must come down on the failure path too, or a failed sweep
        // leaves a frozen bar on screen for the rest of the session.
        progress?.end();
      }
    })().catch((error) => {
      // Let a later load retry rather than caching the failure for the session.
      allDriverModulesPromise = null;
      throw error;
    });
  }
  return allDriverModulesPromise;
}

// A copy of the catalog in vendor-then-model order, as the pickers list it.
function sortRadioCatalog(radios: CatalogRadio[]): CatalogRadio[] {
  return radios.slice().sort((a, b) => {
    const av = `${a.vendor} ${a.model}`;
    const bv = `${b.vendor} ${b.model}`;
    return av.localeCompare(bv);
  });
}

// Prefer a prebuilt static catalog so dropdowns can populate without booting
// Pyodide or importing every driver. Returns null if it is missing/unusable
// or was generated from a different CHIRP revision than this runtime, so
// callers fall back to live enumeration.
async function loadRadioCatalogFromStatic() {
  try {
    const catalogFile = DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET
      ? "../radio-catalog-quansheng-unofficial.json"
      : "../radio-catalog.json";
    const url = new URL(catalogFile, import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (data?.chirpRevision !== CHIRP_REVISION) {
      if (debugLog) {
        debugLog(
          `CATALOG SKIP static catalog is for chirp ${data?.chirpRevision || "unknown"}, `
          + `runtime is pinned to ${CHIRP_REVISION}; falling back to live enumeration`,
        );
      }
      return null;
    }
    if (data?.driverSet !== DRIVER_SET) {
      debugLog?.(
        `CATALOG SKIP static catalog is for drivers ${data?.driverSet || "unknown"}, `
        + `runtime requested ${DRIVER_SET}; falling back to live enumeration`,
      );
      return null;
    }
    const radios = data?.radios;
    if (!Array.isArray(radios) || radios.length === 0) {
      return null;
    }
    return radios;
  } catch {
    return null;
  }
}

// Build the radio catalog by importing every driver in Pyodide (slow first run).
async function loadRadioCatalogFromSources(): Promise<CatalogRadio[]> {
  const modules = await listDriverModules(pythonSource);

  await ensurePyodide();
  const allRadios = await rpc<CatalogRadio[]>("list_registered_radios", { module_short_names: modules });

  allRadios.sort((a, b) => {
    const av = `${a.vendor}\u0000${a.model}`;
    const bv = `${b.vendor}\u0000${b.model}`;
    return av.localeCompare(bv);
  });

  radioCatalogCache = allRadios;
  radioCatalogSource = "sources";
  return allRadios;
}

// Resolve the radio catalog, preferring the prebuilt static file so the
// dropdowns appear without waiting on Pyodide + per-driver imports.
async function loadRadioCatalog() {
  if (radioCatalogCache) {
    return radioCatalogCache;
  }
  const fromStatic = await loadRadioCatalogFromStatic();
  if (fromStatic) {
    radioCatalogCache = sortRadioCatalog(fromStatic);
    radioCatalogSource = "static";
    return radioCatalogCache;
  }
  if (DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    throw new Error("The unofficial driver catalog is unavailable. Reload the page to retry.");
  }
  return loadRadioCatalogFromSources();
}

// Lazily initialize Pyodide, mount the CHIRP archive, and load the runtime bridge.
// The handle is returned rather than assigned mid-sequence so that nothing can
// observe a runtime that loaded but failed to seed.
const runtimeBootstrap = createSelectedDriverRuntime({
  isolated: DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET,
  async loadRuntime() {
    installSerialBridgeGlobals(globalThis, serialRpc);
    const loaded = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    await seedPyodideRuntime(loaded, pythonSource);
    return loaded;
  },
});

async function ensurePyodide() {
  pyodide = await runtimeBootstrap.ensure();
  return pyodide;
}

async function requirePyodide() {
  await ensurePyodide();
}

// Call one Python runtime method on a given interpreter; the dispatcher is
// memoized per interpreter in web/js/rpc-dispatch.ts.
/**
 * @returns The method's JSON-decoded result.
 */
// T is what the Python method returns, as its JSON decodes; the dispatcher
// cannot know it, so each call site names it.
function rpcOn<T = unknown>(interpreter: PyodideInterface, name: RpcMethodName, params: RpcParams = {}): Promise<T> {
  return rpcDispatcherFor(interpreter).call(name, params);
}

// Call one Python runtime method on the current interpreter. Resolved per
// call rather than held, because ensureSelectedRadioModules() can swap the
// interpreter under the isolated driver set.
function rpc<T = unknown>(name: RpcMethodName, params: RpcParams = {}): Promise<T> {
  return rpcOn<T>(currentInterpreter(), name, params);
}

// The interpreter radio-bound calls go to right now. Every caller boots it
// first (ensurePyodide() or ensureSelectedRadioModules()), so reaching this
// without one is a sequencing bug; it is named here rather than surfacing as a
// TypeError from inside the dispatcher.
function currentInterpreter(): PyodideInterface {
  if (!pyodide) {
    throw new Error("The Python runtime has not been loaded yet");
  }
  return pyodide;
}

// Which interpreter owns each open radio session. A session lives inside the
// interpreter that opened it (web/python/webchirp_bridge/session.py keeps the
// registry per interpreter), and the isolated Quansheng driver set boots a
// fresh interpreter per release, so a call for a session has to reach the
// interpreter that holds it rather than whichever is current. This map is
// that routing; ordinary CHIRP mode has one interpreter and every entry
// points at it.
const sessionRuntimes: Map<string, PyodideInterface> = new Map();

// Record which interpreter a freshly opened session lives in.
function registerSession(sessionId: string | undefined, interpreter: PyodideInterface): void {
  if (sessionId) {
    sessionRuntimes.set(String(sessionId), interpreter);
  }
}

// The interpreter holding a session, or a clear error for one that is not
// open. Raised here, on the JS side, so a closed session fails the same way
// whether or not its interpreter still exists.
function runtimeForSession(sessionId: string | undefined): PyodideInterface {
  const owner = sessionRuntimes.get(String(sessionId || ""));
  if (!owner) {
    throw new Error(
      `Radio session ${sessionId || "(none)"} is not open: it was closed or never opened. `
      + "Select a radio first.",
    );
  }
  return owner;
}

// Run one radio-bound method against the interpreter that owns its session.
function sessionRpc<T>(sessionId: string | undefined, name: RpcMethodName, params: RpcParams = {}): Promise<T> {
  return rpcOn<T>(runtimeForSession(sessionId), name, { session_id: String(sessionId), ...params });
}

// The methods that work without a radio (CSV export, the row preflight and
// the per-edit row check): with a session they route to its interpreter, without one they
// run on the current interpreter with an empty id, which the Python side
// reads as "no radio selected".
async function optionalSessionRpc<T>(
  sessionId: string | undefined,
  name: RpcMethodName,
  params: RpcParams = {},
): Promise<T> {
  if (sessionId) {
    return sessionRpc<T>(sessionId, name, params);
  }
  await requirePyodide();
  return rpc<T>(name, { session_id: "", ...params });
}

async function handleGetRuntimeInfo(): Promise<RuntimeInfo> {
  return pythonSource.getRuntimeInfo();
}

/**
 * @returns source says
 *   which path filled the catalog: "static" or "sources".
 */
async function handleListRadios(): Promise<{ radios: CatalogRadio[]; source: string }> {
  const radios = await loadRadioCatalog();
  return { radios, source: radioCatalogSource };
}

// The schema the grid runs on before a radio is selected: CHIRP's generic CSV
// driver reporting its own RadioFeatures, headers and columns alike. See
// get_default_schema (web/python/webchirp_bridge/column_metadata.py).
async function handleGetDefaultSchema(): Promise<RadioMetadata> {
  await requirePyodide();
  return rpc<RadioMetadata>("get_default_schema");
}

/**
 * @returns The rows and headers parse_csv found.
 */
async function handleParseCsv(payload: { csvText?: string } = {}): Promise<ParsedCsv> {
  await requirePyodide();
  return rpc<ParsedCsv>("parse_csv", { csv_text: String(payload.csvText ?? "") });
}

// Open a radio session for a catalog entry: import its driver (which, under
// the isolated driver set, may boot the interpreter for that release), then
// register the session with the interpreter that holds it.
async function handleOpenRadioSession(
  payload: { module?: string; className?: string } = {},
): Promise<SessionDescription> {
  await requirePyodide();
  await ensureSelectedRadioModules(payload.module || "");
  const owner = currentInterpreter();
  const result = await rpcOn<SessionDescription>(owner, "open_session", {
    module_name: payload.module || "",
    class_name: payload.className || "",
  });
  registerSession(result.sessionId, owner);
  return result;
}

// Close a radio session in the interpreter that holds it. Quiet for an id
// this side never saw: the UI closes the previous selection's session without
// waiting to learn whether it ever finished opening.
async function handleCloseRadioSession(
  payload: SessionPayload = {},
): Promise<{ closed: boolean; sessionId: string }> {
  const sessionId = String(payload.sessionId || "");
  const owner = sessionRuntimes.get(sessionId);
  if (!owner) {
    return { closed: false, sessionId };
  }
  sessionRuntimes.delete(sessionId);
  return rpcOn<{ closed: boolean; sessionId: string }>(owner, "close_session", { session_id: sessionId });
}

// The rows as CHIRP's own CSV, through the selected driver when there is one.
async function handleNormalizeRows(payload: RowsPayload = {}): Promise<string> {
  return optionalSessionRpc<string>(payload.sessionId, "normalize_rows", {
    rows: payload.rows || [],
  });
}

/**
 * @returns The preflight's per-cell findings.
 */
async function handleValidateRowsForUpload(payload: RowsPayload = {}): Promise<RowsValidationResult> {
  return optionalSessionRpc<RowsValidationResult>(payload.sessionId, "validate_rows_for_upload", {
    rows: payload.rows || [],
  });
}

// Apply the grid's edits to rows by the radio's own column rules and check
// each resulting row the way the upload preflight does, so a cell shows the
// value the radio will hold and the driver's objection as soon as it is
// committed. Without a session the default schema's rules apply.
/**
 * @returns One result per request, in request order.
 */
async function handleNormalizeAndValidateRows(
  payload: SessionPayload & { rows?: RowEditRequest[] } = {},
): Promise<RowEditsResult> {
  return optionalSessionRpc<RowEditsResult>(payload.sessionId, "normalize_and_validate_rows", {
    rows: payload.rows || [],
  });
}

/**
 * @returns The base64 image and its file name.
 */
async function handleExportImage(payload: CodeplugPayload = {}): Promise<ExportedImage> {
  return sessionRpc<ExportedImage>(payload.sessionId, "export_image_base64", {
    rows: payload.rows || [],
    settings_groups: payload.settings || [],
  });
}

// An image load opens a session of its own in Python for the driver the
// image names (load_image_base64 in web/python/webchirp_bridge/images.py);
// record which interpreter it lives in before the UI adopts it.
async function loadImageIntoSession(image_b64: string): Promise<LoadedImage> {
  const owner = currentInterpreter();
  const result = await rpcOn<LoadedImage>(owner, "load_image_base64", { image_b64 });
  registerSession(result?.sessionId, owner);
  return result;
}

/**
 * @param payload module and className name the selected release under the isolated
 *   driver set; ordinary CHIRP mode detects the driver from the image.
 * @returns The session the image opened, its rows and settings.
 */
async function handleLoadImage(
  payload: { imageBase64?: string; module?: string; className?: string } = {},
): Promise<LoadedImage> {
  if (DRIVER_SET === QUANSHENG_UNOFFICIAL_DRIVER_SET) {
    const selected = (await loadRadioCatalog()).find((radio) =>
      radio.module === payload.module && radio.className === payload.className);
    if (!selected) {
      throw new Error("Select the matching firmware release before opening an image.");
    }
    await ensureSelectedRadioModules(selected.module);
    // Native CHIRP metadata detection now sees only the selected release.
    return loadImageIntoSession(payload.imageBase64 || "");
  }
  await requirePyodide();
  const image_b64 = payload.imageBase64 || "";
  // CHIRP image detection only searches drivers that are already imported, so
  // read the metadata trailer first and import the matching driver module.
  const metadata = await rpc<ImageMetadata>("read_image_metadata_base64", { image_b64 });
  let resolvedDriver: CatalogRadio | null = null;
  if (metadata?.hasMetadata) {
    const radios = await loadRadioCatalog();
    const match = findCatalogRadioForImageMetadata(radios, metadata);
    if (match && match.isLiveRadio) {
      // Image metadata is matched on the stored rclass name first, which can
      // land on a live-mode driver that shares a class name with the clone-mode
      // one (Kenwood TS-480). A live radio never owns a clone image, so treat
      // this as unresolved and let match_model pick the real driver.
      if (debugLog) {
        debugLog(
          `IMAGE METADATA ignoring live-mode driver ${match.module}.${match.className} `
          + `for clone image ${metadata.vendor} ${metadata.model}`,
        );
      }
    } else if (match) {
      await ensureSelectedRadioModules(match.module);
      resolvedDriver = match;
    } else if (debugLog) {
      debugLog(
        `IMAGE METADATA no catalog match for ${metadata.vendor} ${metadata.model} `
        + `(class ${metadata.rclass || "unknown"})`,
      );
    }
  }
  if (!resolvedDriver && debugLog) {
    // Nothing identified the driver: either the image predates the metadata
    // trailer, or its metadata names a model the catalog does not list. Either
    // way the only route left is match_model against every driver, which can
    // only match drivers that have been imported.
    debugLog(
      `IMAGE ${metadata?.hasMetadata ? "metadata unmatched" : "metadata absent"}; `
      + "importing all drivers for detection",
    );
  }
  return loadImageWithDriverFallback({
    resolvedDriver,
    loadImage: () => loadImageIntoSession(image_b64),
    importAllDrivers: () => ensureAllDriverModules(),
    log: debugLog,
  });
}

// The serial bridge's own answer, round-tripped through Python unchanged.
async function handleSerialConnect(payload: { baudRate?: number } = {}): Promise<SerialConnectResult> {
  await requirePyodide();
  return rpc<SerialConnectResult>("webserial_connect", { baudrate: payload.baudRate || 9600 });
}

async function handleSerialDisconnect(): Promise<{ connected: boolean; message: string }> {
  await requirePyodide();
  return rpc<{ connected: boolean; message: string }>("webserial_disconnect");
}

async function handleSerialTxRx(
  payload: { txHex?: string; rxBytes?: number; timeoutMs?: number } = {},
): Promise<{ tx: unknown; rx: unknown }> {
  await requirePyodide();
  return rpc<{ tx: unknown; rx: unknown }>("webserial_txrx_hex", {
    tx_hex: payload.txHex || "",
    rx_bytes: payload.rxBytes || 32,
    timeout_ms: payload.timeoutMs || 1200,
  });
}

/**
 * @returns The downloaded rows, settings and image.
 */
async function handleDownloadSelectedRadio(payload: SessionPayload = {}): Promise<DownloadResult> {
  return sessionRpc<DownloadResult>(payload.sessionId, "download_selected_radio");
}

async function handleUploadSelectedRadio(payload: CodeplugPayload = {}): Promise<UploadResult> {
  return sessionRpc<UploadResult>(payload.sessionId, "upload_selected_radio", {
    rows: payload.rows || [],
    settings_groups: payload.settings || [],
  });
}

async function handleGetRadioMetadata(payload: SessionPayload = {}): Promise<RadioMetadata> {
  return sessionRpc<RadioMetadata>(payload.sessionId, "get_radio_column_metadata");
}

// The driver's own per-channel extra settings for one memory slot, typed the
// way the radio-wide settings are, so the extras modal can render real controls
// instead of guessing from the bare values a row carries.
async function handleGetChannelExtra(
  payload: SessionPayload & { location?: string | number } = {},
): Promise<ChannelExtraResult> {
  return sessionRpc<ChannelExtraResult>(payload.sessionId, "get_channel_extra", {
    location: String(payload.location ?? ""),
  });
}

/**
 * @returns The settings groups get_radio_settings serialized.
 */
async function handleGetRadioSettings(payload: SessionPayload = {}): Promise<RadioSettingsResult> {
  return sessionRpc<RadioSettingsResult>(payload.sessionId, "get_radio_settings");
}

async function handleValidateRadioSettings(
  payload: SessionPayload & { settings?: SettingNode[] } = {},
): Promise<SettingsValidationResult> {
  return sessionRpc<SettingsValidationResult>(payload.sessionId, "validate_radio_settings", {
    settings_groups: payload.settings || [],
  });
}

// The runtime API the app calls, by the names web/app.ts and the UI modules
// use. Most map onto one RPC method; listRadios, loadImage and getRuntimeInfo
// compose several or none. The Python-facing names are in RPC_METHODS
// (web/js/rpc-dispatch.ts). Radio-bound methods take the sessionId that
// openRadioSession handed out for the selected radio.
export const RUNTIME_METHODS = Object.freeze({
  getRuntimeInfo: handleGetRuntimeInfo,
  listRadios: handleListRadios,
  getDefaultSchema: handleGetDefaultSchema,
  parseCsv: handleParseCsv,
  openRadioSession: handleOpenRadioSession,
  closeRadioSession: handleCloseRadioSession,
  normalizeRows: handleNormalizeRows,
  validateRowsForUpload: handleValidateRowsForUpload,
  normalizeAndValidateRows: handleNormalizeAndValidateRows,
  exportImage: handleExportImage,
  loadImage: handleLoadImage,
  serialConnect: handleSerialConnect,
  serialDisconnect: handleSerialDisconnect,
  serialTxRx: handleSerialTxRx,
  downloadSelectedRadio: handleDownloadSelectedRadio,
  uploadSelectedRadio: handleUploadSelectedRadio,
  getRadioMetadata: handleGetRadioMetadata,
  getChannelExtra: handleGetChannelExtra,
  getRadioSettings: handleGetRadioSettings,
  validateRadioSettings: handleValidateRadioSettings,
});

// getRuntimeInfo never enters Pyodide, and error reporting relies on it even
// while a queued call is stuck; every other method must wait its turn.
const UNQUEUED_METHODS = new Set(["getRuntimeInfo"]);

/**
 * The runtime client the UI holds (state.runtimeApi): every RUNTIME_METHODS
 * handler under its own name and signature, queued and with its failures
 * logged.
 */
export type RuntimeApi = {readonly [K in keyof typeof RUNTIME_METHODS]: (typeof RUNTIME_METHODS)[K]};

// Build the client: install the host's callbacks for the module's lifetime and
// wrap every RUNTIME_METHODS handler in the queue and the failure funnel.
export function createRuntimeRpcClient({
  handleSerialRpc: nextHandleSerialRpc,
  logDebug,
  onProgress,
  onRuntimeCrash,
}: RuntimeRpcClientOptions): RuntimeApi {
  handleSerialRpc = nextHandleSerialRpc;
  debugLog = logDebug || null;
  beginProgress = onProgress || null;

  // Null when the host wants no crash reporting, so the failure then falls
  // through to the ordinary action funnel rather than going unreported.
  const reportBootstrapCrash = onRuntimeCrash
    ? createBootstrapCrashReporter(onRuntimeCrash)
    : null;

  function wrapRuntimeMethod(
    name: string,
    handler: (payload: Record<string, unknown>) => Promise<unknown>,
  ) {
    return async function invokeRuntimeMethod(payload: Record<string, unknown> = {}) {
      try {
        if (UNQUEUED_METHODS.has(name)) {
          return await handler(payload);
        }
        return await enqueueRuntimeCall(() => handler(payload));
      } catch (error) {
        // For a runtime failure, its Python traceback followed by the JS
        // frames of the call; for anything else, its own stack.
        const detailedError = runtimeErrorDetail(error);

        // A dismissed port chooser reaches here as a RuntimeCallError like any
        // other failure through Python, but it is not one: the user closed a
        // dialog. Report it as one quiet line and hand the caller the plain
        // named cancellation rather than the Python wrapper around it, so the
        // UI can say what happened instead of showing a stack nobody can act
        // on.
        if (isPortSelectionCancelled(error)) {
          if (logDebug) {
            logDebug(`RUNTIME ${PORT_SELECTION_CANCELLED_MESSAGE}`);
          }
          throw createPortSelectionCancelledError();
        }

        // Only the bootstrap itself is a runtime crash. This used to test the
        // unset pyodide handle, which stood in for "bootstrap failed" but in
        // fact meant "not assigned yet" -- so a failed driver-index fetch
        // (plain HTTP, no Pyodide involved) was reported as a crash, and a
        // failure seeding the bridge was not reported at all.
        const reportedAsCrash = reportBootstrapCrash
          ? reportBootstrapCrash(error, detailedError)
          : false;

        // The crash line already carries the same detail, so a second RUNTIME
        // line would only print the traceback twice.
        if (logDebug && !reportedAsCrash) {
          logDebug(`RUNTIME ERROR ${detailedError}`, { isError: true });
        }

        // Preserve the original message, stack and exception identity for
        // Sentry. Diagnostic frames belong in Debug Output, not in its message.
        // Non-Error throws still need an Error for capture and crash marking.
        const outgoing = error instanceof Error ? error : new Error(detailedError);
        throw reportedAsCrash ? markBootstrapFailure(outgoing) : outgoing;
      }
    };
  }

  const runtimeApi: Record<string, Function> = {};
  for (const [name, handler] of Object.entries(RUNTIME_METHODS)) {
    // Each handler takes its own payload shape; the wrapper only passes it on.
    runtimeApi[name] = wrapRuntimeMethod(name, handler as (payload: Record<string, unknown>) => Promise<unknown>);
  }

  // Built key by key from RUNTIME_METHODS, each wrapper keeping its handler's
  // signature, which is what the cast states.
  return Object.freeze(runtimeApi) as unknown as RuntimeApi;
}

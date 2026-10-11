import {
  base64ToBytes,
  buildExportFileName,
  bytesToBase64,
  undecodedChannelsNote,
} from "./format.ts";
import {
  classifyErrorKind,
  codeplugParams,
  errorTypeName,
  radioEventParams,
  trackEvent,
} from "./analytics.ts";
import { FLOWS, OUTCOMES, recordFlow } from "./metrics.ts";
import { requireRuntimeApi } from "./state.ts";
import {
  CSV_LINK_MAX_ROWS,
  CsvLinkError,
  fetchCsvLink,
  readCsvLink,
} from "../csv-link.ts";
import { keepUrlOutOfReports } from "../sentry.ts";
import type { UiContext } from "../types/ui-context.js";
import type { UiState } from "./state.ts";
import type { ParsedCsv } from "../runtime-rpc.ts";

const LOADABLE_FILE_KINDS = new Map([
  [".csv", "csv"],
  [".img", "img"],
]);

// How long an export's object URL outlives its click. Generous on purpose:
// the browser may still be reading the blob, and holding it costs only memory.
export const DOWNLOAD_URL_LIFETIME_MS = 60_000;

export const DROPPABLE_FILE_DESCRIPTION = "a CHIRP CSV (.csv) or binary codeplug (.img) file";

// Decide which loader a file belongs to, or null when it is neither kind we can
// read. Dispatch is on the extension rather than the MIME type because
// browsers report .img files inconsistently (empty type on some platforms,
// application/octet-stream on others) and report CSV as anything from
// text/csv to application/vnd.ms-excel depending on what is installed.
export function classifyLoadableFile(fileName: string | null | undefined): string | null {
  const extension = String(fileName || "").toLowerCase().match(/\.[^.\\/]+$/)?.[0];
  if (!extension) {
    return null;
  }
  return LOADABLE_FILE_KINDS.get(extension) || null;
}

// Reading and writing channel data as files: CSV parse/export through the
// Python runtime, CHIRP binary .img import/export, drag-and-drop loading of
// either kind, a channel list named by a ?csv_url= link, and the
// replace-or-merge prompt shown when an import would discard channels already
// in the editor.
export function createCodeplugIo(ctx: UiContext) {
  const { dom, state, log } = ctx;
  type ImportChoice = "replace" | "merge" | "cancel";
  let importChoiceResolve: ((choice: ImportChoice) => void) | null = null;
  let csvLinkResolve: ((accepted: boolean) => void) | null = null;
  let fileLoadInFlight = false;
  // dragenter/dragleave fire once per element the pointer crosses, so the
  // overlay is driven by the depth of nested enters rather than by any single
  // leave event.
  let dragDepth = 0;

  // File names are never reported: the format, how the file arrived, and what
  // the user did with the replace-or-merge prompt are the parts that say
  // anything about the feature. "cancelled" is a mode of its own because an
  // abandoned import is the interesting outcome of that prompt.
  function trackCodeplugImport(format: string, source: string, mode: string): void {
    trackEvent("codeplug_import", {
      ...radioEventParams(state.selectedRadio),
      ...codeplugParams(state),
      format,
      import_source: source,
      import_mode: mode,
    });
    // A cancelled import is not a completed flow. The user answered the
    // replace-or-merge prompt with "neither", which is the feature working;
    // counting it here would depress the success rate of a flow that never ran.
    if (mode === "cancelled") {
      return;
    }
    recordFlow(FLOWS.CODEPLUG_IMPORT, OUTCOMES.OK, {
      ...radioEventParams(state.selectedRadio),
      ...codeplugParams(state),
      format,
      import_source: source,
    });
  }

  function isImportChoiceModalOpen() {
    return !dom.importChoiceModalEl.classList.contains("hidden");
  }

  function resolveImportChoice(choice: ImportChoice) {
    if (!importChoiceResolve) {
      return;
    }
    const resolve = importChoiceResolve;
    importChoiceResolve = null;
    dom.importChoiceModalEl.classList.add("hidden");
    resolve(choice);
  }

  // Ask the user what to do with imported channels when the editor already
  // holds real ones. Resolves to "replace", "merge", or "cancel".
  function askImportChoice(message: string): Promise<ImportChoice> {
    dom.importChoiceMessageEl.textContent = message;
    dom.importChoiceModalEl.classList.remove("hidden");
    return new Promise((resolve) => {
      importChoiceResolve = resolve;
    });
  }

  // Parse CSV through Python runtime and refresh table rows and status text.
  async function parseCsvViaRuntime(csvText: string) {
    log.setStatus("Parsing CSV with CHIRP Python...");
    return requireRuntimeApi(state).parseCsv({ csvText });
  }

  // Apply a parsed CSV to the editor: "replace" swaps the channel list out
  // wholesale (Locations come from the file); "merge" appends the imported
  // channels below the existing ones, where they keep the Location the file
  // gave them unless it is out of bounds or already taken by a loaded channel.
  /**
   * @param parsed parse_csv's result.
   * @param csvSource Where the rows came from, for reporting.
   */
  function applyParsedCsv(
    parsed: ParsedCsv,
    mode: "replace" | "merge" = "replace",
    csvSource: UiState["codeplugSource"] = "csv",
  ) {
    const headersFromMeta = state.radioMetadata.headers || [];
    const parsedHeaders = parsed.headers || [];
    state.currentHeaders = headersFromMeta.length ? headersFromMeta : parsedHeaders;
    const imported = parsed.rows || [];
    if (mode === "merge") {
      state.currentRows = state.currentRows.concat(imported);
      state.codeplugSource = "mixed";
      // Merging is an edit: imported channels have to be given somewhere to
      // live that the loaded ones are not already using.
      ctx.table.reconcileLocations();
    } else {
      state.currentRows = imported;
      state.codeplugSource = csvSource;
      // Replacing is not. The file's Locations are the user's data, so they
      // are only sorted into memory order; a duplicate or out-of-bounds one
      // stays wrong until the upload preflight says so.
      ctx.table.sortRowsByLocation();
    }
    ctx.table.clearInvalidHighlights();
    ctx.table.resetRowSelection();
    ctx.table.render();

    const issues = parsed.errors.length
      ? ` (${parsed.errors.length} parse warnings)`
      : "";
    if (mode === "merge") {
      log.setStatus(`Merged ${imported.length} imported channel(s); ${state.currentRows.length} total${issues}.`);
    } else {
      log.setStatus(`Loaded ${state.currentRows.length} channel(s)${issues}.`);
    }
  }

  function isCsvLinkModalOpen() {
    return !dom.csvLinkModalEl.classList.contains("hidden");
  }

  // Close the linked-list confirmation with the user's answer.
  function resolveCsvLink(accepted: boolean) {
    if (!csvLinkResolve) {
      return;
    }
    const resolve = csvLinkResolve;
    csvLinkResolve = null;
    dom.csvLinkModalEl.classList.add("hidden");
    resolve(accepted);
  }

  // Ask the user to accept a linked channel list, naming its host and size.
  // The host is URL.host, which the URL parser has already turned into
  // punycode, so a look-alike Unicode name shows as the xn-- form it really is.
  function askCsvLinkConfirm(host: string, channelCount: number): Promise<boolean> {
    dom.csvLinkMessageEl.textContent = `This link loads ${channelCount} channel(s) from ${host}.`;
    dom.csvLinkModalEl.classList.remove("hidden");
    dom.csvLinkAcceptEl.focus?.();
    return new Promise((resolve) => {
      csvLinkResolve = resolve;
    });
  }

  // Report a linked list the app would not or could not load. These are the
  // link's problems, not the app's, so they get the notice modal and the debug
  // panel but are never captured as errors.
  function reportCsvLinkRefused(error: CsvLinkError) {
    log.logDebug(`CSV LINK REFUSED\n${error.message}${error.cause ? `\n${String(error.cause)}` : ""}`);
    log.setStatus("Linked channel list not loaded (see Debug Output).");
    ctx.notice.show({ title: "Linked channel list not loaded", message: error.message });
  }

  // Load the channel list a ?csv_url= link names: download it under the limits
  // in web/js/csv-link.ts, parse it with CHIRP, then apply it only once the
  // user has accepted it in the confirmation. Called once the boot has the
  // schema of the radio a ?radio= link picked, so the rows land in that
  // radio's columns. Never throws: a page whose link fails still works.
  async function loadCsvFromLink(
    search = window.location?.search || "",
    hash = window.location?.hash || "",
  ): Promise<void> {
    try {
      const link = readCsvLink(search, hash);
      if (!link) {
        return;
      }
      // The list's address names whoever published it, so it is cleared from
      // error reports before the first request for it can leave a breadcrumb.
      keepUrlOutOfReports(link.url.href);
      const host = link.url.host;
      log.logDebug(`CSV LINK ${link.url.href}${link.sha256 ? " (sha256 pinned)" : ""}`);
      if (!ctx.connectivity.isOnline()) {
        throw new CsvLinkError(`You are offline, so the channel list from ${host} cannot be downloaded.`);
      }
      log.setStatus(`Downloading channel list from ${host}...`);
      // Read at call time rather than bound at construction, so the global
      // fetch the page has is the one used.
      const csvText = await fetchCsvLink(link, (input, init) => fetch(input, init));
      const parsed = await parseCsvViaRuntime(csvText);
      const count = (parsed.rows || []).length;
      if (count > CSV_LINK_MAX_ROWS) {
        throw new CsvLinkError(
          `The channel list from ${host} has ${count} channels, more than the `
          + `${CSV_LINK_MAX_ROWS} a linked list may hold. It was not loaded.`,
        );
      }
      if (!(await askCsvLinkConfirm(host, count))) {
        trackCodeplugImport("csv", "link", "cancelled");
        log.setStatus("Linked channel list not loaded.");
        return;
      }
      let mode: "replace" | "merge" = "replace";
      if (ctx.table.hasRealChannels()) {
        const choice = await askImportChoice(
          `The editor holds ${state.currentRows.length} channel(s) that will be lost if replaced. `
          + `The list from ${host} contains ${count} channel(s). `
          + "Replace the existing channels, or merge by appending the imported channels below them?",
        );
        if (choice === "cancel") {
          trackCodeplugImport("csv", "link", "cancelled");
          log.setStatus("Linked channel list not loaded.");
          return;
        }
        mode = choice;
      }
      applyParsedCsv(parsed, mode);
      trackCodeplugImport("csv", "link", mode);
    } catch (error) {
      if (error instanceof CsvLinkError) {
        reportCsvLinkRefused(error);
        return;
      }
      log.reportActionError("Linked channel list", error);
    }
  }

  // Startup state: no channels, but a full column schema in place so the grid
  // can accept a hand-inserted channel, validate it and offer the driver's own
  // pickers before anything has been loaded. That schema is CHIRP's generic
  // CSV driver reporting its own RadioFeatures -- CHIRP has no "no radio"
  // state either, and an editor with nothing loaded is a CSVRadio there. A
  // radio selection replaces the whole thing with that driver's schema.
  async function loadEmptySchema() {
    const defaults = await requireRuntimeApi(state).getDefaultSchema();
    // Only when nothing has claimed the schema yet: a radio restored from the
    // cookie can win this race, and its driver's metadata outranks the CSV
    // driver's.
    if (!state.radioMetadata.headers?.length && defaults.columns) {
      state.radioMetadata = defaults;
    }
    state.currentHeaders = state.radioMetadata.headers?.length
      ? state.radioMetadata.headers
      : (defaults.headers || []);
    state.currentRows = [];
    ctx.table.clearInvalidHighlights();
    ctx.table.resetRowSelection();
    ctx.table.render();
  }

  // Load a CSV file into the editor, asking first when doing so would discard
  // channels the user already has. Shared by the Load button and drops.
  async function importCsvFile(file: File, source = "button"): Promise<void> {
    const parsed = await parseCsvViaRuntime(await file.text());
    let mode: "replace" | "merge" = "replace";
    if (ctx.table.hasRealChannels()) {
      const choice = await askImportChoice(
        `The editor holds ${state.currentRows.length} channel(s) that will be lost if replaced. `
        + `${file.name} contains ${(parsed.rows || []).length} channel(s). `
        + "Replace the existing channels, or merge by appending the imported channels below them?",
      );
      if (choice === "cancel") {
        trackCodeplugImport("csv", source, "cancelled");
        log.setStatus("CSV import cancelled.");
        return;
      }
      mode = choice;
    }
    applyParsedCsv(parsed, mode);
    trackCodeplugImport("csv", source, mode);
  }

  // Save a generated file through a temporary object URL. The anchor is put in
  // the document before it is clicked and the URL is revoked only later:
  // Firefox and Safari start reading the blob after click() returns, so a
  // detached anchor or a same-tick revoke gives a truncated or missing file.
  function downloadBlob(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }

  // Ask Python runtime to normalize current rows and export as CSV file.
  async function exportCsv() {
    log.setStatus("Normalizing rows with CHIRP Python...");
    const csvText = await requireRuntimeApi(state).normalizeRows({
      rows: state.currentRows,
      // Empty when no radio is selected: the rows are then rendered as CHIRP's
      // generic CSV driver's own.
      sessionId: await ctx.session.currentId(),
    });
    const fileName = buildExportFileName(
      state.selectedRadio?.vendor || "webchirp",
      state.selectedRadio?.model || "export",
      "csv",
    );
    downloadBlob(fileName, new Blob([csvText], { type: "text/csv;charset=utf-8" }));
    trackEvent("codeplug_export", {
      ...radioEventParams(state.selectedRadio),
      ...codeplugParams(state),
      format: "csv",
    });
    log.setStatus(`Exported ${fileName}`);
  }

  async function exportBinaryCodeplug() {
    if (!state.selectedRadio) {
      log.setStatus("Search for and select a radio first.");
      return;
    }
    log.setStatus("Preparing CHIRP binary codeplug...");
    const result = await requireRuntimeApi(state).exportImage({
      sessionId: await ctx.session.currentId(),
      rows: state.currentRows,
      settings: ctx.settings.getGroups(),
    });
    ctx.settings.setGroups(result.settings);
    ctx.settings.render();
    const bytes = base64ToBytes(result.imageBase64 || "");
    const fileName = buildExportFileName(
      result.vendor || state.selectedRadio.vendor,
      result.model || state.selectedRadio.model,
      "img",
    );
    downloadBlob(fileName, new Blob([bytes], { type: "application/octet-stream" }));
    trackEvent("codeplug_export", {
      ...radioEventParams(state.selectedRadio),
      ...codeplugParams(state),
      format: "img",
    });
    log.setStatus(`Exported ${fileName}`);
  }

  async function importBinaryCodeplug(file: File, source = "button"): Promise<void> {
    const raw = new Uint8Array(await file.arrayBuffer());
    const imageBase64 = bytesToBase64(raw);
    log.setStatus("Loading CHIRP binary codeplug...");
    const loaded = await requireRuntimeApi(state).loadImage({
      imageBase64,
      module: state.selectedRadio?.module,
      className: state.selectedRadio?.className,
    });
    const selected = ctx.catalog.selectRadioByDetectedImage(loaded);
    // The radio that selection made current, which names the image below.
    const radio = state.selectedRadio;
    if (!selected || !radio) {
      throw new Error(
        `Loaded image radio ${loaded.module}.${loaded.className} is not available in current radio catalog`,
      );
    }
    // The session the selection just adopted: the one the load opened, which
    // holds this image.
    const imageSession = ctx.session.current();
    // Rows first, then the schema built from them: the session holds this
    // image, so the metadata call below reports the detected driver as the
    // image configures it, and the row check it runs (dropUnsupportedPowerValues
    // in web/js/ui/channel-table.ts) has to measure this file's channels rather
    // than whatever the grid still held from before the import.
    //
    // Undone if that call fails, because everything that agrees with these rows
    // -- the headers, the settings, the rendered grid -- is assigned after it,
    // and runFileLoad reports a throw from here as a failed import without
    // re-rendering. Rows left swapped behind a failure notice would show the
    // user the old codeplug while an export or upload wrote the new one.
    const previousRows = state.currentRows;
    state.currentRows = Array.isArray(loaded.rows) ? loaded.rows : [];
    try {
      await ctx.catalog.loadSelectedRadioMetadata();
    } catch (error) {
      state.currentRows = previousRows;
      throw error;
    }
    ctx.settings.replaceState({
      supported: Array.isArray(loaded.settings) && loaded.settings.length > 0,
      available: Array.isArray(loaded.settings) && loaded.settings.length > 0,
      requiresImage: false,
      message: "",
      groups: ctx.settings.cloneGroups(loaded.settings || []),
    });
    ctx.settings.clearInvalid();
    state.currentHeaders = state.radioMetadata.headers?.length
      ? state.radioMetadata.headers
      : (loaded.headers || state.currentHeaders);
    state.codeplugSource = "img";
    ctx.table.sortRowsByLocation();
    ctx.table.clearInvalidHighlights();
    ctx.table.resetRowSelection();
    ctx.table.render();
    ctx.settings.updateViewButtons();
    ctx.settings.render();
    // The image has now supplied both the detected driver's schema and its
    // settings, so its session counts as loaded: reselecting the radio must
    // keep this state rather than reload a blank one.
    ctx.session.markLoaded(imageSession);
    // Reported after the image has selected its radio, so the event names the
    // driver the file turned out to need rather than whatever was selected
    // before the load.
    trackCodeplugImport("img", source, "replace");
    log.setStatus(
      `Loaded binary codeplug for ${loaded.vendor || radio.vendor} ${loaded.model || radio.model}.`
        + undecodedChannelsNote(loaded.unreadableChannels),
    );
  }

  // Serialize file loads. A second load starting while the replace-or-merge
  // prompt is open would overwrite the pending choice and strand the first
  // one's promise forever, and two loads racing to replace the channel list
  // would leave the editor showing whichever finished last.
  async function runFileLoad(
    label: string,
    work: () => Promise<unknown>,
    { format = "unknown", source = "button" }: { format?: string; source?: string } = {},
  ): Promise<void> {
    if (fileLoadInFlight) {
      log.setStatus("A file is already loading; wait for it to finish.");
      return;
    }
    fileLoadInFlight = true;
    try {
      await work();
    } catch (error) {
      // The counterpart to codeplug_import. Without it a file CHIRP could not
      // parse — the most interesting import there is — looks exactly like a
      // file nobody tried to import.
      const errorKind = classifyErrorKind(error);
      const errorType = errorTypeName(error);
      trackEvent("codeplug_import_failed", {
        ...radioEventParams(state.selectedRadio),
        format,
        import_source: source,
        error_kind: errorKind,
        error_type: errorType,
      });
      recordFlow(FLOWS.CODEPLUG_IMPORT, OUTCOMES.FAILED, {
        ...radioEventParams(state.selectedRadio),
        format,
        import_source: source,
        error_kind: errorKind,
        error_type: errorType,
      });
      log.reportActionError(label, error);
    } finally {
      fileLoadInFlight = false;
    }
  }

  // Route a picked or dropped file to the CSV or binary loader by extension.
  async function loadCodeplugFile(file: File, source = "button"): Promise<void> {
    const kind = classifyLoadableFile(file.name);
    if (!kind) {
      log.setStatus(`Cannot load ${file.name}: choose ${DROPPABLE_FILE_DESCRIPTION}.`);
      log.logDebug(`LOAD REJECTED ${file.name} (unsupported file type)`);
      return;
    }
    if (kind === "csv") {
      await importCsvFile(file, source);
      return;
    }
    await importBinaryCodeplug(file, source);
  }

  // Keep the export menu's visible state and expanded label in sync.
  function setExportMenuOpen(open: boolean): void {
    dom.exportMenuEl.hidden = !open;
    dom.exportMenuToggleEl.setAttribute("aria-expanded", String(open));
  }

  // Close the export choices after a selection or outside click.
  function closeExportMenu() {
    setExportMenuOpen(false);
  }

  // Report whether Escape should dismiss the export choices.
  function isExportMenuOpen() {
    return !dom.exportMenuEl.hidden;
  }

  // Only file drags are ours to handle; text dragged within the page (between
  // channel cells, say) must keep its native behaviour.
  function dragCarriesFiles(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes("Files") : false;
  }

  function setDropOverlayVisible(visible: boolean): void {
    dom.dropOverlayEl.classList.toggle("hidden", !visible);
  }

  async function handleFileDrop(event: DragEvent): Promise<void> {
    if (!dragCarriesFiles(event)) {
      return;
    }
    // Without this the browser leaves the app and displays the dropped file.
    event.preventDefault();
    dragDepth = 0;
    setDropOverlayVisible(false);

    const files = Array.from<File>(event.dataTransfer?.files || []);
    if (files.length === 0) {
      return;
    }
    // Named in the log up front so the file is identifiable even when the load
    // fails with a traceback that does not mention it.
    const [file] = files;
    const ignored = files.length > 1 ? `; ignoring ${files.length - 1} other file(s)` : "";
    log.logDebug(`DROP ${file.name}${ignored}`);
    await runFileLoad("File drop", () => loadCodeplugFile(file, "drag_drop"), {
      format: classifyLoadableFile(file.name) || "unknown",
      source: "drag_drop",
    });
  }

  // Files dropped anywhere on the page load into the channel browser, so these
  // listeners live on the window rather than on a single drop target.
  function bindDragAndDrop() {
    window.addEventListener("dragenter", (event) => {
      if (!dragCarriesFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth += 1;
      setDropOverlayVisible(true);
    });

    window.addEventListener("dragover", (event) => {
      if (!dragCarriesFiles(event)) {
        return;
      }
      // A dragover default that is not prevented means "not a drop target",
      // and the drop event never fires.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      // Covers drags that entered the window before the page finished wiring
      // up, which produce dragover without a matching dragenter.
      setDropOverlayVisible(true);
    });

    window.addEventListener("dragleave", (event) => {
      if (!dragCarriesFiles(event)) {
        return;
      }
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setDropOverlayVisible(false);
      }
    });

    window.addEventListener("drop", handleFileDrop);
  }

  function bindEvents() {
    bindDragAndDrop();
    setExportMenuOpen(false);

    dom.importChoiceReplaceEl.addEventListener("click", () => {
      resolveImportChoice("replace");
    });
    dom.importChoiceMergeEl.addEventListener("click", () => {
      resolveImportChoice("merge");
    });
    dom.importChoiceCancelEl.addEventListener("click", () => {
      resolveImportChoice("cancel");
    });
    dom.importChoiceModalEl.addEventListener("click", (event) => {
      if (event.target === dom.importChoiceModalEl) {
        resolveImportChoice("cancel");
      }
    });

    dom.csvLinkAcceptEl.addEventListener("click", () => {
      resolveCsvLink(true);
    });
    dom.csvLinkCancelEl.addEventListener("click", () => {
      resolveCsvLink(false);
    });
    dom.csvLinkModalEl.addEventListener("click", (event) => {
      if (event.target === dom.csvLinkModalEl) {
        resolveCsvLink(false);
      }
    });

    dom.loadCodeplugEl.addEventListener("click", () => {
      dom.fileInput.click();
    });

    dom.fileInput.addEventListener("change", async () => {
      const file = dom.fileInput.files?.[0];
      if (!file) {
        return;
      }

      try {
        await runFileLoad("File load", () => loadCodeplugFile(file), {
          format: classifyLoadableFile(file.name) || "unknown",
        });
      } finally {
        dom.fileInput.value = "";
      }
    });

    dom.exportMenuToggleEl.addEventListener("click", () => {
      setExportMenuOpen(!isExportMenuOpen());
    });

    document.addEventListener("click", (event) => {
      const target = event.target as Node;
      if (isExportMenuOpen()
        && !dom.exportMenuToggleEl.contains(target)
        && !dom.exportMenuEl.contains(target)) {
        closeExportMenu();
      }
    });

    dom.exportCsvEl.addEventListener("click", async () => {
      closeExportMenu();
      try {
        await exportCsv();
      } catch (error) {
        log.reportActionError("Export", error);
      }
    });

    dom.exportBinaryEl.addEventListener("click", async () => {
      closeExportMenu();
      try {
        await exportBinaryCodeplug();
      } catch (error) {
        log.reportActionError("Binary export", error);
      }
    });
  }

  return {
    bindEvents,
    loadEmptySchema,
    loadCsvFromLink,
    isImportChoiceModalOpen,
    resolveImportChoice,
    isCsvLinkModalOpen,
    resolveCsvLink,
    isExportMenuOpen,
    closeExportMenu,
  };
}

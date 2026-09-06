import {
  base64ToBytes,
  buildExportFileName,
  bytesToBase64,
  undecodedChannelsNote,
} from "./format.js";
import {
  classifyErrorKind,
  codeplugParams,
  errorTypeName,
  radioEventParams,
  trackEvent,
} from "./analytics.js";
import { requireRuntimeApi } from "./state.js";

const LOADABLE_FILE_KINDS = new Map([
  [".csv", "csv"],
  [".img", "img"],
]);

export const DROPPABLE_FILE_DESCRIPTION = "a CHIRP CSV (.csv) or binary codeplug (.img) file";

// Decide which loader a file belongs to, or null when it is neither kind we can
// read. Dispatch is on the extension rather than the MIME type because
// browsers report .img files inconsistently (empty type on some platforms,
// application/octet-stream on others) and report CSV as anything from
// text/csv to application/vnd.ms-excel depending on what is installed.
export function classifyLoadableFile(fileName) {
  const extension = String(fileName || "").toLowerCase().match(/\.[^.\\/]+$/)?.[0];
  return LOADABLE_FILE_KINDS.get(extension) || null;
}

// Reading and writing channel data as files: CSV parse/export through the
// Python runtime, CHIRP binary .img import/export, drag-and-drop loading of
// either kind, and the replace-or-merge prompt shown when an import would
// discard channels already in the editor.
export function createCodeplugIo(ctx) {
  const { dom, state, log } = ctx;
  let importChoiceResolve = null;
  let fileLoadInFlight = false;
  // dragenter/dragleave fire once per element the pointer crosses, so the
  // overlay is driven by the depth of nested enters rather than by any single
  // leave event.
  let dragDepth = 0;

  // File names are never reported: the format, how the file arrived, and what
  // the user did with the replace-or-merge prompt are the parts that say
  // anything about the feature. "cancelled" is a mode of its own because an
  // abandoned import is the interesting outcome of that prompt.
  function trackCodeplugImport(format, source, mode) {
    trackEvent("codeplug_import", {
      ...radioEventParams(state.selectedRadio),
      ...codeplugParams(state),
      format,
      import_source: source,
      import_mode: mode,
    });
  }

  function isImportChoiceModalOpen() {
    return !dom.importChoiceModalEl.classList.contains("hidden");
  }

  function resolveImportChoice(choice) {
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
  function askImportChoice(message) {
    dom.importChoiceMessageEl.textContent = message;
    dom.importChoiceModalEl.classList.remove("hidden");
    return new Promise((resolve) => {
      importChoiceResolve = resolve;
    });
  }

  // Parse CSV through Python runtime and refresh table rows and status text.
  async function parseCsvViaRuntime(csvText) {
    log.setStatus("Parsing CSV with CHIRP Python...");
    return requireRuntimeApi(state).parseCsv({ csvText });
  }

  // Apply a parsed CSV to the editor: "replace" swaps the channel list out
  // wholesale (Locations come from the file); "merge" appends the imported
  // channels below the existing ones, where they keep the Location the file
  // gave them unless it is out of bounds or already taken by a loaded channel.
  function applyParsedCsv(parsed, mode = "replace", csvSource = "csv") {
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

  // Startup state: no channels, but a column schema in place so the grid can
  // accept a hand-inserted channel before anything has been loaded. A radio
  // selection replaces these headers with the driver's own.
  async function loadEmptySchema() {
    const defaults = await requireRuntimeApi(state).getDefaultHeaders();
    state.currentHeaders = state.radioMetadata.headers?.length
      ? state.radioMetadata.headers
      : (defaults.headers || []);
    state.currentRows = [];
    ctx.table.clearInvalidHighlights();
    ctx.table.resetRowSelection();
    ctx.table.render();
  }

  // Load a CSV file into the editor, asking first when doing so would discard
  // channels the user already has. Shared by the Import CSV button and drops.
  async function importCsvFile(file, source = "button") {
    const parsed = await parseCsvViaRuntime(await file.text());
    let mode = "replace";
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

  // Trigger client-side download of generated text content as a file.
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBytes(filename, bytes) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Ask Python runtime to normalize current rows and export as CSV file.
  async function exportCsv() {
    log.setStatus("Normalizing rows with CHIRP Python...");
    const csvText = await requireRuntimeApi(state).normalizeRows({
      rows: state.currentRows,
      module: state.selectedRadio?.module || "",
      className: state.selectedRadio?.className || "",
    });
    const fileName = buildExportFileName(
      state.selectedRadio?.vendor || "webchirp",
      state.selectedRadio?.model || "export",
      "csv",
    );
    downloadText(fileName, csvText);
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
      module: state.selectedRadio.module,
      className: state.selectedRadio.className,
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
    downloadBytes(fileName, bytes);
    trackEvent("codeplug_export", {
      ...radioEventParams(state.selectedRadio),
      ...codeplugParams(state),
      format: "img",
    });
    log.setStatus(`Exported ${fileName}`);
  }

  async function importBinaryCodeplug(file, source = "button") {
    const raw = new Uint8Array(await file.arrayBuffer());
    const imageBase64 = bytesToBase64(raw);
    log.setStatus("Loading CHIRP binary codeplug...");
    const loaded = await requireRuntimeApi(state).loadImage({ imageBase64 });
    const selected = ctx.catalog.selectRadioByDetectedImage(loaded);
    if (!selected) {
      throw new Error(
        `Loaded image radio ${loaded.module}.${loaded.className} is not available in current radio catalog`,
      );
    }
    await ctx.catalog.loadSelectedRadioMetadata();
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
    state.currentRows = Array.isArray(loaded.rows) ? loaded.rows : [];
    state.codeplugSource = "img";
    ctx.table.sortRowsByLocation();
    ctx.table.clearInvalidHighlights();
    ctx.table.resetRowSelection();
    ctx.table.render();
    ctx.settings.updateViewButtons();
    ctx.settings.render();
    // The image has now supplied both the detected driver's schema and its
    // settings. Keep the reload short-circuit aligned with that applied state,
    // rather than whichever radio was last loaded through the dropdowns.
    state.lastLoadedRadioKey = state.selectedRadio.key;
    // Reported after the image has selected its radio, so the event names the
    // driver the file turned out to need rather than whatever was selected
    // before the load.
    trackCodeplugImport("img", source, "replace");
    log.setStatus(
      `Loaded binary codeplug for ${loaded.vendor || state.selectedRadio.vendor} ${loaded.model || state.selectedRadio.model}.`
        + undecodedChannelsNote(loaded.unreadableChannels),
    );
  }

  // Serialize file loads. A second load starting while the replace-or-merge
  // prompt is open would overwrite the pending choice and strand the first
  // one's promise forever, and two loads racing to replace the channel list
  // would leave the editor showing whichever finished last.
  async function runFileLoad(label, work, { format = "unknown", source = "button" } = {}) {
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
      trackEvent("codeplug_import_failed", {
        ...radioEventParams(state.selectedRadio),
        format,
        import_source: source,
        error_kind: classifyErrorKind(error),
        error_type: errorTypeName(error),
      });
      log.reportActionError(label, error);
    } finally {
      fileLoadInFlight = false;
    }
  }

  // Route a file to the CSV or binary loader by its extension.
  async function loadCodeplugFile(file) {
    const kind = classifyLoadableFile(file.name);
    if (!kind) {
      log.setStatus(`Cannot load ${file.name}: drop ${DROPPABLE_FILE_DESCRIPTION}.`);
      log.logDebug(`DROP REJECTED ${file.name} (unsupported file type)`);
      return;
    }
    if (kind === "csv") {
      await importCsvFile(file, "drag_drop");
      return;
    }
    await importBinaryCodeplug(file, "drag_drop");
  }

  // Only file drags are ours to handle; text dragged within the page (between
  // channel cells, say) must keep its native behaviour.
  function dragCarriesFiles(event) {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes("Files") : false;
  }

  function setDropOverlayVisible(visible) {
    dom.dropOverlayEl.classList.toggle("hidden", !visible);
  }

  async function handleFileDrop(event) {
    if (!dragCarriesFiles(event)) {
      return;
    }
    // Without this the browser leaves the app and displays the dropped file.
    event.preventDefault();
    dragDepth = 0;
    setDropOverlayVisible(false);

    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) {
      return;
    }
    // Named in the log up front so the file is identifiable even when the load
    // fails with a traceback that does not mention it.
    const [file] = files;
    const ignored = files.length > 1 ? `; ignoring ${files.length - 1} other file(s)` : "";
    log.logDebug(`DROP ${file.name}${ignored}`);
    await runFileLoad("File drop", () => loadCodeplugFile(file), {
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

    dom.importCsvEl.addEventListener("click", () => {
      dom.fileInput.click();
    });

    dom.fileInput.addEventListener("change", async () => {
      const file = dom.fileInput.files?.[0];
      if (!file) {
        return;
      }

      try {
        await runFileLoad("CSV import", () => importCsvFile(file), { format: "csv" });
      } finally {
        dom.fileInput.value = "";
      }
    });

    dom.exportCsvEl.addEventListener("click", async () => {
      try {
        await exportCsv();
      } catch (error) {
        log.reportActionError("Export", error);
      }
    });

    dom.exportBinaryEl.addEventListener("click", async () => {
      try {
        await exportBinaryCodeplug();
      } catch (error) {
        log.reportActionError("Binary export", error);
      }
    });

    dom.importBinaryEl.addEventListener("click", () => {
      dom.imgFileInput.click();
    });

    dom.imgFileInput.addEventListener("change", async () => {
      const file = dom.imgFileInput.files?.[0];
      if (!file) {
        return;
      }
      try {
        await runFileLoad("Binary import", () => importBinaryCodeplug(file), { format: "img" });
      } finally {
        dom.imgFileInput.value = "";
      }
    });
  }

  return {
    bindEvents,
    loadEmptySchema,
    isImportChoiceModalOpen,
    resolveImportChoice,
  };
}

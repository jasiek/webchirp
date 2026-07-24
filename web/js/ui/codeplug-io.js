import { base64ToBytes, buildExportFileName, bytesToBase64 } from "./format.js";
import { requireRuntimeApi } from "./state.js";

const DEFAULT_SAMPLE_CSV = `Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment\n0,Simplex1,146.520000,,0.600000,,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,National Calling\n1,RepeaterA,146.940000,-,0.600000,TSQL,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,Local repeater\n`;

// Reading and writing channel data as files: CSV parse/export through the
// Python runtime, CHIRP binary .img import/export, and the replace-or-merge
// prompt shown when an import would discard channels already in the editor.
export function createCodeplugIo(ctx) {
  const { dom, state, log } = ctx;
  let importChoiceResolve = null;

  function isImportChoiceModalOpen() {
    return Boolean(dom.importChoiceModalEl && !dom.importChoiceModalEl.classList.contains("hidden"));
  }

  function resolveImportChoice(choice) {
    if (!importChoiceResolve) {
      return;
    }
    const resolve = importChoiceResolve;
    importChoiceResolve = null;
    dom.importChoiceModalEl?.classList.add("hidden");
    resolve(choice);
  }

  // Ask the user what to do with imported channels when the editor already
  // holds real ones. Resolves to "replace", "merge", or "cancel".
  function askImportChoice(message) {
    if (!dom.importChoiceModalEl) {
      return Promise.resolve("replace");
    }
    if (dom.importChoiceMessageEl) {
      dom.importChoiceMessageEl.textContent = message;
    }
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
  // channels below the existing ones and renumbers Locations.
  function applyParsedCsv(parsed, mode = "replace") {
    const headersFromMeta = state.radioMetadata.headers || [];
    const parsedHeaders = parsed.headers || [];
    state.currentHeaders = headersFromMeta.length ? headersFromMeta : parsedHeaders;
    const imported = parsed.rows || [];
    if (mode === "merge") {
      state.currentRows = state.currentRows.concat(imported);
      ctx.table.reindexLocationColumn();
    } else {
      state.currentRows = imported;
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

  async function loadCsvText(csvText) {
    applyParsedCsv(await parseCsvViaRuntime(csvText), "replace");
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
    log.setStatus(`Exported ${fileName}`);
  }

  async function exportBinaryCodeplug() {
    if (!state.selectedRadio) {
      log.setStatus("Select a radio make/model first.");
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
    log.setStatus(`Exported ${fileName}`);
  }

  async function importBinaryCodeplug(file) {
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
    ctx.table.clearInvalidHighlights();
    ctx.table.resetRowSelection();
    ctx.table.render();
    ctx.settings.updateViewButtons();
    ctx.settings.render();
    log.setStatus(
      `Loaded binary codeplug for ${loaded.vendor || state.selectedRadio.vendor} ${loaded.model || state.selectedRadio.model}.`,
    );
  }

  function bindEvents() {
    dom.importChoiceReplaceEl?.addEventListener("click", () => {
      resolveImportChoice("replace");
    });
    dom.importChoiceMergeEl?.addEventListener("click", () => {
      resolveImportChoice("merge");
    });
    dom.importChoiceCancelEl?.addEventListener("click", () => {
      resolveImportChoice("cancel");
    });
    dom.importChoiceModalEl?.addEventListener("click", (event) => {
      if (event.target === dom.importChoiceModalEl) {
        resolveImportChoice("cancel");
      }
    });

    document.querySelector("#load-sample").addEventListener("click", async () => {
      try {
        await loadCsvText(DEFAULT_SAMPLE_CSV);
      } catch (error) {
        log.reportActionError("Sample load", error);
      }
    });

    document.querySelector("#import-csv").addEventListener("click", () => {
      dom.fileInput.click();
    });

    dom.fileInput.addEventListener("change", async () => {
      const file = dom.fileInput.files?.[0];
      if (!file) {
        return;
      }

      try {
        const csvText = await file.text();
        const parsed = await parseCsvViaRuntime(csvText);
        let mode = "replace";
        if (ctx.table.hasRealChannels()) {
          const choice = await askImportChoice(
            `The editor holds ${state.currentRows.length} channel(s) that will be lost if replaced. `
            + `The selected file contains ${(parsed.rows || []).length} channel(s). `
            + "Replace the existing channels, or merge by appending the imported channels below them?",
          );
          if (choice === "cancel") {
            log.setStatus("CSV import cancelled.");
            return;
          }
          mode = choice;
        }
        applyParsedCsv(parsed, mode);
      } catch (error) {
        log.reportActionError("CSV import", error);
      } finally {
        dom.fileInput.value = "";
      }
    });

    document.querySelector("#export-csv").addEventListener("click", async () => {
      try {
        await exportCsv();
      } catch (error) {
        log.reportActionError("Export", error);
      }
    });

    document.querySelector("#export-binary").addEventListener("click", async () => {
      try {
        await exportBinaryCodeplug();
      } catch (error) {
        log.reportActionError("Binary export", error);
      }
    });

    document.querySelector("#import-binary").addEventListener("click", () => {
      dom.imgFileInput.click();
    });

    dom.imgFileInput.addEventListener("change", async () => {
      const file = dom.imgFileInput.files?.[0];
      if (!file) {
        return;
      }
      try {
        await importBinaryCodeplug(file);
      } catch (error) {
        log.reportActionError("Binary import", error);
      } finally {
        dom.imgFileInput.value = "";
      }
    });
  }

  return {
    bindEvents,
    loadSampleCsv: () => loadCsvText(DEFAULT_SAMPLE_CSV),
    isImportChoiceModalOpen,
    resolveImportChoice,
  };
}

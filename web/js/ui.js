const DEFAULT_SAMPLE_CSV = `Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment\n0,Simplex1,146.520000,,0.600000,,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,National Calling\n1,RepeaterA,146.940000,-,0.600000,TSQL,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,Local repeater\n`;
const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";

// Create and manage all DOM/UI state and user interaction behavior.
export function createUiController() {
  const statusEl = document.querySelector("#status");
  const tableHead = document.querySelector("#mem-table thead");
  const tableBody = document.querySelector("#mem-table tbody");
  const fileInput = document.querySelector("#csv-file");
  const debugOutputEl = document.querySelector("#debug-output");
  const reportIssueEl = document.querySelector("#report-issue");
  const radioMakeEl = document.querySelector("#radio-make");
  const radioModelEl = document.querySelector("#radio-model");

  let callWorker = null;
  let currentHeaders = [];
  let currentRows = [];
  let radioCatalog = [];
  let selectedRadio = null;
  let radioMetadata = { headers: [], columns: {} };
  let runtimeInfo = { chirpRevision: "" };
  let lastUsbVendorId = "";
  let lastUsbProductId = "";
  let lastErrorSummary = "";

  function setCallWorker(fn) {
    callWorker = fn;
  }

  function requireCallWorker() {
    if (!callWorker) {
      throw new Error("Worker RPC client is not initialized");
    }
    return callWorker;
  }

  // Update the visible status line and mirror it into the debug log stream.
  function setStatus(text) {
    statusEl.textContent = text;
    logDebug(`STATUS ${text}`);
  }

  function maybeEnableIssueButton(line) {
    const text = String(line || "");
    if (!/\b(error|traceback|exception)\b/i.test(text)) {
      return;
    }
    lastErrorSummary = text.replace(/\s+/g, " ").trim().slice(0, 180);
    reportIssueEl?.classList.remove("hidden");
  }

  // Record serial-related events in the central debug output stream.
  function logSerial(line) {
    logDebug(`SERIAL ${String(line || "")}`);
  }

  // Append a timestamped line to the bottom debug console panel.
  function logDebug(line) {
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${String(line || "")}`;
    const current = debugOutputEl.value ? `${debugOutputEl.value}\n` : "";
    debugOutputEl.value = `${current}${text}`;
    debugOutputEl.scrollTop = debugOutputEl.scrollHeight;
    maybeEnableIssueButton(line);
  }

  function detectOperatingSystem() {
    const ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) {
      return "Windows";
    }
    if (/Macintosh|Mac OS X/i.test(ua)) {
      return "macOS";
    }
    if (/Linux|X11/i.test(ua)) {
      return "Linux";
    }
    return "Other";
  }

  function detectBrowserVersion() {
    const ua = navigator.userAgent || "";
    const matchers = [
      [/Edg\/([\d.]+)/, "Microsoft Edge"],
      [/OPR\/([\d.]+)/, "Opera"],
      [/Firefox\/([\d.]+)/, "Firefox"],
      [/Chrome\/([\d.]+)/, "Chrome"],
      [/Version\/([\d.]+).*Safari/, "Safari"],
    ];
    for (const [regex, name] of matchers) {
      const match = ua.match(regex);
      if (match?.[1]) {
        return `${name} ${match[1]}`;
      }
    }
    return navigator.appVersion || "Unknown browser";
  }

  function latestDebugTail(lineCount) {
    const lines = String(debugOutputEl.value || "")
      .split("\n")
      .filter(Boolean);
    if (lines.length <= lineCount) {
      return lines.join("\n");
    }
    return lines.slice(lines.length - lineCount).join("\n");
  }

  function buildIssueUrl() {
    const radioMake = selectedRadio?.vendor || radioMakeEl.value || "Unknown";
    const radioModel = selectedRadio?.model || radioModelEl.value || "Unknown";
    const issueTitle = `Radio bug: ${radioMake} ${radioModel} - ${lastErrorSummary || "runtime error"}`;
    const debugTail = latestDebugTail(120);
    const steps = [
      "1. Connect radio",
      "2. Select radio make/model",
      "3. Run the action that failed",
      "4. Observe the error in Debug Output",
    ].join("\n");
    const actualBehavior = [
      lastErrorSummary || "Error recorded in Debug Output.",
      "",
      "Debug output excerpt:",
      "```",
      debugTail || "<no debug logs captured>",
      "```",
    ].join("\n");

    const params = new URLSearchParams({
      template: ISSUE_TEMPLATE_NAME,
      title: issueTitle.slice(0, 240),
      radio_make: radioMake,
      radio_model: radioModel,
      usb_vendor_id: lastUsbVendorId || "Unknown",
      usb_product_id: lastUsbProductId || "Unknown",
      operating_system: detectOperatingSystem(),
      browser_and_version: detectBrowserVersion(),
      chirp_revision: runtimeInfo.chirpRevision || "unknown",
      steps_to_reproduce: steps,
      expected_behavior: "The radio operation should complete without errors.",
      actual_behavior: actualBehavior,
    });
    return `${ISSUE_NEW_URL}?${params.toString()}`;
  }

  function openPrefilledIssue() {
    const url = buildIssueUrl();
    window.open(url, "_blank", "noopener,noreferrer");
    logDebug("Opened pre-filled GitHub issue form.");
  }

  // Normalize unknown error shapes into a detailed string for diagnostics.
  function errorDetails(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error === "string") {
      return error;
    }
    if (typeof error.stack === "string" && error.stack.length > 0) {
      return error.stack;
    }
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  // Extract a short first-line summary from a detailed error payload.
  function errorSummary(error) {
    const firstLine = errorDetails(error).split("\n")[0].trim();
    return firstLine || "Unknown error";
  }

  // Centralized UI + debug handling for action-level failures.
  function reportActionError(action, error) {
    const details = errorDetails(error);
    logDebug(`${action.toUpperCase()} ERROR\n${details}`);
    setStatus(`${action} failed (see Debug Output).`);
  }

  // Build a short user-facing label for a selected radio catalog entry.
  function makeModelLabel(radio) {
    return `${radio.vendor} ${radio.model}`;
  }

  // Produce a sorted unique list of vendor names from the radio catalog.
  function uniqueVendors(radios) {
    return Array.from(new Set(radios.map((r) => r.vendor))).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  // Populate model dropdown for selected vendor and refresh selection state.
  function refreshModelOptions() {
    const vendor = radioMakeEl.value;
    const models = radioCatalog.filter((r) => r.vendor === vendor);
    radioModelEl.innerHTML = "";

    for (const radio of models) {
      const option = document.createElement("option");
      option.value = radio.key;
      option.textContent = radio.model;
      radioModelEl.appendChild(option);
    }

    const selectedKey = radioModelEl.value || models[0]?.key;
    selectedRadio = models.find((r) => r.key === selectedKey) || null;
    if (selectedRadio) {
      radioModelEl.value = selectedRadio.key;
      logDebug(
        `RADIO SELECT ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
      );
    }
  }

  // Populate make dropdown from catalog and initialize model options.
  function refreshMakeOptions() {
    const vendors = uniqueVendors(radioCatalog);
    radioMakeEl.innerHTML = "";
    for (const vendor of vendors) {
      const option = document.createElement("option");
      option.value = vendor;
      option.textContent = vendor;
      radioMakeEl.appendChild(option);
    }
    if (vendors.length > 0) {
      radioMakeEl.value = vendors[0];
    }
    refreshModelOptions();
  }

  // Parse CHIRP-style frequency text (MHz) to integer Hz for validation checks.
  function parseFreqToHz(value) {
    const text = String(value || "").trim();
    if (!text) {
      return 0;
    }
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return null;
    }
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n)) {
      return null;
    }
    return Math.round(n * 1_000_000);
  }

  // Check whether a frequency in Hz falls within any allowed CHIRP band range.
  function inAnyBand(hz, bands) {
    if (!Array.isArray(bands) || bands.length === 0) {
      return true;
    }
    return bands.some(([lo, hi]) => hz >= Number(lo) && hz < Number(hi));
  }

  // Coerce and constrain edited cell values according to CHIRP column metadata.
  function normalizeValue(column, value, meta, previous) {
    let v = String(value ?? "");
    if (!meta || meta.editable === false) {
      return String(previous ?? v);
    }

    if (meta.kind === "text") {
      if (meta.validChars) {
        const allowed = new Set(String(meta.validChars).split(""));
        v = v
          .split("")
          .filter((ch) => allowed.has(ch))
          .join("");
      }
      if (Number.isFinite(meta.maxLength)) {
        v = v.slice(0, Number(meta.maxLength));
      }
      return v;
    }

    if (meta.kind === "int") {
      const parsed = Number.parseInt(v, 10);
      if (Number.isNaN(parsed)) {
        return String(previous ?? "");
      }
      let out = parsed;
      if (Number.isFinite(meta.min)) {
        out = Math.max(out, Number(meta.min));
      }
      if (Number.isFinite(meta.max)) {
        out = Math.min(out, Number(meta.max));
      }
      return String(out);
    }

    if (meta.kind === "freq") {
      const hz = parseFreqToHz(v);
      if (hz === null) {
        return String(previous ?? "");
      }
      if (!inAnyBand(hz, meta.bands || [])) {
        return String(previous ?? "");
      }
      return v;
    }

    if (meta.kind === "enum") {
      const options = Array.isArray(meta.options) ? meta.options.map(String) : [];
      if (options.length > 0 && !options.includes(v)) {
        return String(previous ?? options[0] ?? "");
      }
      return v;
    }

    return v;
  }

  // Create a table cell editor (input/select) based on CHIRP column metadata.
  function createCellEditor(row, rowIdx, column) {
    const meta = radioMetadata.columns?.[column] || {};
    const current = String(row[column] ?? "");
    const readOnly = column === "Location" || meta.editable === false;
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      const select = document.createElement("select");
      const options = meta.options.map(String);
      if (!options.includes(current)) {
        options.unshift(current);
      }
      for (const opt of options) {
        const optionEl = document.createElement("option");
        optionEl.value = opt;
        optionEl.textContent = opt;
        select.appendChild(optionEl);
      }
      select.value = current;
      select.disabled = readOnly;
      select.addEventListener("change", () => {
        const next = normalizeValue(column, select.value, meta, row[column]);
        row[column] = next;
        currentRows[rowIdx][column] = next;
        select.value = next;
      });
      return select;
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.readOnly = readOnly;
    input.disabled = readOnly;
    if (Number.isFinite(meta.maxLength)) {
      input.maxLength = Number(meta.maxLength);
    }
    input.addEventListener("blur", () => {
      const next = normalizeValue(column, input.value, meta, row[column]);
      row[column] = next;
      currentRows[rowIdx][column] = next;
      input.value = next;
    });
    return input;
  }

  // Render the editable channel table using current rows and metadata rules.
  function renderTable() {
    const columns = currentHeaders.slice();

    tableHead.innerHTML = "";
    tableBody.innerHTML = "";

    const headerRow = document.createElement("tr");
    columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column;
      headerRow.appendChild(th);
    });
    tableHead.appendChild(headerRow);

    currentRows.forEach((row, rowIdx) => {
      const tr = document.createElement("tr");

      columns.forEach((column) => {
        const td = document.createElement("td");
        const editor = createCellEditor(row, rowIdx, column);
        td.appendChild(editor);
        tr.appendChild(td);
      });

      tableBody.appendChild(tr);
    });
  }

  // Load selected radio's CHIRP-derived column metadata from Python runtime.
  async function loadSelectedRadioMetadata() {
    if (!selectedRadio) {
      return;
    }
    const meta = await requireCallWorker()("getRadioMetadata", {
      module: selectedRadio.module,
      className: selectedRadio.className,
    });
    radioMetadata = meta || { headers: [], columns: {} };
    currentHeaders = radioMetadata.headers?.length ? radioMetadata.headers : currentHeaders;
  }

  // Parse CSV through Python runtime and refresh table rows and status text.
  async function loadCsvText(csvText) {
    setStatus("Parsing CSV with CHIRP Python...");
    const parsed = await requireCallWorker()("parseCsv", { csvText });
    const headersFromMeta = radioMetadata.headers || [];
    const parsedHeaders = parsed.headers || [];
    currentHeaders = headersFromMeta.length ? headersFromMeta : parsedHeaders;
    currentRows = parsed.rows;
    renderTable();

    const issues = parsed.errors.length
      ? ` (${parsed.errors.length} parse warnings)`
      : "";
    setStatus(`Loaded ${currentRows.length} channel(s)${issues}.`);
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

  // Ask Python runtime to normalize current rows and export as CSV file.
  async function exportCsv() {
    setStatus("Normalizing rows with CHIRP Python...");
    const csvText = await requireCallWorker()("normalizeRows", { rows: currentRows });
    downloadText("webchirp-export.csv", csvText);
    setStatus("Exported webchirp-export.csv");
  }

  // Register all UI event handlers and action bindings.
  function bindEvents() {
    document.querySelector("#load-sample").addEventListener("click", async () => {
      try {
        await loadCsvText(DEFAULT_SAMPLE_CSV);
      } catch (error) {
        reportActionError("Sample load", error);
      }
    });

    document.querySelector("#import-csv").addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        return;
      }

      try {
        const csvText = await file.text();
        await loadCsvText(csvText);
      } catch (error) {
        reportActionError("CSV import", error);
      } finally {
        fileInput.value = "";
      }
    });

    document.querySelector("#export-csv").addEventListener("click", async () => {
      try {
        await exportCsv();
      } catch (error) {
        reportActionError("Export", error);
      }
    });

    radioMakeEl.addEventListener("change", () => {
      refreshModelOptions();
      loadSelectedRadioMetadata()
        .then(() => renderTable())
        .catch((error) => reportActionError("Metadata load", error));
    });

    radioModelEl.addEventListener("change", () => {
      const key = radioModelEl.value;
      selectedRadio = radioCatalog.find((r) => r.key === key) || null;
      if (selectedRadio) {
        logDebug(
          `RADIO SELECT ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
        );
      }
      loadSelectedRadioMetadata()
        .then(() => renderTable())
        .catch((error) => reportActionError("Metadata load", error));
    });

    document.querySelector("#serial-connect").addEventListener("click", async () => {
      const baudRate = Number(selectedRadio?.baudRate || 9600);
      try {
        setStatus("Connecting serial...");
        const result = await requireCallWorker()("serialConnect", { baudRate });
        if (result?.deviceName) {
          logDebug(`SERIAL DEVICE ${result.deviceName}`);
        }
        if (result?.usbVendorId) {
          lastUsbVendorId = result.usbVendorId;
        }
        if (result?.usbProductId) {
          lastUsbProductId = result.usbProductId;
        }
        if (lastUsbVendorId || lastUsbProductId) {
          logDebug(`SERIAL USB ID ${lastUsbVendorId || "unknown"}:${lastUsbProductId || "unknown"}`);
        }
        setStatus(result.message || "Serial connected.");
      } catch (error) {
        reportActionError("Serial connect", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#serial-disconnect").addEventListener("click", async () => {
      try {
        const result = await requireCallWorker()("serialDisconnect");
        setStatus(result.message || "Serial disconnected.");
      } catch (error) {
        reportActionError("Serial disconnect", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#serial-transaction").addEventListener("click", async () => {
      const txHex = document.querySelector("#tx-hex").value;
      const rxBytes = Number(document.querySelector("#rx-bytes").value || 32);
      const timeoutMs = Number(document.querySelector("#rx-timeout").value || 1200);

      try {
        setStatus("Running Python serial transaction...");
        const result = await requireCallWorker()("serialTxRx", { txHex, rxBytes, timeoutMs });
        setStatus("Python serial transaction complete.");
        logSerial(`PY TX ${result.tx.hex} | PY RX ${result.rx.hex || "<none>"}`);
      } catch (error) {
        reportActionError("Serial transaction", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#debug-clear").addEventListener("click", () => {
      debugOutputEl.value = "";
      lastErrorSummary = "";
      reportIssueEl?.classList.add("hidden");
    });

    reportIssueEl?.addEventListener("click", () => {
      openPrefilledIssue();
    });

    window.addEventListener("error", (event) => {
      logDebug(`WINDOW ERROR ${event.message}`);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const msg = event.reason?.message || String(event.reason || "Unhandled rejection");
      logDebug(`PROMISE ERROR ${msg}`);
    });

    document.querySelector("#radio-download").addEventListener("click", async () => {
      if (!selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        setStatus(`Downloading from ${makeModelLabel(selectedRadio)}...`);
        const result = await requireCallWorker()("downloadSelectedRadio", {
          module: selectedRadio.module,
          className: selectedRadio.className,
        });
        currentHeaders = radioMetadata.headers?.length
          ? radioMetadata.headers
          : (result.headers || []);
        currentRows = result.rows;
        renderTable();
        setStatus(`${makeModelLabel(selectedRadio)} download complete (${currentRows.length} channels).`);
        if (result.ident) {
          logSerial(`IDENT ${result.ident}`);
        }
      } catch (error) {
        reportActionError("Download", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });

    document.querySelector("#radio-upload").addEventListener("click", async () => {
      if (!selectedRadio) {
        setStatus("Select a radio make/model first.");
        return;
      }
      try {
        setStatus(`Uploading to ${makeModelLabel(selectedRadio)}...`);
        await requireCallWorker()("uploadSelectedRadio", {
          module: selectedRadio.module,
          className: selectedRadio.className,
          rows: currentRows,
        });
        setStatus(`${makeModelLabel(selectedRadio)} upload complete.`);
      } catch (error) {
        reportActionError("Upload", error);
        logSerial(`ERROR ${errorSummary(error)}`);
      }
    });
  }

  // Bootstrap UI: capability checks, catalog load, metadata load, sample data.
  async function init(serialSupported) {
    bindEvents();
    try {
      if (!serialSupported) {
        logSerial("Web Serial unsupported in this browser.");
      } else {
        logSerial("Web Serial available.");
      }
      const catalog = await requireCallWorker()("listRadios");
      radioCatalog = catalog.radios || [];
      runtimeInfo = (await requireCallWorker()("getRuntimeInfo")) || runtimeInfo;
      refreshMakeOptions();
      await loadSelectedRadioMetadata();
      setStatus(`Loaded ${radioCatalog.length} radio definitions from CHIRP sources.`);
      await loadCsvText(DEFAULT_SAMPLE_CSV);
    } catch (error) {
      reportActionError("Initialization", error);
    }
  }

  return {
    setCallWorker,
    setStatus,
    logSerial,
    logDebug,
    init,
    onWorkerCrash(message) {
      logDebug(`WORKER CRASH ${message}`);
    },
  };
}

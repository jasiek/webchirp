const DEFAULT_SAMPLE_CSV = `Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment\n0,Simplex1,146.520000,,0.600000,,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,National Calling\n1,RepeaterA,146.940000,-,0.600000,TSQL,88.5,88.5,23,NN,23,Tone->Tone,FM,5.00,,5.0W,Local repeater\n`;
const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";
const LAST_RADIO_COOKIE = "webchirp_last_radio";
const PMR446_FREQUENCIES_MHZ = Array.from(
  { length: 16 },
  (_, index) => (446.00625 + (index * 0.0125)).toFixed(5),
);
const PRZEMIENNIKI_API_URL = "https://api.codeplug.org/przemienniki";

// Create and manage all DOM/UI state and user interaction behavior.
export function createUiController() {
  const tableHead = document.querySelector("#mem-table thead");
  const tableBody = document.querySelector("#mem-table tbody");
  const fileInput = document.querySelector("#csv-file");
  const imgFileInput = document.querySelector("#img-file");
  const debugOutputEl = document.querySelector("#debug-output");
  const reportIssueEl = document.querySelector("#report-issue");
  const radioMakeEl = document.querySelector("#radio-make");
  const radioModelEl = document.querySelector("#radio-model");
  const channelInsertEl = document.querySelector("#channel-insert");
  const channelRemoveEl = document.querySelector("#channel-remove");
  const channelMenuToggleEl = document.querySelector("#channel-menu-toggle");
  const channelMenuPopupEl = document.querySelector("#channel-menu-popup");
  const channelAddPmr446El = document.querySelector("#channel-add-pmr446");
  const channelImportPrzemiennikiEl = document.querySelector("#channel-import-przemienniki");
  const przemiennikiModalEl = document.querySelector("#przemienniki-modal");
  const przemiennikiFormEl = document.querySelector("#przemienniki-form");
  const przemiennikiCountryEl = document.querySelector("#przemienniki-country");
  const przemiennikiBandEl = document.querySelector("#przemienniki-band");
  const przemiennikiModeEl = document.querySelector("#przemienniki-mode");
  const przemiennikiOnlyWorkingEl = document.querySelector("#przemienniki-onlyworking");
  const przemiennikiLatitudeEl = document.querySelector("#przemienniki-latitude");
  const przemiennikiLongitudeEl = document.querySelector("#przemienniki-longitude");
  const przemiennikiRangeEl = document.querySelector("#przemienniki-range");
  const przemiennikiCancelEl = document.querySelector("#przemienniki-cancel");
  const sidebarControlEls = Array.from(
    document.querySelectorAll(".left-panel select, .left-panel button, .left-panel input"),
  );

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
  let selectedRowIndexes = new Set();
  let selectionAnchorIndex = null;
  let invalidCellKeys = new Set();
  let przemiennikiDictionaryPromise = null;

  if (!Object.getOwnPropertyDescriptor(globalThis, "currentRows")) {
    Object.defineProperty(globalThis, "currentRows", {
      configurable: true,
      get: () => currentRows,
    });
  }

  function setCallWorker(fn) {
    callWorker = fn;
  }

  function setSidebarControlsEnabled(enabled) {
    for (const el of sidebarControlEls) {
      el.disabled = !enabled;
    }
  }

  function setCookie(name, value, maxAgeSeconds = 31536000) {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  function getCookie(name) {
    const prefix = `${name}=`;
    const parts = String(document.cookie || "").split(";").map((v) => v.trim());
    for (const part of parts) {
      if (part.startsWith(prefix)) {
        return decodeURIComponent(part.slice(prefix.length));
      }
    }
    return "";
  }

  function persistSelectedRadioCookie() {
    if (!selectedRadio) {
      return;
    }
    const value = JSON.stringify({
      make: selectedRadio.vendor,
      key: selectedRadio.key,
    });
    setCookie(LAST_RADIO_COOKIE, value);
  }

  function restoreSelectedRadioCookie() {
    const raw = getCookie(LAST_RADIO_COOKIE);
    if (!raw) {
      return false;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    const make = String(parsed?.make || "");
    const key = String(parsed?.key || "");
    if (!make || !key) {
      return false;
    }
    if (!radioCatalog.some((r) => r.vendor === make && r.key === key)) {
      return false;
    }
    radioMakeEl.value = make;
    refreshModelOptions();
    radioModelEl.value = key;
    selectedRadio = radioCatalog.find((r) => r.key === key) || null;
    if (!selectedRadio) {
      return false;
    }
    logDebug(
      `RADIO RESTORE ${makeModelLabel(selectedRadio)} (${selectedRadio.module}.${selectedRadio.className})`,
    );
    return true;
  }

  function sortedSelectedRowIndexes() {
    return Array.from(selectedRowIndexes)
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < currentRows.length)
      .sort((a, b) => a - b);
  }

  function selectedRowsForOperations() {
    const indexes = sortedSelectedRowIndexes();
    if (indexes.length === 0) {
      return currentRows;
    }
    return indexes.map((idx) => currentRows[idx]).filter(Boolean);
  }

  function resetRowSelection() {
    selectedRowIndexes.clear();
    selectionAnchorIndex = null;
  }

  function invalidCellKey(rowIdx, column) {
    return `${Number(rowIdx)}:${String(column || "")}`;
  }

  function clearInvalidHighlights() {
    invalidCellKeys.clear();
  }

  function clearInvalidCell(rowIdx, column) {
    const key = invalidCellKey(rowIdx, column);
    if (!invalidCellKeys.has(key)) {
      return;
    }
    invalidCellKeys.delete(key);
    const td = tableBody.querySelector(
      `td[data-row-idx="${Number(rowIdx)}"][data-column="${CSS.escape(String(column || ""))}"]`,
    );
    td?.classList.remove("is-invalid");
  }

  function applyRowSelectionVisuals() {
    const selected = selectedRowIndexes;
    const rows = tableBody.querySelectorAll("tr");
    rows.forEach((tr, rowIdx) => {
      const isSelected = selected.has(rowIdx);
      tr.classList.toggle("is-selected", isSelected);
      const locationButton = tr.querySelector(".channel-location-button");
      if (locationButton) {
        locationButton.setAttribute("aria-pressed", isSelected ? "true" : "false");
      }
    });
  }

  function selectRowRange(fromIdx, toIdx, addToExisting) {
    const start = Math.max(0, Math.min(fromIdx, toIdx));
    const end = Math.min(currentRows.length - 1, Math.max(fromIdx, toIdx));
    const next = addToExisting ? new Set(selectedRowIndexes) : new Set();
    for (let idx = start; idx <= end; idx += 1) {
      next.add(idx);
    }
    selectedRowIndexes = next;
  }

  function updateRowSelectionFromLocationClick(event, rowIdx) {
    const wantsToggle = event.metaKey || event.ctrlKey;
    const wantsRange = event.shiftKey && Number.isInteger(selectionAnchorIndex);

    if (wantsRange) {
      selectRowRange(selectionAnchorIndex, rowIdx, wantsToggle);
    } else if (wantsToggle) {
      if (selectedRowIndexes.has(rowIdx)) {
        selectedRowIndexes.delete(rowIdx);
      } else {
        selectedRowIndexes.add(rowIdx);
      }
      selectionAnchorIndex = rowIdx;
    } else {
      selectedRowIndexes = new Set([rowIdx]);
      selectionAnchorIndex = rowIdx;
    }

    applyRowSelectionVisuals();
  }

  function requireCallWorker() {
    if (!callWorker) {
      throw new Error("Worker RPC client is not initialized");
    }
    return callWorker;
  }

  // Emit status updates into the debug output stream.
  function setStatus(text) {
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

  function sanitizeFileNamePart(text) {
    return String(text || "")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "radio";
  }

  function nowStampForFileName() {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    const hh = pad2(now.getHours());
    const mm = pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    return `${y}${m}${d}_${hh}${mm}${ss}`;
  }

  function buildBinaryCodeplugFileName(vendor, model) {
    const vendorPart = sanitizeFileNamePart(vendor);
    const modelPart = sanitizeFileNamePart(model);
    return `${vendorPart}_${modelPart}_${nowStampForFileName()}.img`;
  }

  function base64ToBytes(base64) {
    const binary = atob(String(base64 || ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let out = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      out += String.fromCharCode(...chunk);
    }
    return btoa(out);
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

  function selectRadioByDriver(moduleName, className) {
    const target = radioCatalog.find(
      (r) => r.module === moduleName && r.className === className,
    );
    if (!target) {
      return false;
    }
    radioMakeEl.value = target.vendor;
    refreshModelOptions();
    radioModelEl.value = target.key;
    selectedRadio = target;
    persistSelectedRadioCookie();
    return true;
  }

  function selectRadioByDetectedImage(loaded) {
    if (selectRadioByDriver(loaded.module, loaded.className)) {
      return true;
    }
    const vendor = String(loaded.vendor || "");
    const model = String(loaded.model || "");
    const fallback = radioCatalog.find(
      (r) =>
        r.module === loaded.module
        && r.vendor === vendor
        && r.model === model,
    );
    if (!fallback) {
      return false;
    }
    radioMakeEl.value = fallback.vendor;
    refreshModelOptions();
    radioModelEl.value = fallback.key;
    selectedRadio = fallback;
    persistSelectedRadioCookie();
    return true;
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
      const shouldCheckBands = column !== "Offset";
      if (shouldCheckBands && !inAnyBand(hz, meta.bands || [])) {
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

  function defaultValueForColumn(column) {
    if (column === "Location") {
      return "";
    }
    const meta = radioMetadata.columns?.[column] || {};
    if (meta.kind === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
      return String(meta.options[0]);
    }
    if (meta.kind === "int" && Number.isFinite(meta.min)) {
      return String(meta.min);
    }
    return "";
  }

  function reindexLocationColumn() {
    if (!currentHeaders.includes("Location")) {
      return;
    }
    currentRows.forEach((row, idx) => {
      row.Location = String(idx);
    });
  }

  function createBlankChannelRow() {
    const row = {};
    for (const column of currentHeaders) {
      row[column] = defaultValueForColumn(column);
    }
    return row;
  }

  function insertNewChannelRow() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }

    const selectedIndexes = sortedSelectedRowIndexes();
    const insertAt = selectedIndexes.length > 0 ? selectedIndexes[0] : currentRows.length;
    currentRows.splice(insertAt, 0, createBlankChannelRow());
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set([insertAt]);
    selectionAnchorIndex = insertAt;
    renderTable();
    setStatus(`Inserted new channel at channel ${insertAt}.`);
  }

  function setChannelMenuOpen(open) {
    if (!channelMenuToggleEl || !channelMenuPopupEl) {
      return;
    }
    channelMenuPopupEl.classList.toggle("hidden", !open);
    channelMenuToggleEl.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function toggleChannelMenu() {
    if (!channelMenuPopupEl) {
      return;
    }
    const shouldOpen = channelMenuPopupEl.classList.contains("hidden");
    setChannelMenuOpen(shouldOpen);
  }

  function flagEmojiFromCountryCode(countryCode) {
    const code = String(countryCode || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      return code;
    }
    return Array.from(code)
      .map((char) => String.fromCodePoint(char.charCodeAt(0) + 127397))
      .join("");
  }

  function optionEntriesFromDictionary(raw) {
    const entries = [];
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (typeof value === "string") {
          entries.push({ value, label: value, title: value });
          continue;
        }
        if (!value || typeof value !== "object") {
          continue;
        }
        const entryValue = String(
          value.value ?? value.code ?? value.id ?? value.key ?? value.band ?? value.name ?? "",
        ).trim();
        if (!entryValue) {
          continue;
        }
        const entryLabel = String(value.label ?? value.name ?? value.title ?? entryValue).trim();
        entries.push({ value: entryValue, label: entryLabel || entryValue, title: entryLabel || entryValue });
      }
      return entries;
    }
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") {
          entries.push({ value: key, label: value, title: value });
          continue;
        }
        if (!value || typeof value !== "object") {
          entries.push({ value: key, label: key, title: key });
          continue;
        }
        const entryLabel = String(value.label ?? value.name ?? value.title ?? key).trim();
        const entryValue = String(value.value ?? value.code ?? value.id ?? key).trim();
        if (!entryValue) {
          continue;
        }
        entries.push({ value: entryValue, label: entryLabel || entryValue, title: entryLabel || entryValue });
      }
      return entries;
    }
    return entries;
  }

  function replaceOptions(selectEl, options, placeholderLabel) {
    if (!selectEl) {
      return;
    }
    selectEl.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = placeholderLabel;
    selectEl.appendChild(placeholder);
    for (const option of options) {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.title) {
        opt.title = option.title;
      }
      selectEl.appendChild(opt);
    }
  }

  function populatePrzemiennikiCountryOptions(rawCountries) {
    const countries = optionEntriesFromDictionary(rawCountries)
      .map((entry) => {
        const code = String(entry.value || "").toUpperCase();
        const name = String(entry.label || code);
        return {
          value: code,
          label: `${flagEmojiFromCountryCode(code)} ${code}`.trim(),
          title: name,
        };
      })
      .filter((entry) => /^[A-Z]{2}$/.test(entry.value))
      .sort((a, b) => a.title.localeCompare(b.title));
    replaceOptions(przemiennikiCountryEl, countries, "Any country");
  }

  function populatePrzemiennikiBandOptions(rawBands) {
    const bands = optionEntriesFromDictionary(rawBands)
      .map((entry) => {
        const value = String(entry.value || "").trim();
        return {
          value,
          label: value,
          title: String(entry.title || value),
        };
      })
      .filter((entry) => entry.value.length > 0)
      .sort((a, b) => a.value.localeCompare(b.value));
    replaceOptions(przemiennikiBandEl, bands, "Any band");
  }

  async function ensurePrzemiennikiDictionaryLoaded() {
    if (przemiennikiDictionaryPromise) {
      return przemiennikiDictionaryPromise;
    }
    przemiennikiDictionaryPromise = (async () => {
      const response = await fetch(PRZEMIENNIKI_API_URL);
      if (!response.ok) {
        throw new Error(`Dictionary request failed: HTTP ${response.status}`);
      }
      const payload = await response.json();
      const dictionary = payload?.dictionary && typeof payload.dictionary === "object"
        ? payload.dictionary
        : {};
      populatePrzemiennikiCountryOptions(dictionary.country || dictionary.countries || {});
      populatePrzemiennikiBandOptions(dictionary.band || dictionary.bands || {});
      logDebug("Loaded przemienniki.net dictionary options.");
      return dictionary;
    })();
    try {
      return await przemiennikiDictionaryPromise;
    } catch (error) {
      przemiennikiDictionaryPromise = null;
      throw error;
    }
  }

  function setPrzemiennikiModalOpen(open) {
    if (!przemiennikiModalEl) {
      return;
    }
    przemiennikiModalEl.classList.toggle("hidden", !open);
    if (open) {
      przemiennikiCountryEl?.focus();
    }
  }

  function isPrzemiennikiModalOpen() {
    return Boolean(przemiennikiModalEl && !przemiennikiModalEl.classList.contains("hidden"));
  }

  async function openPrzemiennikiModal() {
    setChannelMenuOpen(false);
    setStatus("Loading przemienniki.net query options...");
    await ensurePrzemiennikiDictionaryLoaded();
    setPrzemiennikiModalOpen(true);
    setStatus("Configure przemienniki.net query.");
  }

  function appendQueryParam(url, key, value) {
    const text = String(value ?? "").trim();
    if (!text) {
      return;
    }
    url.searchParams.set(key, text);
  }

  async function runPrzemiennikiQuery() {
    const url = new URL(PRZEMIENNIKI_API_URL);
    appendQueryParam(url, "country", przemiennikiCountryEl?.value || "");
    appendQueryParam(url, "band", przemiennikiBandEl?.value || "");
    appendQueryParam(url, "mode", przemiennikiModeEl?.value || "");
    if (przemiennikiOnlyWorkingEl?.checked) {
      url.searchParams.set("onlyworking", "true");
    }
    appendQueryParam(url, "latitude", przemiennikiLatitudeEl?.value || "");
    appendQueryParam(url, "longitude", przemiennikiLongitudeEl?.value || "");
    appendQueryParam(url, "range", przemiennikiRangeEl?.value || "");
    setStatus("Querying przemienniki.net...");
    const response = await fetch(url.toString());
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Przemienniki query failed: HTTP ${response.status}\n${body.slice(0, 800)}`);
    }
    const payload = await response.json();
    const resultList = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload)
          ? payload
          : [];
    logDebug(`PRZEMIENNIKI QUERY ${url.toString()}`);
    logDebug(`PRZEMIENNIKI RESULTS ${resultList.length}`);
    setStatus(`przemienniki.net query returned ${resultList.length} record(s).`);
  }

  function setRowValueIfPresent(row, column, value) {
    if (!currentHeaders.includes(column)) {
      return;
    }
    const meta = radioMetadata.columns?.[column] || {};
    row[column] = normalizeValue(column, value, meta, row[column]);
  }

  function preferredEnumOption(column, choices) {
    if (!currentHeaders.includes(column)) {
      return "";
    }
    const meta = radioMetadata.columns?.[column] || {};
    const options = Array.isArray(meta.options) ? meta.options.map(String) : [];
    for (const choice of choices) {
      if (options.includes(choice)) {
        return choice;
      }
    }
    return "";
  }

  function createPmr446ChannelRow(channelNumber, frequencyMhz) {
    const row = createBlankChannelRow();
    setRowValueIfPresent(row, "Name", `PMR ${channelNumber}`);
    setRowValueIfPresent(row, "Frequency", frequencyMhz);
    setRowValueIfPresent(row, "Duplex", "");
    setRowValueIfPresent(row, "Offset", "0.000000");
    setRowValueIfPresent(row, "Tone", "");
    setRowValueIfPresent(row, "CrossMode", "Tone->Tone");
    const modeValue = preferredEnumOption("Mode", ["NFM", "FMN", "FM"]);
    if (modeValue) {
      setRowValueIfPresent(row, "Mode", modeValue);
    }
    const powerValue = preferredEnumOption("Power", ["0.5W", "500mW", "Low"]);
    if (powerValue) {
      setRowValueIfPresent(row, "Power", powerValue);
    }
    return row;
  }

  function addPmr446Channels() {
    if (!currentHeaders.length) {
      setStatus("No channel schema loaded yet.");
      return;
    }
    const selectedIndexes = sortedSelectedRowIndexes();
    const insertAt = selectedIndexes.length > 0 ? selectedIndexes[0] : currentRows.length;
    const rowsToInsert = PMR446_FREQUENCIES_MHZ.map((frequency, idx) =>
      createPmr446ChannelRow(idx + 1, frequency),
    );
    currentRows.splice(insertAt, 0, ...rowsToInsert);
    reindexLocationColumn();
    clearInvalidHighlights();

    selectedRowIndexes = new Set(
      rowsToInsert.map((_, offset) => insertAt + offset),
    );
    selectionAnchorIndex = insertAt;
    renderTable();
    setStatus(`Inserted ${rowsToInsert.length} PMR446 channels at channel ${insertAt}.`);
  }

  function removeSelectedChannelRows() {
    const selectedIndexes = sortedSelectedRowIndexes();
    if (selectedIndexes.length === 0) {
      setStatus("Select one or more channels to remove.");
      return;
    }

    for (let i = selectedIndexes.length - 1; i >= 0; i -= 1) {
      currentRows.splice(selectedIndexes[i], 1);
    }
    reindexLocationColumn();
    clearInvalidHighlights();

    resetRowSelection();
    if (currentRows.length > 0) {
      const nextIndex = Math.min(selectedIndexes[0], currentRows.length - 1);
      selectedRowIndexes = new Set([nextIndex]);
      selectionAnchorIndex = nextIndex;
    }
    renderTable();
    setStatus(`Removed ${selectedIndexes.length} selected channel(s).`);
  }

  // Create a table cell editor (input/select) based on CHIRP column metadata.
  function createCellEditor(row, rowIdx, column) {
    const meta = radioMetadata.columns?.[column] || {};
    const current = String(row[column] ?? "");
    const readOnly = column === "Location" || meta.editable === false;
    if (column === "Location") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "channel-location-button";
      button.textContent = current;
      button.addEventListener("click", (event) => {
        updateRowSelectionFromLocationClick(event, rowIdx);
      });
      return button;
    }
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
        clearInvalidCell(rowIdx, column);
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
    input.addEventListener("input", () => {
      clearInvalidCell(rowIdx, column);
    });
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
      if (selectedRowIndexes.has(rowIdx)) {
        tr.classList.add("is-selected");
      }

      columns.forEach((column) => {
        const td = document.createElement("td");
        td.dataset.rowIdx = String(rowIdx);
        td.dataset.column = String(column);
        td.classList.toggle("is-invalid", invalidCellKeys.has(invalidCellKey(rowIdx, column)));
        const editor = createCellEditor(row, rowIdx, column);
        td.appendChild(editor);
        tr.appendChild(td);
      });

      tableBody.appendChild(tr);
    });

    applyRowSelectionVisuals();
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
    clearInvalidHighlights();
    resetRowSelection();
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
    setStatus("Normalizing rows with CHIRP Python...");
    const csvText = await requireCallWorker()("normalizeRows", {
      rows: currentRows,
      module: selectedRadio?.module || "",
      className: selectedRadio?.className || "",
    });
    downloadText("webchirp-export.csv", csvText);
    setStatus("Exported webchirp-export.csv");
  }

  async function exportBinaryCodeplug() {
    if (!selectedRadio) {
      setStatus("Select a radio make/model first.");
      return;
    }
    setStatus("Preparing CHIRP binary codeplug...");
    const result = await requireCallWorker()("exportImage", {
      module: selectedRadio.module,
      className: selectedRadio.className,
      rows: currentRows,
    });
    const bytes = base64ToBytes(result.imageBase64 || "");
    const fileName = buildBinaryCodeplugFileName(
      result.vendor || selectedRadio.vendor,
      result.model || selectedRadio.model,
    );
    downloadBytes(fileName, bytes);
    setStatus(`Exported ${fileName}`);
  }

  async function importBinaryCodeplug(file) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const imageBase64 = bytesToBase64(raw);
    setStatus("Loading CHIRP binary codeplug...");
    const loaded = await requireCallWorker()("loadImage", { imageBase64 });
    const selected = selectRadioByDetectedImage(loaded);
    if (!selected) {
      throw new Error(
        `Loaded image radio ${loaded.module}.${loaded.className} is not available in current radio catalog`,
      );
    }
    await loadSelectedRadioMetadata();
    currentHeaders = radioMetadata.headers?.length
      ? radioMetadata.headers
      : (loaded.headers || currentHeaders);
    currentRows = Array.isArray(loaded.rows) ? loaded.rows : [];
    clearInvalidHighlights();
    resetRowSelection();
    renderTable();
    setStatus(
      `Loaded binary codeplug for ${loaded.vendor || selectedRadio.vendor} ${loaded.model || selectedRadio.model}.`,
    );
  }

  async function runUploadPreflight() {
    if (!selectedRadio) {
      return { valid: false, issues: [{ rowIndex: -1, column: "", message: "No radio selected." }] };
    }
    const result = await requireCallWorker()("validateRowsForUpload", {
      rows: currentRows,
      module: selectedRadio.module,
      className: selectedRadio.className,
    });
    clearInvalidHighlights();
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    for (const issue of issues) {
      const rowIdx = Number(issue?.rowIndex);
      const column = String(issue?.column || "");
      if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= currentRows.length || !column) {
        continue;
      }
      invalidCellKeys.add(invalidCellKey(rowIdx, column));
      const channel = currentRows[rowIdx]?.Location ?? rowIdx;
      logDebug(`PREFLIGHT INVALID channel=${channel} column=${column}: ${issue?.message || "Invalid value"}`);
    }
    if (issues.length > 0) {
      renderTable();
    }
    return {
      valid: Boolean(result?.valid),
      issues,
    };
  }

  // Register all UI event handlers and action bindings.
  function bindEvents() {
    channelInsertEl?.addEventListener("click", () => {
      insertNewChannelRow();
    });
    channelRemoveEl?.addEventListener("click", () => {
      removeSelectedChannelRows();
    });
    channelMenuToggleEl?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleChannelMenu();
    });
    channelAddPmr446El?.addEventListener("click", () => {
      setChannelMenuOpen(false);
      addPmr446Channels();
    });
    channelImportPrzemiennikiEl?.addEventListener("click", async () => {
      try {
        await openPrzemiennikiModal();
      } catch (error) {
        reportActionError("Przemienniki modal", error);
      }
    });
    przemiennikiCancelEl?.addEventListener("click", () => {
      setPrzemiennikiModalOpen(false);
      setStatus("Cancelled przemienniki.net query.");
    });
    przemiennikiModalEl?.addEventListener("click", (event) => {
      if (event.target === przemiennikiModalEl) {
        setPrzemiennikiModalOpen(false);
      }
    });
    przemiennikiFormEl?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await runPrzemiennikiQuery();
        setPrzemiennikiModalOpen(false);
      } catch (error) {
        reportActionError("Przemienniki query", error);
      }
    });

    document.addEventListener("click", (event) => {
      if (!channelMenuPopupEl || channelMenuPopupEl.classList.contains("hidden")) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (channelMenuPopupEl.contains(target) || channelMenuToggleEl?.contains(target)) {
        return;
      }
      setChannelMenuOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (isPrzemiennikiModalOpen()) {
          setPrzemiennikiModalOpen(false);
          return;
        }
        setChannelMenuOpen(false);
      }
    });

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

    document.querySelector("#export-binary").addEventListener("click", async () => {
      try {
        await exportBinaryCodeplug();
      } catch (error) {
        reportActionError("Binary export", error);
      }
    });

    document.querySelector("#import-binary").addEventListener("click", () => {
      imgFileInput.click();
    });

    imgFileInput.addEventListener("change", async () => {
      const file = imgFileInput.files?.[0];
      if (!file) {
        return;
      }
      try {
        await importBinaryCodeplug(file);
      } catch (error) {
        reportActionError("Binary import", error);
      } finally {
        imgFileInput.value = "";
      }
    });

    radioMakeEl.addEventListener("change", () => {
      refreshModelOptions();
      persistSelectedRadioCookie();
      clearInvalidHighlights();
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
      persistSelectedRadioCookie();
      clearInvalidHighlights();
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
        clearInvalidHighlights();
        resetRowSelection();
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
        setStatus("Running upload preflight validation...");
        const preflight = await runUploadPreflight();
        if (!preflight.valid) {
          const count = Array.isArray(preflight.issues) ? preflight.issues.length : 0;
          setStatus(
            count > 0
              ? `Upload blocked: ${count} invalid value(s) highlighted in red.`
              : "Upload blocked: preflight validation failed.",
          );
          return;
        }
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
    setSidebarControlsEnabled(false);
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
      restoreSelectedRadioCookie();
      await loadSelectedRadioMetadata();
      setStatus(`Loaded ${radioCatalog.length} radio definitions from CHIRP sources.`);
      await loadCsvText(DEFAULT_SAMPLE_CSV);
      setSidebarControlsEnabled(true);
    } catch (error) {
      reportActionError("Initialization", error);
      setStatus("Initialization failed; sidebar controls remain disabled.");
    }
  }

  return {
    setCallWorker,
    setStatus,
    logSerial,
    logDebug,
    init,
    selectedRowsForOperations,
    onWorkerCrash(message) {
      logDebug(`WORKER CRASH ${message}`);
    },
  };
}

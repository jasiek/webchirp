import {
  RSGB_BANDS,
  RSGB_DEFAULT_BANDS,
  RSGB_DEFAULT_MODES,
  RSGB_MODES,
  buildRsgbRows,
  dedupeRsgbRecords,
  encodeMaidenhead,
  fetchRsgbRecords,
  filterRsgbRecords,
  squaresForRadius,
} from "../rsgb.js";

// RSGB/ETCC repeater import: the filter modal, the locator-square fan-out and
// inserting the results as channels.
//
// This is a separate module from repeater-query.js rather than a third source
// inside it because the flows differ at the root: przemienniki and RepeaterBook
// take the filter as query parameters and hand back a filtered set, while the
// RSGB API only knows how to return a locator square — distance, band and mode
// are all applied here. It also needs no CORS proxy, so it stays available on
// deployments where the other two are disabled.
export function createRsgbQuery(ctx) {
  const { dom, state, log } = ctx;

  function replaceCheckboxOptions(containerEl, options, name, defaults = []) {
    const preselected = new Set(defaults);
    containerEl.innerHTML = "";
    options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "modal-mode-option";
      label.title = option.title || option.label || option.value;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option.value;
      checkbox.name = name;
      checkbox.checked = preselected.has(option.value);
      const text = document.createElement("span");
      text.textContent = option.label || option.value;
      label.appendChild(checkbox);
      label.appendChild(text);
      containerEl.appendChild(label);
    });
  }

  // Both option lists are static: they come from the API's documented flag
  // table and its observed band values, not from a dictionary endpoint (the
  // API has none), so the modal opens without a network round trip.
  //
  // Rebuilt on every open, so the defaults are restored each time rather than
  // carried over from the last query — the modal always opens in the state it
  // documents.
  function populateOptions() {
    replaceCheckboxOptions(
      dom.rsgbBandListEl,
      RSGB_BANDS.map((band) => ({ value: band, label: band })),
      "rsgb-band",
      RSGB_DEFAULT_BANDS,
    );
    replaceCheckboxOptions(
      dom.rsgbModeListEl,
      RSGB_MODES.map((mode) => ({ ...mode, title: `${mode.label} (${mode.value})` })),
      "rsgb-mode",
      RSGB_DEFAULT_MODES,
    );
  }

  function checkedValues(containerEl, name) {
    return Array.from(containerEl.querySelectorAll(`input[name="${name}"]:checked`))
      .map((el) => String(el.value || "").trim())
      .filter((value) => value.length > 0);
  }

  // Number("") is 0, not NaN, so a blank field would otherwise read as a
  // position on the equator — and an empty modal would claim to be in JJ00AA.
  function numericFieldValue(el) {
    const text = String(el.value ?? "").trim();
    if (text === "") {
      return Number.NaN;
    }
    return Number(text);
  }

  function currentPosition() {
    const latitude = numericFieldValue(dom.rsgbLatitudeEl);
    const longitude = numericFieldValue(dom.rsgbLongitudeEl);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return null;
    }
    return { latitude, longitude };
  }

  // The locator readout is display only — the query fans out over 4-character
  // squares, because /locator only prefix-matches at that length.
  function refreshLocator() {
    const position = currentPosition();
    dom.rsgbLocatorEl.textContent = position
      ? encodeMaidenhead(position.latitude, position.longitude, 6)
      : "--";
  }

  function setModalOpen(open) {
    dom.rsgbModalEl.classList.toggle("hidden", !open);
    if (open) {
      dom.rsgbRadiusEl.focus();
    }
  }

  function isModalOpen() {
    return !dom.rsgbModalEl.classList.contains("hidden");
  }

  function openModal() {
    populateOptions();
    refreshLocator();
    ctx.table.setMenuOpen(false);
    setModalOpen(true);
    log.setStatus("Configure RSGB ETCC query.");
  }

  async function geolocate() {
    if (!navigator.geolocation) {
      throw new Error("Geolocation API is not available in this browser.");
    }
    log.setStatus("Requesting browser geolocation...");
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Geolocation did not return valid coordinates.");
    }
    dom.rsgbLatitudeEl.value = latitude.toFixed(6);
    dom.rsgbLongitudeEl.value = longitude.toFixed(6);
    refreshLocator();
    const locator = encodeMaidenhead(latitude, longitude, 6);
    log.setStatus(`Location set to ${locator}.`);
    log.logDebug(`RSGB GEO ${latitude.toFixed(6)},${longitude.toFixed(6)} ${locator}`);
  }

  async function runQuery() {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    const position = currentPosition();
    if (!position) {
      throw new Error("Set a location first: use the 🛰️ button or type a latitude and longitude.");
    }
    const radiusKm = numericFieldValue(dom.rsgbRadiusEl);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
      throw new Error("Distance must be a positive number of kilometres.");
    }

    const plan = squaresForRadius(position.latitude, position.longitude, radiusKm);
    if (plan.squares.length === 0) {
      log.setStatus("No locator squares fall within that distance.");
      return;
    }
    if (plan.truncated) {
      // A clipped plan queries a subset of the area, so say so rather than
      // letting a short result read as "that is everything nearby".
      log.logDebug(`RSGB PLAN truncated to ${plan.squares.length} of ${plan.considered} squares`);
      log.setStatus(`Distance spans ${plan.considered} squares; querying the ${plan.squares.length} nearest.`);
    }

    log.setStatus(`Querying RSGB ETCC for ${plan.squares.length} locator square(s)...`);
    log.logDebug(`RSGB QUERY ${plan.squares.join(", ")} r=${radiusKm}km`);

    const records = await fetchRsgbRecords({
      squares: plan.squares,
      onRequest: ({ locator, count }) => log.logDebug(`RSGB SQUARE ${locator} -> ${count}`),
    });
    const deduped = dedupeRsgbRecords(records);
    const entries = filterRsgbRecords(deduped, {
      latitude: position.latitude,
      longitude: position.longitude,
      radiusKm,
      bands: checkedValues(dom.rsgbBandListEl, "rsgb-band"),
      modes: checkedValues(dom.rsgbModeListEl, "rsgb-mode"),
      onlyOperational: dom.rsgbOnlyOperationalEl.checked,
    });

    log.logDebug(`RSGB RESULTS ${records.length} fetched, ${deduped.length} unique, ${entries.length} matched`);

    const rows = buildRsgbRows(entries, ctx.table.rowBuilderHooks());
    // Repeaters the selected radio cannot tune (23 cm and up on a 2m/70cm set)
    // are dropped by the builder; a shorter list than the match count needs
    // saying out loud, or it reads as results going missing.
    const dropped = entries.length - rows.length;
    if (dropped > 0) {
      log.logDebug(`RSGB SKIPPED ${dropped} repeater(s) outside the selected radio's frequency range`);
    }
    ctx.table.insertRowsAtSelectionOrEnd(rows, "RSGB ETCC");
    if (dropped > 0) {
      log.setStatus(`Inserted ${rows.length} channel(s); skipped ${dropped} outside the radio's range.`);
    }
  }

  function bindEvents() {
    dom.channelImportRsgbEl.addEventListener("click", () => {
      try {
        openModal();
      } catch (error) {
        log.reportActionError("RSGB ETCC modal", error);
      }
    });
    dom.rsgbGeolocateEl.addEventListener("click", async () => {
      try {
        await geolocate();
      } catch (error) {
        log.reportActionError("RSGB ETCC geolocation", error);
      }
    });
    dom.rsgbLatitudeEl.addEventListener("input", refreshLocator);
    dom.rsgbLongitudeEl.addEventListener("input", refreshLocator);
    dom.rsgbCancelEl.addEventListener("click", () => {
      setModalOpen(false);
      log.setStatus("Cancelled RSGB ETCC query.");
    });
    dom.rsgbModalEl.addEventListener("click", (event) => {
      if (event.target === dom.rsgbModalEl) {
        setModalOpen(false);
      }
    });
    dom.rsgbFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await runQuery();
        setModalOpen(false);
      } catch (error) {
        log.reportActionError("RSGB ETCC query", error);
      }
    });
  }

  return { bindEvents, isModalOpen, setModalOpen };
}

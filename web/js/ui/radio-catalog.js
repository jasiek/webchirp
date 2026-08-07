import {
  isStaleRadioLoad,
  nextRadioLoadToken,
  requireRuntimeApi,
} from "./state.js";
import { makeModelLabel } from "./format.js";
import { radioEventParams, trackEvent } from "./analytics.js";

const LAST_RADIO_COOKIE = "webchirp_last_radio";
const RADIO_SEARCH_MAX_RESULTS = 50;

// Radio selection: the make/model dropdowns, the free-text search box with its
// autocomplete list, the "last radio" cookie, and the metadata load that
// follows a selection. Owns the search-result state; the catalog and the
// selected entry live in the shared state because export/upload read them.
export function createRadioCatalog(ctx) {
  const { dom, state, log, actions } = ctx;
  let searchMatches = [];
  let searchActiveIndex = -1;

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
    if (!state.selectedRadio) {
      return;
    }
    const value = JSON.stringify({
      make: state.selectedRadio.vendor,
      key: state.selectedRadio.key,
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
    if (!state.radioCatalog.some((r) => r.vendor === make && r.key === key)) {
      return false;
    }
    clearRadioFilter();
    dom.radioMakeEl.value = make;
    refreshModelOptions();
    dom.radioModelEl.value = key;
    state.selectedRadio = state.radioCatalog.find((r) => r.key === key) || null;
    if (!state.selectedRadio) {
      return false;
    }
    actions.updateSerialActionState();
    trackRadioSelected(state.selectedRadio, "restored");
    log.logDebug(
      `RADIO RESTORE ${makeModelLabel(state.selectedRadio)} (${state.selectedRadio.module}.${state.selectedRadio.className})`,
    );
    return true;
  }

  // Report which radio a user landed on and how they got there. Deliberately
  // not fired from refreshModelOptions(), which also runs at boot and when a
  // vendor change defaults the model: only the paths below are a user choosing
  // a radio. The live-mode flag rides along because picking one of those is a
  // dead end in this UI, and the size of that group is worth knowing.
  function trackRadioSelected(radio, method) {
    if (!radio) {
      return;
    }
    trackEvent("radio_selected", {
      ...radioEventParams(radio),
      method,
      radio_support: radio.isLiveRadio ? "live_unsupported" : "clone",
    });
  }

  // Produce a sorted unique list of vendor names from the radio catalog.
  function uniqueVendors(radios) {
    return Array.from(new Set(radios.map((r) => r.vendor))).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  // Match a radio against a search query; every whitespace-separated token must
  // appear somewhere in the "vendor model class" text (case-insensitive).
  function radioMatchesFilter(radio, tokens) {
    if (tokens.length === 0) {
      return true;
    }
    const haystack = `${radio.vendor} ${radio.model} ${radio.className}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  // Catalog entries matching a free-text search query.
  function matchingRadios(query) {
    const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return [];
    }
    return state.radioCatalog.filter((radio) => radioMatchesFilter(radio, tokens));
  }

  // "<Make> <Model>" label for a search suggestion; the driver class is added
  // when several catalog entries share the same vendor+model text.
  function radioSearchLabel(radio, hasDuplicateLabel) {
    const base = makeModelLabel(radio);
    const label = radio.isLiveRadio ? `⚡ ${base}` : base;
    return hasDuplicateLabel ? `${label} (${radio.className})` : label;
  }

  function hideRadioSearchResults() {
    searchMatches = [];
    searchActiveIndex = -1;
    dom.radioSearchResultsEl.hidden = true;
    dom.radioSearchResultsEl.innerHTML = "";
    dom.radioSearchEl.setAttribute("aria-expanded", "false");
  }

  // Clear the search box and close its suggestion list (programmatic selections).
  function clearRadioFilter() {
    dom.radioSearchEl.value = "";
    hideRadioSearchResults();
  }

  // Render the autocomplete dropdown for the current search box contents.
  function renderRadioSearchResults() {
    const query = String(dom.radioSearchEl.value || "").trim();
    if (!query) {
      hideRadioSearchResults();
      return;
    }
    const matches = matchingRadios(query);
    searchMatches = matches.slice(0, RADIO_SEARCH_MAX_RESULTS);
    searchActiveIndex = searchMatches.length > 0 ? 0 : -1;
    dom.radioSearchResultsEl.innerHTML = "";

    if (matches.length === 0) {
      const li = document.createElement("li");
      li.classList.add("radio-search-empty");
      li.textContent = "No matching radios";
      dom.radioSearchResultsEl.appendChild(li);
    } else {
      const labelCounts = new Map();
      for (const radio of searchMatches) {
        const label = makeModelLabel(radio);
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }
      searchMatches.forEach((radio, index) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.dataset.index = String(index);
        const hasDuplicateLabel = (labelCounts.get(makeModelLabel(radio)) || 0) > 1;
        li.textContent = radioSearchLabel(radio, hasDuplicateLabel);
        if (index === searchActiveIndex) {
          li.classList.add("is-active");
        }
        dom.radioSearchResultsEl.appendChild(li);
      });
      if (matches.length > searchMatches.length) {
        const li = document.createElement("li");
        li.classList.add("radio-search-more");
        li.textContent = `${matches.length - searchMatches.length} more — keep typing to narrow down`;
        dom.radioSearchResultsEl.appendChild(li);
      }
    }

    dom.radioSearchResultsEl.hidden = false;
    dom.radioSearchEl.setAttribute("aria-expanded", "true");
  }

  // Move the keyboard highlight in the suggestion list by delta and keep it in view.
  function moveRadioSearchActive(delta) {
    if (searchMatches.length === 0) {
      return;
    }
    const count = searchMatches.length;
    searchActiveIndex = (searchActiveIndex + delta + count) % count;
    const items = dom.radioSearchResultsEl.querySelectorAll("li[role='option']");
    items.forEach((li, index) => {
      li.classList.toggle("is-active", index === searchActiveIndex);
    });
    items[searchActiveIndex]?.scrollIntoView({ block: "nearest" });
  }

  // Apply a suggestion: sync the make/model dropdowns and load the radio.
  function applyRadioSearchSelection(radio) {
    if (!radio) {
      return;
    }
    dom.radioSearchEl.value = makeModelLabel(radio);
    hideRadioSearchResults();
    dom.radioMakeEl.value = radio.vendor;
    refreshModelOptions();
    dom.radioModelEl.value = radio.key;
    state.selectedRadio = radio;
    trackRadioSelected(radio, "search");
    log.logDebug(
      `RADIO SELECT ${makeModelLabel(radio)} (${radio.module}.${radio.className})`,
    );
    reloadForSelectedRadio();
  }

  // Shared side effects after the selected radio changes via make/model/search.
  function reloadForSelectedRadio() {
    actions.updateSerialActionState();
    persistSelectedRadioCookie();
    ctx.table.clearInvalidHighlights();
    ctx.settings.clearInvalid();
    if (state.selectedRadio && state.selectedRadio.key === state.lastLoadedRadioKey) {
      ctx.table.render();
      return;
    }
    const loadToken = nextRadioLoadToken(state);
    Promise.all([
      loadSelectedRadioMetadata(loadToken),
      ctx.settings.load({ loadToken }),
    ])
      .then(() => {
        if (isStaleRadioLoad(state, loadToken)) {
          return;
        }
        state.lastLoadedRadioKey = state.selectedRadio?.key || "";
        ctx.table.render();
      })
      .catch((error) => {
        if (!isStaleRadioLoad(state, loadToken)) {
          log.reportActionError("Metadata load", error);
        }
      });
  }

  function formatRadioModelOption(radio, hasDuplicateModel) {
    const modelLabel = radio.isLiveRadio ? `⚡ ${radio.model}` : radio.model;
    return hasDuplicateModel ? `${modelLabel} (${radio.className})` : modelLabel;
  }

  function setRadioSelectPlaceholder(label) {
    const text = String(label || "");
    for (const selectEl of [dom.radioMakeEl, dom.radioModelEl]) {
      if (!selectEl) {
        continue;
      }
      selectEl.innerHTML = "";
      const option = document.createElement("option");
      option.value = "";
      option.textContent = text;
      selectEl.appendChild(option);
      selectEl.value = "";
    }
  }

  // Populate model dropdown for selected vendor and refresh selection state.
  function refreshModelOptions() {
    const vendor = dom.radioMakeEl.value;
    const models = state.radioCatalog.filter((r) => r.vendor === vendor);
    const modelCounts = new Map();
    for (const radio of models) {
      modelCounts.set(radio.model, (modelCounts.get(radio.model) || 0) + 1);
    }
    dom.radioModelEl.innerHTML = "";

    for (const radio of models) {
      const option = document.createElement("option");
      option.value = radio.key;
      const hasDuplicateModel = (modelCounts.get(radio.model) || 0) > 1;
      option.textContent = formatRadioModelOption(radio, hasDuplicateModel);
      dom.radioModelEl.appendChild(option);
    }

    const selectedKey = dom.radioModelEl.value || models[0]?.key;
    state.selectedRadio = models.find((r) => r.key === selectedKey) || null;
    actions.updateSerialActionState();
    if (state.selectedRadio) {
      dom.radioModelEl.value = state.selectedRadio.key;
      log.logDebug(
        `RADIO SELECT ${makeModelLabel(state.selectedRadio)} (${state.selectedRadio.module}.${state.selectedRadio.className})`,
      );
    }
  }

  function selectRadioByDriver(moduleName, className) {
    const target = state.radioCatalog.find(
      (r) => r.module === moduleName && r.className === className,
    );
    if (!target) {
      return false;
    }
    clearRadioFilter();
    dom.radioMakeEl.value = target.vendor;
    refreshModelOptions();
    dom.radioModelEl.value = target.key;
    state.selectedRadio = target;
    persistSelectedRadioCookie();
    return true;
  }

  function selectRadioByDetectedImage(loaded) {
    if (selectRadioByDriver(loaded.module, loaded.className)) {
      trackRadioSelected(state.selectedRadio, "image");
      return true;
    }
    const vendor = String(loaded.vendor || "");
    const model = String(loaded.model || "");
    const fallback = state.radioCatalog.find(
      (r) =>
        r.module === loaded.module
        && r.vendor === vendor
        && r.model === model,
    );
    if (!fallback) {
      return false;
    }
    clearRadioFilter();
    dom.radioMakeEl.value = fallback.vendor;
    refreshModelOptions();
    dom.radioModelEl.value = fallback.key;
    state.selectedRadio = fallback;
    trackRadioSelected(fallback, "image");
    persistSelectedRadioCookie();
    return true;
  }

  // Populate make dropdown from the catalog and initialize model options,
  // preserving the current vendor when it is still present.
  function refreshMakeOptions() {
    const previousVendor = dom.radioMakeEl.value;
    const vendors = uniqueVendors(state.radioCatalog);
    dom.radioMakeEl.innerHTML = "";

    if (vendors.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No matching radios";
      dom.radioMakeEl.appendChild(option);
      dom.radioModelEl.innerHTML = "";
      state.selectedRadio = null;
      actions.updateSerialActionState();
      return;
    }

    for (const vendor of vendors) {
      const option = document.createElement("option");
      option.value = vendor;
      option.textContent = vendor;
      dom.radioMakeEl.appendChild(option);
    }
    dom.radioMakeEl.value = vendors.includes(previousVendor) ? previousVendor : vendors[0];
    refreshModelOptions();
  }

  // Load selected radio's CHIRP-derived column metadata from Python runtime.
  async function loadSelectedRadioMetadata(loadToken = nextRadioLoadToken(state)) {
    if (!state.selectedRadio) {
      return;
    }
    const meta = await requireRuntimeApi(state).getRadioMetadata({
      module: state.selectedRadio.module,
      className: state.selectedRadio.className,
    });
    if (isStaleRadioLoad(state, loadToken)) {
      return;
    }
    state.radioMetadata = meta || { headers: [], columns: {} };
    state.currentHeaders = state.radioMetadata.headers?.length
      ? state.radioMetadata.headers
      : state.currentHeaders;
  }

  function bindEvents() {
    // Typing opens an autocomplete list of "<Make> <Model>" suggestions; the
    // (Pyodide-backed) metadata/settings load only happens once the user picks
    // a suggestion via keyboard or mouse.
    dom.radioSearchEl.addEventListener("input", () => {
      renderRadioSearchResults();
    });

    dom.radioSearchEl.addEventListener("focus", () => {
      renderRadioSearchResults();
    });

    dom.radioSearchEl.addEventListener("keydown", (event) => {
      const isOpen = !dom.radioSearchResultsEl.hidden;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen) {
          renderRadioSearchResults();
          return;
        }
        moveRadioSearchActive(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        if (isOpen && searchActiveIndex >= 0) {
          event.preventDefault();
          applyRadioSearchSelection(searchMatches[searchActiveIndex]);
        }
      } else if (event.key === "Escape") {
        if (isOpen) {
          event.stopPropagation();
          hideRadioSearchResults();
        }
      }
    });

    dom.radioSearchEl.addEventListener("blur", () => {
      // Delay so a click on a suggestion (which blurs the input) still lands.
      setTimeout(() => hideRadioSearchResults(), 150);
    });

    dom.radioSearchResultsEl.addEventListener("mousedown", (event) => {
      // Prevent the input blur so the click handler below sees the list open.
      event.preventDefault();
      const li = event.target.closest("li[role='option']");
      if (!li) {
        return;
      }
      const index = Number(li.dataset.index);
      applyRadioSearchSelection(searchMatches[index]);
    });

    dom.radioMakeEl.addEventListener("change", () => {
      refreshModelOptions();
      // A vendor change reports the model it auto-defaulted to, which the user
      // then usually replaces — so picking a radio through the dropdowns sends
      // two radio_selected events. Both are real (the driver for the defaulted
      // model does get loaded), and method separates them: count method="model"
      // for radios people chose, method="make" only for what they passed
      // through on the way.
      trackRadioSelected(state.selectedRadio, "make");
      reloadForSelectedRadio();
    });

    dom.radioModelEl.addEventListener("change", () => {
      const key = dom.radioModelEl.value;
      state.selectedRadio = state.radioCatalog.find((r) => r.key === key) || null;
      if (state.selectedRadio) {
        trackRadioSelected(state.selectedRadio, "model");
        log.logDebug(
          `RADIO SELECT ${makeModelLabel(state.selectedRadio)} (${state.selectedRadio.module}.${state.selectedRadio.className})`,
        );
      }
      reloadForSelectedRadio();
    });
  }

  return {
    bindEvents,
    refreshMakeOptions,
    restoreSelectedRadioCookie,
    setRadioSelectPlaceholder,
    selectRadioByDetectedImage,
    loadSelectedRadioMetadata,
  };
}

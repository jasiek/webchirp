import {
  isStaleRadioLoad,
  nextRadioLoadToken,
  requireRuntimeApi,
} from "./state.js";
import { makeModelLabel } from "./format.js";
import { radioEventParams, trackEvent } from "./analytics.js";

const LAST_RADIO_COOKIE = "webchirp_last_radio";
const RADIO_SEARCH_MAX_RESULTS = 50;
const NO_RADIO_SELECTED_TEXT = "No radio selected";
// Suggestions are the only way to choose a radio, so each one needs an id for
// the combobox's aria-activedescendant to point a screen reader at.
const RADIO_SEARCH_OPTION_ID_PREFIX = "radio-search-option-";

// Radio selection: the free-text search box with its autocomplete list, the
// sidebar readout naming the radio in use, the "last radio" cookie, and the
// metadata load that follows a selection. Search is the only way to pick a
// radio, so nothing is selected until the user picks one (or the cookie
// restores their last). Owns the search-result state; the catalog and the
// selected entry live in the shared state because export/upload read them.
export function createRadioCatalog(ctx) {
  const { dom, state, log, actions } = ctx;
  let searchMatches = [];
  let searchActiveIndex = -1;
  // Overrides the readout while the catalog is loading or failed to load, so a
  // cold start does not claim the user simply has not chosen a radio yet.
  let catalogStatusText = "";

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
    const restored = state.radioCatalog.find((r) => r.vendor === make && r.key === key);
    if (!restored) {
      return false;
    }
    clearRadioFilter();
    state.selectedRadio = restored;
    renderSelectedRadio();
    actions.updateSerialActionState();
    trackRadioSelected(restored, "restored");
    log.logDebug(
      `RADIO RESTORE ${makeModelLabel(restored)} (${restored.module}.${restored.className})`,
    );
    return true;
  }

  // Report which radio a user landed on and how they got there.
  function trackRadioSelected(radio, method) {
    if (!radio) {
      return;
    }
    trackEvent("radio_selected", {
      ...radioEventParams(radio),
      method,
    });
  }

  // Alternate vendor/model identities the same driver is sold under (CHIRP's
  // ALIASES). Searching these is what replaces browsing a make dropdown: a
  // Retevis RT5R owner has no other way to discover it is a Baofeng UV-5R
  // driver, because the catalog lists the entry under Baofeng only.
  function radioAliasIdentities(radio) {
    return (radio.aliases || []).filter(
      (alias) => alias.vendor !== radio.vendor || alias.model !== radio.model,
    );
  }

  function aliasLabel(alias) {
    return `${alias.vendor} ${alias.model}${alias.variant ? ` ${alias.variant}` : ""}`;
  }

  // The radio's own searchable text, without its aliases.
  function primaryHaystack(radio) {
    return `${radio.vendor} ${radio.model} ${radio.className}`.toLowerCase();
  }

  function matchesAllTokens(haystack, tokens) {
    return tokens.every((token) => haystack.includes(token));
  }

  // Match a radio against a search query; every whitespace-separated token must
  // appear somewhere in its own or an alias identity's text (case-insensitive).
  function radioMatchesFilter(radio, tokens) {
    if (tokens.length === 0) {
      return true;
    }
    const primary = primaryHaystack(radio);
    if (matchesAllTokens(primary, tokens)) {
      return true;
    }
    return radioAliasIdentities(radio).some((alias) =>
      matchesAllTokens(`${primary} ${aliasLabel(alias)}`.toLowerCase(), tokens),
    );
  }

  // The alias that explains why a radio matched, or null when its own
  // vendor/model already covers the query. Used to label the suggestion, so a
  // search for "retevis" does not return a list of unexplained Baofengs.
  function matchedAlias(radio, tokens) {
    const primary = primaryHaystack(radio);
    if (tokens.length === 0 || matchesAllTokens(primary, tokens)) {
      return null;
    }
    return (
      radioAliasIdentities(radio).find((alias) =>
        matchesAllTokens(`${primary} ${aliasLabel(alias)}`.toLowerCase(), tokens),
      ) || null
    );
  }

  // Catalog entries matching a free-text search query.
  function matchingRadios(query) {
    const tokens = searchTokens(query);
    if (tokens.length === 0) {
      return [];
    }
    return state.radioCatalog.filter((radio) => radioMatchesFilter(radio, tokens));
  }

  function searchTokens(query) {
    return String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  }

  // "<Make> <Model>" label for a search suggestion; the driver class is added
  // when several catalog entries share the same vendor+model text.
  function radioSearchLabel(radio, hasDuplicateLabel) {
    const base = makeModelLabel(radio);
    const label = radio.isLiveRadio ? `⚡ ${base}` : base;
    return hasDuplicateLabel ? `${label} (${radio.className})` : label;
  }

  // Fill one suggestion row. The name and the alias note are separate elements
  // so the narrow sidebar can stack them instead of ellipsising the name away.
  function fillRadioSearchOption(li, radio, hasDuplicateLabel, alias) {
    const nameEl = document.createElement("span");
    nameEl.className = "radio-search-name";
    nameEl.textContent = radioSearchLabel(radio, hasDuplicateLabel);
    li.appendChild(nameEl);
    if (!alias) {
      return;
    }
    const aliasEl = document.createElement("span");
    aliasEl.className = "radio-search-alias";
    aliasEl.textContent = `also sold as ${aliasLabel(alias)}`;
    li.appendChild(aliasEl);
  }

  // Name the radio the rest of the app is working with. This readout is the
  // only indication of the current selection now that the make/model dropdowns
  // are gone, so it renders after every path that assigns state.selectedRadio.
  function renderSelectedRadio() {
    const radio = state.selectedRadio;
    const isEmpty = !radio;
    dom.radioSelectionEl.classList.toggle("is-empty", isEmpty);
    if (radio) {
      dom.radioSelectionNameEl.textContent = radio.isLiveRadio
        ? `⚡ ${makeModelLabel(radio)}`
        : makeModelLabel(radio);
      dom.radioSelectionDriverEl.textContent = `${radio.module}.${radio.className}`;
      return;
    }
    dom.radioSelectionNameEl.textContent = catalogStatusText || NO_RADIO_SELECTED_TEXT;
    dom.radioSelectionDriverEl.textContent = "";
  }

  function hideRadioSearchResults() {
    searchMatches = [];
    searchActiveIndex = -1;
    dom.radioSearchResultsEl.hidden = true;
    dom.radioSearchResultsEl.innerHTML = "";
    dom.radioSearchEl.setAttribute("aria-expanded", "false");
    dom.radioSearchEl.removeAttribute("aria-activedescendant");
  }

  // Point the combobox at the highlighted suggestion, or at nothing when the
  // list has none to highlight.
  function syncRadioSearchActiveDescendant() {
    if (searchActiveIndex < 0) {
      dom.radioSearchEl.removeAttribute("aria-activedescendant");
      return;
    }
    dom.radioSearchEl.setAttribute(
      "aria-activedescendant",
      `${RADIO_SEARCH_OPTION_ID_PREFIX}${searchActiveIndex}`,
    );
  }

  // Clear the search box and close its suggestion list. The box is a way to
  // change the selection, not a display of it, so it empties after every
  // selection and the readout above it carries the answer.
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
    const tokens = searchTokens(query);
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
        li.id = `${RADIO_SEARCH_OPTION_ID_PREFIX}${index}`;
        li.dataset.index = String(index);
        const hasDuplicateLabel = (labelCounts.get(makeModelLabel(radio)) || 0) > 1;
        fillRadioSearchOption(li, radio, hasDuplicateLabel, matchedAlias(radio, tokens));
        li.setAttribute("aria-selected", index === searchActiveIndex ? "true" : "false");
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
    syncRadioSearchActiveDescendant();
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
      li.setAttribute("aria-selected", index === searchActiveIndex ? "true" : "false");
    });
    syncRadioSearchActiveDescendant();
    items[searchActiveIndex]?.scrollIntoView({ block: "nearest" });
  }

  // Apply a suggestion: name it in the readout and load the radio.
  function applyRadioSearchSelection(radio) {
    if (!radio) {
      return;
    }
    clearRadioFilter();
    state.selectedRadio = radio;
    renderSelectedRadio();
    trackRadioSelected(radio, "search");
    log.logDebug(
      `RADIO SELECT ${makeModelLabel(radio)} (${radio.module}.${radio.className})`,
    );
    reloadForSelectedRadio();
  }

  // Shared side effects after the selected radio changes.
  function reloadForSelectedRadio() {
    actions.updateSerialActionState();
    persistSelectedRadioCookie();
    ctx.table.clearInvalidHighlights();
    ctx.settings.clearInvalid();
    // Every selection transition invalidates older work, including one that
    // returns to the last fully loaded radio and needs no new runtime calls.
    const loadToken = nextRadioLoadToken(state);
    const radio = state.selectedRadio;
    if (radio && radio.key === state.lastLoadedRadioKey) {
      ctx.table.render();
      return;
    }
    Promise.all([
      fetchRadioMetadata(radio),
      ctx.settings.fetchForRadio(radio),
    ])
      .then(([metadata, settingsState]) => {
        if (
          isStaleRadioLoad(state, loadToken)
          || state.selectedRadio?.key !== radio?.key
        ) {
          return;
        }
        // Commit the schema and settings together. If one request finishes
        // before the other, the editor keeps showing the previous radio's
        // complete state rather than a temporary mixture of both radios.
        applyRadioMetadata(metadata);
        ctx.settings.applyLoadedState(settingsState);
        state.lastLoadedRadioKey = radio?.key || "";
        ctx.table.render();
      })
      .catch((error) => {
        if (!isStaleRadioLoad(state, loadToken)) {
          log.reportActionError("Metadata load", error);
        }
      });
  }

  // Say why no radio is named yet while the catalog is unavailable ("Loading…",
  // "Unavailable"), instead of the readout's ordinary empty text.
  function setRadioSelectPlaceholder(label) {
    catalogStatusText = String(label || "");
    renderSelectedRadio();
  }

  // Called once the catalog has loaded: the readout drops the loading text and
  // the search box gets a placeholder that says how much there is to search.
  function refreshCatalog() {
    catalogStatusText = "";
    const count = state.radioCatalog.length;
    dom.radioSearchEl.placeholder = count > 0
      ? `Search ${count} radios…`
      : "No radio definitions available";
    if (state.selectedRadio && !state.radioCatalog.includes(state.selectedRadio)) {
      state.selectedRadio = null;
    }
    renderSelectedRadio();
    actions.updateSerialActionState();
  }

  // Select the catalog entry for a driver without going through the search box
  // (used when a loaded image identifies its own driver).
  function selectRadioByDriver(moduleName, className) {
    const target = state.radioCatalog.find(
      (r) => r.module === moduleName && r.className === className,
    );
    if (!target) {
      return false;
    }
    clearRadioFilter();
    state.selectedRadio = target;
    renderSelectedRadio();
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
    state.selectedRadio = fallback;
    renderSelectedRadio();
    trackRadioSelected(fallback, "image");
    persistSelectedRadioCookie();
    return true;
  }

  async function fetchRadioMetadata(radio) {
    if (!radio) {
      return { headers: [], columns: {} };
    }
    const metadata = await requireRuntimeApi(state).getRadioMetadata({
      module: radio.module,
      className: radio.className,
    });
    return metadata || { headers: [], columns: {} };
  }

  function applyRadioMetadata(metadata) {
    state.radioMetadata = metadata;
    state.currentHeaders = state.radioMetadata.headers?.length
      ? state.radioMetadata.headers
      : state.currentHeaders;
  }

  // Load selected radio's CHIRP-derived column metadata from Python runtime.
  async function loadSelectedRadioMetadata(loadToken = nextRadioLoadToken(state)) {
    const radio = state.selectedRadio;
    const metadata = await fetchRadioMetadata(radio);
    if (isStaleRadioLoad(state, loadToken)) {
      return;
    }
    applyRadioMetadata(metadata);
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
  }

  return {
    bindEvents,
    refreshCatalog,
    restoreSelectedRadioCookie,
    setRadioSelectPlaceholder,
    selectRadioByDetectedImage,
    loadSelectedRadioMetadata,
  };
}

import {
  DEFAULT_REPEATER_API_BASE,
  buildPrzemiennikiRows,
  buildRepeaterEndpoints,
  parsePrzemiennikiMetaJson,
  parsePrzemiennikiXml,
} from "../datasources.js";
import { countryDisplayName, flagEmojiFromCountryCode } from "./format.js";
import { decodeMaidenheadBox, encodeMaidenhead } from "../rsgb.js";
import { classifyErrorKind, trackEvent } from "./analytics.js";

const REPEATER_API_BASE_META = "webchirp-repeater-api-base";

// Resolve the repeater-query API base for this deployment. A
// <meta name="webchirp-repeater-api-base"> tag overrides the built-in default:
// its content (a proxy base URL, or blank to disable the online-query
// features) wins when the tag is present; without the tag the default applies.
function resolveRepeaterApiBase() {
  const meta = document.querySelector(`meta[name="${REPEATER_API_BASE_META}"]`);
  if (meta) {
    return String(meta.getAttribute("content") || "").trim();
  }
  return DEFAULT_REPEATER_API_BASE;
}

// Online repeater directory imports (przemienniki.net, RepeaterBook): the
// filter modal, its dictionary fetch, the query itself, and inserting the
// results as channels. Both sources share one modal, so the active source is
// tracked here.
export function createRepeaterQuery(ctx) {
  const { dom, state, log } = ctx;

  let przemiennikiDictionaryPromise = null;
  let repeaterbookDictionaryPromise = null;
  let activeSource = "przemienniki";

  // Online repeater queries depend on a CORS proxy; when none is configured
  // (blank base) the endpoints are null and these features are disabled: the
  // menu items are hidden so they can't fire requests that will fail.
  const endpoints = buildRepeaterEndpoints(resolveRepeaterApiBase());
  const enabled = endpoints !== null;
  if (!enabled) {
    dom.channelImportPrzemiennikiEl.hidden = true;
    dom.channelImportRepeaterbookEl.hidden = true;
  }

  const sources = {
    przemienniki: {
      key: "przemienniki",
      label: "przemienniki.net",
      actionLabel: "Przemienniki",
      insertLabel: "przemienniki",
      apiUrl: endpoints?.przemienniki.apiUrl || "",
      metaUrl: endpoints?.przemienniki.metaUrl || "",
      getDictionaryPromise: () => przemiennikiDictionaryPromise,
      setDictionaryPromise: (value) => {
        przemiennikiDictionaryPromise = value;
      },
    },
    repeaterbook: {
      key: "repeaterbook",
      label: "repeaterbook.com",
      actionLabel: "RepeaterBook",
      insertLabel: "repeaterbook",
      apiUrl: endpoints?.repeaterbook.apiUrl || "",
      metaUrl: endpoints?.repeaterbook.metaUrl || "",
      getDictionaryPromise: () => repeaterbookDictionaryPromise,
      setDictionaryPromise: (value) => {
        repeaterbookDictionaryPromise = value;
      },
    },
  };

  function activeSourceConfig() {
    return sources[activeSource] || sources.przemienniki;
  }

  function setActiveSource(sourceKey) {
    activeSource = sources[sourceKey] ? sourceKey : "przemienniki";
    dom.przemiennikiModalTitleEl.textContent = `Query ${activeSourceConfig().label}`;
  }

  function replaceOptions(selectEl, options, placeholderLabel) {
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

  function replaceCheckboxOptions(containerEl, options, name) {
    containerEl.innerHTML = "";
    options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "modal-mode-option";
      label.title = option.title || option.label || option.value;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option.value;
      checkbox.name = name;
      const text = document.createElement("span");
      text.textContent = option.label || option.value;
      label.appendChild(checkbox);
      label.appendChild(text);
      containerEl.appendChild(label);
    });
  }

  function populateCountryOptions(codes) {
    const countries = Array.from(codes || [])
      .map((code) => {
        const name = countryDisplayName(code);
        const flag = flagEmojiFromCountryCode(code);
        return {
          value: code,
          label: `${flag} ${name}`.trim(),
          title: name,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    replaceOptions(dom.przemiennikiCountryEl, countries, "Any country");
  }

  function populateBandOptions(bands) {
    const options = Array.from(bands || [])
      .map((band) => ({ value: band, label: band, title: band }))
      .sort((a, b) => a.value.localeCompare(b.value));
    replaceCheckboxOptions(dom.przemiennikiBandListEl, options, "band");
  }

  function populateModeOptions(modes) {
    replaceCheckboxOptions(dom.przemiennikiModeListEl, Array.from(modes || []), "mode");
  }

  function selectedModes() {
    return Array.from(dom.przemiennikiModeListEl.querySelectorAll('input[name="mode"]:checked'))
      .map((el) => String(el.value || "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  function selectedBands() {
    return Array.from(dom.przemiennikiBandListEl.querySelectorAll('input[name="band"]:checked'))
      .map((el) => String(el.value || "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  async function ensureDictionaryLoaded() {
    const source = activeSourceConfig();
    const existingPromise = source.getDictionaryPromise();
    if (existingPromise) {
      return existingPromise;
    }
    const dictionaryPromise = (async () => {
      const response = await fetch(source.metaUrl);
      if (!response.ok) {
        throw new Error(`Dictionary request failed: HTTP ${response.status}`);
      }
      const jsonText = await response.text();
      const parsed = parsePrzemiennikiMetaJson(jsonText);
      populateCountryOptions(parsed.countries);
      populateBandOptions(parsed.bands);
      populateModeOptions(parsed.modes);
      log.logDebug(`Loaded ${source.label} filter options from /meta.`);
      return parsed;
    })();
    source.setDictionaryPromise(dictionaryPromise);
    try {
      return await dictionaryPromise;
    } catch (error) {
      source.setDictionaryPromise(null);
      throw error;
    }
  }

  // Number("") is 0, not NaN, so a blank coordinate field would otherwise
  // read as a position on the equator — and encode as a locator.
  function numericFieldValue(el) {
    const text = String(el.value ?? "").trim();
    if (text === "") {
      return Number.NaN;
    }
    return Number(text);
  }

  function currentPosition() {
    const latitude = numericFieldValue(dom.przemiennikiLatitudeEl);
    const longitude = numericFieldValue(dom.przemiennikiLongitudeEl);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return null;
    }
    return { latitude, longitude };
  }

  // The locator field is a two-way alternative way to enter the position, not
  // a filter of its own: runQuery only ever sends latitude/longitude, which is
  // all either API understands. Editing one side rewrites the other; the
  // rewrites are programmatic value assignments, which fire no input events,
  // so the two handlers cannot feed back into each other.
  function refreshLocatorFromCoords() {
    const position = currentPosition();
    dom.przemiennikiLocatorEl.value = position
      ? encodeMaidenhead(position.latitude, position.longitude, 6)
      : "";
  }

  function applyLocatorToCoords() {
    const box = decodeMaidenheadBox(dom.przemiennikiLocatorEl.value);
    if (!box) {
      // Partial or invalid text (no valid 4-character prefix yet): keep the
      // coordinates the user already has instead of wiping them mid-keystroke.
      return;
    }
    dom.przemiennikiLatitudeEl.value = box.latitude.toFixed(6);
    dom.przemiennikiLongitudeEl.value = box.longitude.toFixed(6);
  }

  function setModalOpen(open) {
    dom.przemiennikiModalEl.classList.toggle("hidden", !open);
    if (open) {
      dom.przemiennikiCountryEl.focus();
    }
  }

  function isModalOpen() {
    return !dom.przemiennikiModalEl.classList.contains("hidden");
  }

  async function openModal(sourceKey) {
    if (!enabled) {
      return;
    }
    setActiveSource(sourceKey);
    const source = activeSourceConfig();
    ctx.table.setMenuOpen(false);
    log.setStatus(`Loading ${source.label} query options...`);
    await ensureDictionaryLoaded();
    // The coordinate fields are plain DOM properties that survive a close, so
    // bring the locator back in step with whatever they still hold.
    refreshLocatorFromCoords();
    setModalOpen(true);
    // Paired with repeater_import, this shows how many people open the filter
    // modal and never run a query.
    trackEvent("repeater_modal_opened", { repeater_source: source.key });
    log.setStatus(`Configure ${source.label} query.`);
  }

  function appendQueryParam(url, key, value) {
    const text = String(value ?? "").trim();
    if (!text) {
      return;
    }
    url.searchParams.set(key, text);
  }

  async function runQuery() {
    if (!state.currentHeaders.length) {
      log.setStatus("No channel schema loaded yet.");
      return;
    }
    const source = activeSourceConfig();
    const url = new URL(source.apiUrl);
    appendQueryParam(url, "country", String(dom.przemiennikiCountryEl.value || "").toLowerCase());
    const bands = selectedBands();
    if (bands.length > 0) {
      url.searchParams.set("band", bands.join(","));
    }
    selectedModes().forEach((mode) => {
      url.searchParams.append("mode", mode);
    });
    if (dom.przemiennikiOnlyWorkingEl.checked) {
      url.searchParams.set("onlyworking", "true");
    }
    appendQueryParam(url, "latitude", dom.przemiennikiLatitudeEl.value || "");
    appendQueryParam(url, "longitude", dom.przemiennikiLongitudeEl.value || "");
    appendQueryParam(url, "range", dom.przemiennikiRangeEl.value || "");
    log.setStatus(`Querying ${source.label}...`);
    const response = await fetch(url.toString());
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${source.actionLabel} query failed: HTTP ${response.status}\n${body.slice(0, 800)}`);
    }
    const xmlText = await response.text();
    const parsed = parsePrzemiennikiXml(xmlText);
    const rowsToInsert = buildPrzemiennikiRows(parsed.repeaters, ctx.table.rowBuilderHooks());
    ctx.table.insertRowsAtSelectionOrEnd(rowsToInsert, source.insertLabel);
    // result_count is the point of this event: a query that returns nothing
    // means the filters or the proxy are wrong, and today that is invisible.
    // The country code is a filter the user picked from a fixed list; the
    // latitude/longitude fields are never reported.
    trackEvent("repeater_import", {
      repeater_source: source.key,
      country: String(dom.przemiennikiCountryEl.value || "").toLowerCase() || "any",
      located: dom.przemiennikiLatitudeEl.value ? "yes" : "no",
      result_count: parsed.repeaters.length,
    });
    log.logDebug(`${source.actionLabel.toUpperCase()} QUERY ${url.toString()}`);
    log.logDebug(`${source.actionLabel.toUpperCase()} RESULTS ${parsed.repeaters.length}`);
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
    dom.przemiennikiLatitudeEl.value = latitude.toFixed(6);
    dom.przemiennikiLongitudeEl.value = longitude.toFixed(6);
    refreshLocatorFromCoords();
    log.setStatus("Geolocation loaded into latitude/longitude fields.");
    log.logDebug(`PRZEMIENNIKI GEO ${latitude.toFixed(6)},${longitude.toFixed(6)}`);
  }

  function bindEvents() {
    dom.channelImportPrzemiennikiEl.addEventListener("click", async () => {
      try {
        await openModal("przemienniki");
      } catch (error) {
        log.reportActionError("Przemienniki modal", error);
      }
    });
    dom.channelImportRepeaterbookEl.addEventListener("click", async () => {
      try {
        await openModal("repeaterbook");
      } catch (error) {
        log.reportActionError("RepeaterBook modal", error);
      }
    });
    dom.przemiennikiCancelEl.addEventListener("click", () => {
      const source = activeSourceConfig();
      setModalOpen(false);
      log.setStatus(`Cancelled ${source.label} query.`);
    });
    dom.przemiennikiGeolocateEl.addEventListener("click", async () => {
      try {
        await geolocate();
        // Only that geolocation was used and whether it worked — the
        // coordinates it produced stay in the form.
        trackEvent("repeater_geolocate", { repeater_source: activeSource, outcome: "ok" });
      } catch (error) {
        trackEvent("repeater_geolocate", {
          repeater_source: activeSource,
          outcome: "failed",
          error_kind: classifyErrorKind(error),
        });
        log.reportActionError("Przemienniki geolocation", error);
      }
    });
    dom.przemiennikiLatitudeEl.addEventListener("input", refreshLocatorFromCoords);
    dom.przemiennikiLongitudeEl.addEventListener("input", refreshLocatorFromCoords);
    dom.przemiennikiLocatorEl.addEventListener("input", applyLocatorToCoords);
    dom.przemiennikiModalEl.addEventListener("click", (event) => {
      if (event.target === dom.przemiennikiModalEl) {
        setModalOpen(false);
      }
    });
    dom.przemiennikiFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await runQuery();
        setModalOpen(false);
      } catch (error) {
        log.reportActionError(`${activeSourceConfig().actionLabel} query`, error);
      }
    });
  }

  return { bindEvents, isModalOpen, setModalOpen };
}

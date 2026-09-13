import {
  DEFAULT_REPEATER_API_BASE,
  buildRepeaterEndpoints,
  fetchCitySuggestions,
} from "../datasources.js";
import { encodeMaidenhead } from "../rsgb.js";
import { classifyErrorKind, errorTypeName, trackEvent } from "./analytics.js";
import { FLOWS, OUTCOMES, recordFlow } from "./metrics.js";
import { RepeaterInputError, createRepeaterSources } from "./repeater-sources.js";
import {
  createCheckboxField,
  createCheckboxGroupField,
  createCityField,
  createFixedField,
  createNumberField,
  createPositionField,
  createSelectField,
} from "./query-fields.js";

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

// The key every source gives its "repeaters within N km" filter. The position
// field's map preview draws that radius, so the shell has to know which field
// carries it; a source that named it something else would simply preview no
// circle, which is why this is one constant rather than a guess per source.
const RANGE_FIELD_KEY = "radius";

// How long the form must sit still before the map preview queries a directory.
// A preview repeats the real query (up to nine ~75 kB requests for RSGB, see
// FINDINGS.md) and a drag rewrites the coordinates on every pointermove, so the
// delay is set by what a wasted preview costs, not by what the user can feel.
const PREVIEW_QUERY_DEBOUNCE_MS = 600;

const FIELD_FACTORIES = {
  select: createSelectField,
  fixed: createFixedField,
  checkboxGroup: createCheckboxGroupField,
  checkbox: createCheckboxField,
  number: createNumberField,
};

// Online repeater directory imports. One modal serves every source: each
// source config (web/js/ui/repeater-sources.js) declares its fields, and the grid is
// rebuilt from them on every open — which is also the reset policy: filters
// always come back at their per-source defaults, so the modal always opens in
// the state it documents (a once-ticked "include off-air" cannot silently
// stick forever). The position is the deliberate exception: it survives
// closes and source switches alike, because where the user is does not change
// with the directory they ask.
export function createRepeaterQuery(ctx) {
  const { dom, state, log } = ctx;

  // przemienniki.net and RepeaterBook depend on the configured proxy base; a
  // blank base hides them. IRTS remains available through api.codeplug.org so
  // a service failure is visible when the user tries it, rather than silently
  // removing the action.
  const endpoints = buildRepeaterEndpoints(resolveRepeaterApiBase());
  const sources = createRepeaterSources(ctx, { endpoints });
  for (const source of sources) {
    if (!source.available) {
      dom[source.toolbarButton].hidden = true;
    }
  }

  let activeSource = sources[0];
  // Counts openModal() calls so a superseded one can bow out. Sources that
  // fetch a dictionary resolve after sources whose options are static, and the
  // directory buttons are now one click apart on the toolbar rather than two
  // clicks apart through a menu — so the slow first click would otherwise
  // rebuild the modal the second click had already opened.
  let openGeneration = 0;
  let fieldInstances = [];
  let positionField = null;
  let cityField = null;
  const positionState = { latitudeText: "", longitudeText: "" };
  // The place the City/Locality box last settled on. Kept for the same reason
  // the coordinates are: it is where the user is, which does not change with
  // the directory they ask. Held here rather than in the field because the
  // field is rebuilt on every open.
  const cityState = { city: null };
  // True only while onCitySelected is writing the position it just chose.
  // setPosition() reports through the position field's onChange, which is also
  // how a geolocate, a typed digit or a map drag arrives -- and those must wipe
  // the city name, because it would no longer describe the coordinates. Without
  // this flag, choosing a city would immediately erase its own name.
  let applyingCity = false;
  // True while a query is awaiting its network round-trip. The submit handler
  // is async, so without this a second submit re-enters it while the first is
  // suspended, and both resolved queries insert their rows — every repeater
  // twice. An RSGB fan-out over 24 squares takes seconds, so the window is
  // wide enough to hit by double-clicking.
  let queryInFlight = false;
  const submitIdleLabel = dom.repeaterQuerySubmitEl.textContent || "Query API";

  // Mark the query busy: the flag is what actually rejects a re-entrant
  // submit (Enter in a text field submits the form too, not just the button),
  // while the disabled button and its label are how the user sees why the
  // second click did nothing.
  function setQueryBusy(busy) {
    queryInFlight = busy;
    dom.repeaterQuerySubmitEl.disabled = busy;
    dom.repeaterQuerySubmitEl.textContent = busy ? "Querying..." : submitIdleLabel;
  }

  // A city was committed in the autocomplete: its coordinates become the
  // form's position. setPosition() is the same entry point geolocation and the
  // map drag use, so the locator is recomputed and the preview recentres for
  // free -- the city field never touches those three inputs itself.
  function onCitySelected(city) {
    cityState.city = city;
    if (!positionField) {
      return;
    }
    applyingCity = true;
    try {
      positionField.setPosition(city.latitude, city.longitude);
    } finally {
      applyingCity = false;
    }
    // Counted alongside repeater_geolocate and repeater_map_panned so the ways
    // of setting a position can be compared. Which source was open and nothing
    // else: the place name is a search term and the coordinates are a location,
    // and neither leaves the browser through analytics.
    trackEvent("repeater_city_selected", { repeater_source: activeSource.key });
    // The name and the coordinates are fine in the local debug panel, which is
    // the same detail the geolocate path logs.
    log.setStatus(`Location set to ${city.name}.`);
    log.logDebug(`${activeSource.actionLabel.toUpperCase()} CITY ${city.name} ${city.latitude.toFixed(6)},${city.longitude.toFixed(6)}`);
  }

  function buildFields(source, loadedOptions) {
    dom.repeaterQueryGridEl.innerHTML = "";
    fieldInstances = [];
    positionField = null;
    cityField = null;
    for (const config of source.fields) {
      let instance;
      if (config.kind === "city") {
        instance = createCityField({
          ...config,
          // The field contacts nothing itself. No position hint is sent: the
          // ranking it buys is not worth putting the form's location in a query
          // string on every keystroke. fetchCitySuggestions still takes it.
          search: (query) => fetchCitySuggestions(endpoints.cities, query),
          // Not reportActionError: a failed suggestion is not a failed action
          // and must not take over the status line the real query uses.
          onError: (error) => log.logDebug(`CITY LOOKUP FAILED ${error?.stack || error}`),
          onSelect: (city) => onCitySelected(city),
          // Reopening the modal shows the place last chosen, in step with the
          // coordinates the position field restores beside it.
          initial: cityState,
        });
        cityField = instance;
      } else if (config.kind === "position") {
        instance = createPositionField({
          locatorPlaceholder: config.locatorPlaceholder,
          initial: positionState,
          onChange: (latitudeText, longitudeText) => {
            positionState.latitudeText = latitudeText;
            positionState.longitudeText = longitudeText;
            // The position moved by some route other than the city picker, so
            // whatever place name is in the box is now describing coordinates
            // that are no longer its own.
            if (!applyingCity) {
              cityState.city = null;
              cityField?.clear();
            }
            schedulePreview();
          },
          // Counted next to repeater_geolocate, so the three ways of setting a
          // position can be compared. Which source was open, never where the
          // drag landed — the coordinates stay in the form.
          onPan: () => trackEvent("repeater_map_panned", { repeater_source: activeSource.key }),
        });
        positionField = instance;
        // The button is recreated with the field on every open, so the
        // listener attaches here rather than in bindEvents.
        instance.geolocateButton.addEventListener("click", onGeolocateClick);
      } else {
        const factory = FIELD_FACTORIES[config.kind];
        const options = config.optionsKey
          ? loadedOptions?.[config.optionsKey] || []
          : config.options;
        instance = factory({ ...config, options });
      }
      for (const node of instance.nodes) {
        dom.repeaterQueryGridEl.appendChild(node);
      }
      fieldInstances.push(instance);
    }
    bindRangeToPreview();
  }

  // Feed the range filter's value to the position field, which draws it as a
  // circle on its map preview and frames the map around it. This runs after
  // the build loop rather than inside it because the range field is declared
  // after the position field it has to reach — and both are rebuilt on every
  // open, so the listener is attached here rather than in bindEvents.
  function bindRangeToPreview() {
    const range = fieldInstances.find((instance) => instance.key === RANGE_FIELD_KEY);
    if (!positionField || !range?.input) {
      return;
    }
    const applyRange = () => positionField.setRangeKm(range.value());
    range.input.addEventListener("input", applyRange);
    applyRange();
  }

  // Ask the active source what its current filters would return, and hand the
  // positions to the map. Nothing here can fail the form: a preview is a hint,
  // so a directory that refuses one leaves the map as it was and says so under
  // it, with the reason in the debug panel and nothing in the status line.
  //
  // Generation-counted like openModal, and for the same reason twice over: an
  // edit during a slow preview supersedes it, and so does switching to another
  // directory, whose answer must never be drawn under the first one's filters.
  let previewGeneration = 0;
  let previewTimer = 0;

  async function runPreview(source, values) {
    const generation = previewGeneration;
    positionField?.setMarkers(null, "loading");
    let result = null;
    try {
      result = await source.previewQuery(values);
    } catch (error) {
      if (generation !== previewGeneration) {
        return;
      }
      positionField?.setMarkers(null, "failed");
      // The whole error, as the city lookup logs it: a preview that fails
      // inside the XML parser is only diagnosable from the stack.
      log.logDebug(`${source.actionLabel.toUpperCase()} PREVIEW FAILED ${error?.stack || error}`);
      return;
    }
    if (generation !== previewGeneration) {
      return;
    }
    // null is the sources' "there was nothing to ask" — a blank, zero or
    // negative radius. Reporting it as an empty answer would caption the map
    // "0 in range" and log a successful zero-result preview, when in fact no
    // directory was contacted and the form simply is not filled in yet.
    if (!result) {
      positionField?.setMarkers([], "off");
      return;
    }
    positionField?.setMarkers(result.points, "ok", {
      truncated: result.truncated === true,
      // The two ways the map and the Query API button can disagree about a
      // total: one the query inserts but the map cannot place, one the map
      // places but the radio cannot use.
      unmapped: result.unmapped || 0,
      unsupported: result.unsupported || 0,
    });
    log.logDebug(`${source.actionLabel.toUpperCase()} PREVIEW ${result.points.length} repeater(s)${result.truncated ? " (area clipped)" : ""}${result.unsupported ? `, ${result.unsupported} unsupported` : ""}${result.unmapped ? `, ${result.unmapped} unmapped` : ""}`);
  }

  // Called by every control in the form. The work is deferred, so a drag that
  // fires this on each pointermove still costs one preview.
  function schedulePreview() {
    previewGeneration += 1;
    if (previewTimer) {
      clearTimeout(previewTimer);
    }
    if (!isModalOpen() || typeof activeSource?.previewQuery !== "function") {
      return;
    }
    // The same guard the submit handler applies. Without it the map fetches,
    // plots squares and captions "23 in range" for a query that Query API
    // immediately refuses with "No channel schema loaded yet" — promising
    // results the button cannot deliver, and spending a directory request to
    // do it.
    if (!state.currentHeaders.length) {
      positionField?.setMarkers([], "blocked");
      return;
    }
    const values = collectValues();
    // No position is not a failed preview, it is a form not yet filled in: the
    // map is showing its stand-in line, and a count under it would be counting
    // nothing.
    if (!values.position) {
      positionField?.setMarkers([], "off");
      return;
    }
    const source = activeSource;
    previewTimer = setTimeout(() => {
      previewTimer = 0;
      runPreview(source, values);
    }, PREVIEW_QUERY_DEBOUNCE_MS);
  }

  function collectValues() {
    const values = {};
    for (const instance of fieldInstances) {
      values[instance.key] = instance.value();
    }
    return values;
  }

  function setModalOpen(open) {
    dom.repeaterQueryModalEl.classList.toggle("hidden", !open);
    if (open) {
      const focusable = fieldInstances.find((instance) => instance.focusTarget);
      focusable?.focusTarget.focus();
      // Only now does the position field's map canvas have a width to measure:
      // buildFields() ran while the overlay was still display:none, where every
      // element is zero-sized. Same reason web/js/ui/repeater-map.js shows its
      // modal before sizing the map inside it.
      positionField?.refreshPreview();
      // The position survives a close, so a reopened modal usually already has
      // one — and the map should show what is out there without waiting to be
      // touched.
      schedulePreview();
    } else {
      // Nothing in flight may land on a closed modal, or on the next one.
      previewGeneration += 1;
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = 0;
      }
    }
  }

  function isModalOpen() {
    return !dom.repeaterQueryModalEl.classList.contains("hidden");
  }

  async function openModal(sourceKey) {
    const source = sources.find((entry) => entry.key === sourceKey);
    if (!source || !source.available) {
      return;
    }
    const generation = ++openGeneration;
    let loadedOptions = null;
    if (source.loadOptions) {
      log.setStatus(`Loading ${source.label} query options...`);
      loadedOptions = await source.loadOptions();
      // Another source was asked for while this one was loading; it owns the
      // modal now, so leave it alone. The load still resolved, so a failure
      // here is still reported by the caller.
      if (generation !== openGeneration) {
        return;
      }
    }
    activeSource = source;
    buildFields(source, loadedOptions);
    dom.repeaterQueryTitleEl.textContent = source.title;
    setModalOpen(true);
    // Paired with repeater_import, this shows how many people open the filter
    // modal and never run a query.
    trackEvent("repeater_modal_opened", { repeater_source: source.key });
    log.setStatus(`Configure ${source.label} query.`);
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
    positionField.setPosition(latitude, longitude);
    const locator = encodeMaidenhead(latitude, longitude, 6);
    log.setStatus(`Location set to ${locator}.`);
    log.logDebug(`${activeSource.actionLabel.toUpperCase()} GEO ${latitude.toFixed(6)},${longitude.toFixed(6)} ${locator}`);
  }

  async function onGeolocateClick() {
    try {
      await geolocate();
      // Only that geolocation was used and whether it worked — the
      // coordinates it produced stay in the form.
      trackEvent("repeater_geolocate", { repeater_source: activeSource.key, outcome: "ok" });
    } catch (error) {
      trackEvent("repeater_geolocate", {
        repeater_source: activeSource.key,
        outcome: "failed",
        error_kind: classifyErrorKind(error),
      });
      log.reportActionError(`${activeSource.actionLabel} geolocation`, error);
    }
  }

  function bindEvents() {
    // One delegated listener on the grid, which outlives the fields inside it,
    // so a field kind added later is previewed without knowing about this. Both
    // event types: checkboxes and selects report on "change", text and number
    // boxes on "input".
    for (const type of ["input", "change"]) {
      dom.repeaterQueryGridEl.addEventListener(type, schedulePreview);
    }
    for (const source of sources) {
      dom[source.toolbarButton].addEventListener("click", async () => {
        try {
          await openModal(source.key);
        } catch (error) {
          log.reportActionError(`${source.actionLabel} modal`, error);
        }
      });
    }
    dom.repeaterQueryCancelEl.addEventListener("click", () => {
      setModalOpen(false);
      log.setStatus(`Cancelled ${activeSource.label} query.`);
    });
    dom.repeaterQueryModalEl.addEventListener("click", (event) => {
      if (event.target === dom.repeaterQueryModalEl) {
        setModalOpen(false);
      }
    });
    dom.repeaterQueryFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (queryInFlight) {
        return;
      }
      setQueryBusy(true);
      // Captured before the await, for the same reason the clone paths capture
      // the radio: Cancel and the backdrop close the modal without waiting for
      // the query, so the user can open a different directory while this one is
      // still in flight, and openModal() reassigns activeSource when they do.
      // Every line below has to keep meaning the source the query started on.
      const source = activeSource;
      try {
        if (!state.currentHeaders.length) {
          log.setStatus("No channel schema loaded yet.");
          setModalOpen(false);
          return;
        }
        await source.runQuery(collectValues());
        recordFlow(FLOWS.REPEATER_QUERY, OUTCOMES.OK, { repeater_source: source.key });
        setModalOpen(false);
      } catch (error) {
        // The only place a failed directory lookup is reported at all: the
        // repeater_import event fires on success, so until now a proxy that
        // started returning errors looked exactly like nobody running a query.
        // Every source shares this one handler, so one call site covers all of
        // them.
        //
        // Input the form itself rejected is "blocked" rather than "failed":
        // nothing was requested, there is nothing wrong with the directory, and
        // the user can fix it in the box in front of them. Counting those as
        // failures is what would have an alert firing over a missing location.
        const blocked = error instanceof RepeaterInputError;
        recordFlow(FLOWS.REPEATER_QUERY, blocked ? OUTCOMES.BLOCKED : OUTCOMES.FAILED, {
          repeater_source: source.key,
          error_kind: classifyErrorKind(error),
          error_type: errorTypeName(error),
        });
        log.reportActionError(`${source.actionLabel} query`, error);
      } finally {
        setQueryBusy(false);
      }
    });
  }

  return { bindEvents, isModalOpen, setModalOpen };
}

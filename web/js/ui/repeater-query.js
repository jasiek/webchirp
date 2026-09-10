import { DEFAULT_REPEATER_API_BASE, buildRepeaterEndpoints } from "../datasources.js";
import { encodeMaidenhead } from "../rsgb.js";
import { classifyErrorKind, errorTypeName, trackEvent } from "./analytics.js";
import { FLOWS, OUTCOMES, recordFlow } from "./metrics.js";
import { RepeaterInputError, createRepeaterSources } from "./repeater-sources.js";
import {
  createCheckboxField,
  createCheckboxGroupField,
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
  let fieldInstances = [];
  let positionField = null;
  const positionState = { latitudeText: "", longitudeText: "" };
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

  function buildFields(source, loadedOptions) {
    dom.repeaterQueryGridEl.innerHTML = "";
    fieldInstances = [];
    positionField = null;
    for (const config of source.fields) {
      let instance;
      if (config.kind === "position") {
        instance = createPositionField({
          locatorPlaceholder: config.locatorPlaceholder,
          initial: positionState,
          onChange: (latitudeText, longitudeText) => {
            positionState.latitudeText = latitudeText;
            positionState.longitudeText = longitudeText;
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
    let loadedOptions = null;
    if (source.loadOptions) {
      log.setStatus(`Loading ${source.label} query options...`);
      loadedOptions = await source.loadOptions();
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

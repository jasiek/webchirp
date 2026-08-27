import { DEFAULT_REPEATER_API_BASE, buildRepeaterEndpoints } from "../datasources.js";
import { encodeMaidenhead } from "../rsgb.js";
import { classifyErrorKind, trackEvent } from "./analytics.js";
import { createRepeaterSources } from "./repeater-sources.js";
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

const FIELD_FACTORIES = {
  select: createSelectField,
  fixed: createFixedField,
  checkboxGroup: createCheckboxGroupField,
  checkbox: createCheckboxField,
  number: createNumberField,
};

// Online repeater directory imports. One modal serves every source: each
// source config (ui/repeater-sources.js) declares its fields, and the grid is
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
      dom[source.menuButton].hidden = true;
    }
  }

  let activeSource = sources[0];
  let fieldInstances = [];
  let positionField = null;
  const positionState = { latitudeText: "", longitudeText: "" };

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
    ctx.table.setMenuOpen(false);
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
      dom[source.menuButton].addEventListener("click", async () => {
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
      try {
        if (!state.currentHeaders.length) {
          log.setStatus("No channel schema loaded yet.");
          setModalOpen(false);
          return;
        }
        await activeSource.runQuery(collectValues());
        setModalOpen(false);
      } catch (error) {
        log.reportActionError(`${activeSource.actionLabel} query`, error);
      }
    });
  }

  return { bindEvents, isModalOpen, setModalOpen };
}

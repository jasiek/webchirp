import {
  buildPrzemiennikiRows,
  parsePrzemiennikiMetaJson,
  parsePrzemiennikiXml,
} from "../datasources.js";
import {
  RSGB_BANDS,
  RSGB_COUNTRY_CODE,
  RSGB_COUNTRY_LABEL,
  RSGB_DEFAULT_BANDS,
  RSGB_DEFAULT_MODES,
  RSGB_DEFAULT_RADIUS_KM,
  RSGB_MODES,
  buildRsgbRows,
  dedupeRsgbRecords,
  fetchRsgbRecords,
  filterRsgbRecords,
  squaresForRadius,
} from "../rsgb.js";
import { countryDisplayName, flagEmojiFromCountryCode } from "./format.js";
import { trackEvent } from "./analytics.js";

// Per-source configuration for the shared repeater-query modal
// (ui/repeater-query.js). Each source declares which fields its form contains,
// how its filter options are obtained, and how a query actually runs — the
// flows differ at the root and stay per-source here: przemienniki.net,
// RepeaterBook and IRTS take the filter as query parameters (via the configured
// API base) and hand back a filtered set, while RSGB filtering happens
// client-side over a locator-square fan-out and needs no proxy. Only the form
// UI is shared.
//
// Not a create<Area> sibling module: this is a helper imported solely by
// repeater-query.js, which passes it the constructed ctx.
export function createRepeaterSources(ctx, { endpoints }) {
  const { log } = ctx;

  function countryOptions(codes) {
    return Array.from(codes || [])
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
  }

  function bandOptions(bands) {
    return Array.from(bands || [])
      .map((band) => ({ value: band, label: band, title: band }))
      .sort((a, b) => a.value.localeCompare(b.value));
  }

  // Both row builders return `skipped` entries tagged with why the selected
  // radio could not express the repeater. One phrasing for both, so the status
  // line reads the same whichever directory was queried.
  function skippedDetail(skipped) {
    const counts = {
      frequency: skipped.filter((entry) => entry.reason === "frequency").length,
      mode: skipped.filter((entry) => entry.reason === "mode").length,
    };
    return [
      counts.frequency > 0 ? `${counts.frequency} outside its frequency range` : "",
      counts.mode > 0 ? `${counts.mode} in a mode it cannot use` : "",
    ].filter((part) => part.length > 0).join(", ");
  }

  function normalized(values) {
    return Array.from(values || [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  // przemienniki.net, RepeaterBook and IRTS share everything but their labels
  // and endpoints: same field set, same /meta dictionary shape, same
  // query-parameter API, same XML response format.
  function remoteDirectorySource({
    key,
    label,
    actionLabel,
    insertLabel,
    menuButton,
    sourceEndpoints,
  }) {
    const apiUrl = sourceEndpoints?.apiUrl || "";
    const metaUrl = sourceEndpoints?.metaUrl || "";

    // The dictionary is fetched once and cached for the session; a failed
    // fetch clears the cache so the next open retries instead of staying
    // bricked behind a rejected promise.
    let optionsPromise = null;

    return {
      key,
      menuButton,
      // Proxy-dependent sources have null endpoints when the configured base
      // is blank. IRTS always receives its default api.codeplug.org endpoints.
      available: Boolean(apiUrl && metaUrl),
      title: `Query ${label}`,
      label,
      actionLabel,
      insertLabel,
      fields: [
        { kind: "select", key: "country", label: "Country", placeholder: "Any country", optionsKey: "country" },
        // The same starting selection as RSGB: the two bands a handheld can
        // work, on FM. The values are the dictionary's own (lowercase); a
        // dictionary that lacks one simply leaves it unticked.
        { kind: "checkboxGroup", key: "bands", label: "Band", name: "band", optionsKey: "bands", defaults: ["2m", "70cm"] },
        { kind: "checkboxGroup", key: "modes", label: "Mode", name: "mode", optionsKey: "modes", defaults: ["fm"] },
        { kind: "checkbox", key: "only", label: "Only working", checked: true },
        { kind: "position", locatorPlaceholder: "e.g. JO91GG" },
        { kind: "number", key: "radius", label: "Range (km)", min: 1, step: 1, value: 30 },
      ],
      loadOptions: () => {
        if (!optionsPromise) {
          optionsPromise = (async () => {
            const response = await fetch(metaUrl);
            if (!response.ok) {
              throw new Error(`Dictionary request failed: HTTP ${response.status}`);
            }
            const parsed = parsePrzemiennikiMetaJson(await response.text());
            log.logDebug(`Loaded ${label} filter options from /meta.`);
            return {
              country: countryOptions(parsed.countries),
              bands: bandOptions(parsed.bands),
              modes: Array.from(parsed.modes),
            };
          })().catch((error) => {
            optionsPromise = null;
            throw error;
          });
        }
        return optionsPromise;
      },
      runQuery: async (values) => {
        const url = new URL(apiUrl);
        const country = String(values.country || "").trim().toLowerCase();
        if (country) {
          url.searchParams.set("country", country);
        }
        const bands = normalized(values.bands);
        if (bands.length > 0) {
          url.searchParams.set("band", bands.join(","));
        }
        normalized(values.modes).forEach((mode) => {
          url.searchParams.append("mode", mode);
        });
        if (values.only) {
          url.searchParams.set("onlyworking", "true");
        }
        // Only a validated position is sent — out-of-range coordinate text no
        // longer leaks upstream as raw query parameters.
        if (values.position) {
          url.searchParams.set("latitude", String(values.position.latitude));
          url.searchParams.set("longitude", String(values.position.longitude));
        }
        if (Number.isFinite(values.radius)) {
          url.searchParams.set("range", String(values.radius));
        }
        log.setStatus(`Querying ${label}...`);
        const response = await fetch(url.toString());
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`${actionLabel} query failed: HTTP ${response.status}\n${body.slice(0, 800)}`);
        }
        const parsed = parsePrzemiennikiXml(await response.text());
        const { rows, skipped } = buildPrzemiennikiRows(
          parsed.repeaters,
          ctx.table.rowBuilderHooks(),
          { qrgPerspective: parsed.perspective },
        );
        for (const entry of skipped) {
          const reason = entry.reason === "frequency"
            ? "frequency not supported by the selected radio"
            : `${entry.mode || "unknown mode"} not supported by the selected radio`;
          log.logDebug(`${actionLabel.toUpperCase()} SKIPPED ${entry.repeater} (${reason})`);
        }
        ctx.table.insertRowsAtSelectionOrEnd(rows, insertLabel);
        // result_count is the point of this event: a query that returns
        // nothing means the filters or the proxy are wrong, and today that is
        // invisible. The country code is a filter the user picked from a fixed
        // list; the coordinates are never reported.
        trackEvent("repeater_import", {
          repeater_source: key,
          country: country || "any",
          located: values.position ? "yes" : "no",
          result_count: parsed.repeaters.length,
        });
        log.logDebug(`${actionLabel.toUpperCase()} QUERY ${url.toString()}`);
        log.logDebug(`${actionLabel.toUpperCase()} RESULTS ${parsed.repeaters.length} fetched, ${rows.length} inserted`);
        if (skipped.length > 0) {
          log.setStatus(`Inserted ${rows.length} channel(s); skipped ${skippedDetail(skipped)}.`);
        }
      },
    };
  }

  // Display names follow the other sources' dictionary casing ("2m", "fm",
  // "dstar"), so band and mode lists read the same in every modal; the values
  // behind them stay the API's own flags and band codes.
  const RSGB_MODE_LABELS = { A: "fm", D: "dstar" };

  // Modes the directory carries but the import does not offer, because a
  // channel row cannot express them usefully (see RSGB_MODES in web/js/rsgb.js).
  // Shown disabled rather than hidden, so their absence reads as a decision
  // and not a gap; the values are the API's mode flags.
  const RSGB_UNSUPPORTED_MODES = [
    { value: "M", label: "dmr" },
    { value: "P", label: "p25" },
    { value: "N", label: "nxdn" },
    { value: "7", label: "m17" },
  ];
  const RSGB_UNSUPPORTED_TOOLTIP = "Only analogue modes and dstar are supported fully";

  // RSGB/ETCC: the API only knows how to return a locator square, so distance,
  // band and mode are all applied client-side after a square fan-out. It also
  // needs no CORS proxy, so it stays available on deployments where the other
  // two are disabled. Filter options are static — the API's documented flag
  // table and its observed band values, not a dictionary endpoint (the API has
  // none) — so the modal opens without a network round trip.
  function rsgbSource() {
    const actionLabel = "RSGB ETCC";
    return {
      key: "rsgb",
      menuButton: "channelImportRsgbEl",
      available: true,
      title: "Query RSGB ETCC API",
      label: "RSGB ETCC",
      actionLabel,
      insertLabel: "RSGB ETCC",
      fields: [
        // The directory is UK-only, so the country is fixed rather than
        // chosen: a picker with one entry is a control that cannot do
        // anything.
        {
          kind: "fixed",
          key: "country",
          label: "Country",
          text: `${flagEmojiFromCountryCode(RSGB_COUNTRY_CODE)} ${RSGB_COUNTRY_LABEL}`,
        },
        {
          kind: "checkboxGroup",
          key: "bands",
          label: "Band",
          name: "band",
          options: RSGB_BANDS.map((band) => ({ value: band, label: band.toLowerCase(), title: band.toLowerCase() })),
          defaults: RSGB_DEFAULT_BANDS,
        },
        {
          kind: "checkboxGroup",
          key: "modes",
          label: "Mode",
          name: "mode",
          options: [
            ...RSGB_MODES.map((mode) => ({
              value: mode.value,
              label: RSGB_MODE_LABELS[mode.value] || mode.label,
              title: `${mode.label} (${mode.value})`,
            })),
            ...RSGB_UNSUPPORTED_MODES.map((mode) => ({
              ...mode,
              disabled: true,
              title: RSGB_UNSUPPORTED_TOOLTIP,
            })),
          ],
          defaults: RSGB_DEFAULT_MODES,
        },
        { kind: "checkbox", key: "only", label: "Only operational", checked: true },
        { kind: "position", locatorPlaceholder: "e.g. IO91WM" },
        {
          kind: "number",
          key: "radius",
          label: "Distance (km)",
          min: 1,
          max: 500,
          step: 1,
          value: RSGB_DEFAULT_RADIUS_KM,
        },
      ],
      loadOptions: null,
      runQuery: async (values) => {
        const position = values.position;
        if (!position) {
          throw new Error("Set a location first: use the 🛰️ button or type a latitude and longitude.");
        }
        const radiusKm = values.radius;
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
        // An empty selection must not fall through to filterRsgbRecords()'s
        // "any mode" convention: the form presents dmr/p25/nxdn/m17 as
        // unavailable, and "any" would let those records through on a radio
        // that advertises them. No selection means analogue only.
        const modes = values.modes.length > 0 ? values.modes : ["A"];
        const entries = filterRsgbRecords(deduped, {
          latitude: position.latitude,
          longitude: position.longitude,
          radiusKm,
          bands: values.bands,
          modes,
          onlyOperational: values.only,
        });

        log.logDebug(`RSGB RESULTS ${records.length} fetched, ${deduped.length} unique, ${entries.length} matched`);

        // The mode selection goes to the builder as well as the filter, so a
        // D-STAR query gets the DV side of a mixed-mode repeater, not its FM
        // one.
        const { rows, skipped } = buildRsgbRows(entries, ctx.table.rowBuilderHooks(), { modes });
        // Repeaters the radio cannot express are dropped rather than written
        // as something they are not; a shorter list than the match count needs
        // saying out loud, or it reads as results going missing.
        for (const entry of skipped) {
          log.logDebug(`RSGB SKIPPED ${entry.repeater} (${entry.reason} not supported by the selected radio)`);
        }
        ctx.table.insertRowsAtSelectionOrEnd(rows, "RSGB ETCC");
        // result_count is the point of this event: a query that returns
        // nothing means the filters, the radius or the API are wrong, and that
        // is invisible otherwise. The band and mode filters and the position
        // are never reported.
        trackEvent("repeater_import", {
          repeater_source: "rsgb",
          located: "yes",
          result_count: rows.length,
        });
        if (skipped.length > 0) {
          log.setStatus(`Inserted ${rows.length} channel(s); skipped ${skippedDetail(skipped)}.`);
        }
      },
    };
  }

  return [
    remoteDirectorySource({
      key: "przemienniki",
      label: "przemienniki.net",
      actionLabel: "Przemienniki",
      insertLabel: "przemienniki",
      menuButton: "channelImportPrzemiennikiEl",
      sourceEndpoints: endpoints?.przemienniki,
    }),
    remoteDirectorySource({
      key: "repeaterbook",
      label: "repeaterbook.com",
      actionLabel: "RepeaterBook",
      insertLabel: "repeaterbook",
      menuButton: "channelImportRepeaterbookEl",
      sourceEndpoints: endpoints?.repeaterbook,
    }),
    remoteDirectorySource({
      key: "irts",
      label: "IRTS",
      actionLabel: "IRTS",
      insertLabel: "IRTS",
      menuButton: "channelImportIrtsEl",
      sourceEndpoints: endpoints?.irts,
    }),
    rsgbSource(),
  ];
}

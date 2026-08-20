import {
  buildPrzemiennikiRows,
  parsePrzemiennikiMetaJson,
  parsePrzemiennikiXml,
} from "../datasources.js";
import { countryDisplayName, flagEmojiFromCountryCode } from "./format.js";
import { trackEvent } from "./analytics.js";

// Per-source configuration for the shared repeater-query modal
// (ui/repeater-query.js). Each source declares which fields its form contains,
// how its filter options are obtained, and how a query actually runs — the
// flows differ at the root and stay per-source here: przemienniki.net and
// RepeaterBook take the filter as query parameters (via a CORS proxy) and hand
// back a filtered set, while RSGB filtering happens client-side over a
// locator-square fan-out and needs no proxy. Only the form UI is shared.
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

  function normalized(values) {
    return Array.from(values || [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  // przemienniki.net and RepeaterBook share everything but their labels and
  // proxy endpoints: same field set, same /meta dictionary shape, same
  // query-parameter API, same XML response format.
  function remoteDirectorySource({ key, label, actionLabel, insertLabel, menuButton, sourceEndpoints }) {
    const apiUrl = sourceEndpoints?.apiUrl || "";
    const metaUrl = sourceEndpoints?.metaUrl || "";

    // The dictionary is fetched once and cached for the session; a failed
    // fetch clears the cache so the next open retries instead of staying
    // bricked behind a rejected promise.
    let optionsPromise = null;

    return {
      key,
      menuButton,
      // Online queries depend on the CORS proxy; a blank base means no
      // endpoints and the source is disabled (its menu item is hidden).
      available: endpoints !== null,
      title: `Query ${label}`,
      label,
      actionLabel,
      insertLabel,
      fields: [
        { kind: "select", key: "country", label: "Country", placeholder: "Any country", optionsKey: "country" },
        { kind: "checkboxGroup", key: "bands", label: "Band", name: "band", optionsKey: "bands" },
        { kind: "checkboxGroup", key: "modes", label: "Mode", name: "mode", optionsKey: "modes" },
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
        const rowsToInsert = buildPrzemiennikiRows(parsed.repeaters, ctx.table.rowBuilderHooks());
        ctx.table.insertRowsAtSelectionOrEnd(rowsToInsert, insertLabel);
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
        log.logDebug(`${actionLabel.toUpperCase()} RESULTS ${parsed.repeaters.length}`);
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
  ];
}

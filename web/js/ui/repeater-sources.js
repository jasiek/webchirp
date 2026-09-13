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
  haversineKm,
  squaresForRadius,
} from "../rsgb.js";
import { withRequestTimeout } from "../request-timeout.js";
import { countryDisplayName, flagEmojiFromCountryCode, rememberBounded } from "./format.js";
import { trackEvent } from "./analytics.js";

// Per-source configuration for the shared repeater-query modal
// (web/js/ui/repeater-query.js). Each source declares which fields its form contains,
// how its filter options are obtained, and how a query actually runs — the
// flows differ at the root and stay per-source here: przemienniki.net,
// RepeaterBook and IRTS take the filter as query parameters (via the configured
// API base) and hand back a filtered set, while RSGB filtering happens
// client-side over a locator-square fan-out and needs no proxy. Only the form
// UI is shared.
//
// Not a create<Area> sibling module: this is a helper imported solely by
// repeater-query.js, which passes it the constructed ctx.
// A query rejected by this module's own checks, before any request is made --
// an unset location, a distance that is not a positive number. Marked as its
// own type so the one catch in web/js/ui/repeater-query.js can tell it from a
// directory that is actually down: both reach the user the same way, but
// counting form input the user can fix as a service failure inflates the rate
// an alert would watch, and does it most on the sources with the most fields.
//
// A subclass rather than a flag on the error: nothing is added to the object,
// so the marker cannot ride along into a Sentry payload the way a property
// would, and instanceof survives the plain rethrow that carries it to the
// caller.
export class RepeaterInputError extends Error {}

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
      tone: skipped.filter((entry) => entry.reason === "tone").length,
    };
    return [
      counts.frequency > 0 ? `${counts.frequency} outside its frequency range` : "",
      counts.mode > 0 ? `${counts.mode} in a mode it cannot use` : "",
      counts.tone > 0 ? `${counts.tone} needing a tone it cannot send` : "",
    ].filter((part) => part.length > 0).join(", ");
  }

  // The debug line spells out what the status line only counts. Tone carries
  // the frequency the directory published, because "141.3 not in the radio's
  // tone table" is the whole diagnosis.
  function skippedReason(entry) {
    if (entry.reason === "frequency") {
      return "frequency not supported by the selected radio";
    }
    if (entry.reason === "tone") {
      return `${entry.tone || "access"} Hz tone not in the selected radio's tone table`;
    }
    // RSGB names no mode when none of a repeater's modes map, so the word
    // "mode" stands in for the one the other sources report.
    return `${entry.mode || entry.reason} not supported by the selected radio`;
  }

  // A preview repeats the query the Query API button would run, so it must not
  // be issued as freely as a keystroke. These caches hold what was fetched,
  // keyed by the exact request, so the common edits -- nudging the radius,
  // dragging the map a little, ticking a band -- redraw from memory. Module
  // scope rather than per-open, because the cheapest preview is the one the
  // previous open already paid for; capped so a long session cannot grow
  // without bound.
  const PREVIEW_CACHE_LIMIT = 24;

  // Every position a preview can draw, whether or not the query would keep it.
  // `inRange` is what the ring is for: a station just outside it is the answer
  // to "would a wider search find me anything", which the numbers in the form
  // cannot say on their own.
  function previewPoint(latitude, longitude, { inRange = true, approximate = false } = {}) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }
    return { latitude, longitude, inRange, approximate };
  }

  // The request identity minus its range, so one fetched body can answer every
  // radius it covers. Everything else -- country, bands, modes, the only-working
  // flag, the position -- still separates one cached answer from another.
  function keyWithoutRange(url) {
    const key = new URL(url.toString());
    key.searchParams.delete("range");
    return key.toString();
  }

  // Re-flag a point set against the radius now in the form. The cache is keyed
  // without the range, so one body serves every radius it covers: only which
  // side of the ring each station falls on is recomputed, and that is
  // arithmetic rather than a request.
  function markInRange(points, position, radiusKm) {
    return points.map((point) => ({
      ...point,
      inRange: haversineKm(position.latitude, position.longitude, point.latitude, point.longitude) <= radiusKm,
    }));
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
    toolbarButton,
    sourceEndpoints,
  }) {
    const apiUrl = sourceEndpoints?.apiUrl || "";
    const metaUrl = sourceEndpoints?.metaUrl || "";

    // The dictionary is fetched once and cached for the session; a failed
    // fetch clears the cache so the next open retries instead of staying
    // bricked behind a rejected promise.
    let optionsPromise = null;

    // The query URL for one set of form values, with the range taken as an
    // argument so the preview can ask for a wider area than the query will keep
    // (see previewRemote).
    function buildQueryUrl(values, rangeKm) {
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
      if (Number.isFinite(rangeKm)) {
        url.searchParams.set("range", String(rangeKm));
      }
      return url;
    }

    const previewCache = new Map();

    // Turn a fetched body into what the caption needs. The map's numbers have
    // to agree with the button underneath it, and two things pull them apart:
    // a repeater the directory publishes without coordinates, which the query
    // inserts and the map cannot place, and one the selected radio cannot
    // express, which the map can place and the query drops. Both are counted
    // here so the caption can name them instead of quietly promising the wrong
    // total.
    //
    // Only the in-range repeaters go to the row builder -- the widened body
    // reaches half again the radius, and the query will never see that ground.
    // Building rows allocates but inserts nothing; insertRowsAtSelectionOrEnd
    // is the step that touches the grid, and it is not called here.
    function summarizeRemote(body, position, radiusKm) {
      // Each plotted entry carries the repeater it came from, because the point
      // list is not index-aligned with the repeater list -- the unmapped ones
      // have no point at all.
      const points = markInRange(body.plotted.map((entry) => entry.point), position, radiusKm);
      const importable = body.plotted
        .filter((entry, index) => points[index].inRange)
        .map((entry) => entry.repeater)
        .concat(body.unmapped);
      const { skipped } = buildPrzemiennikiRows(importable, ctx.table.rowBuilderHooks(), {
        perspective: body.perspective,
      });
      return { points, unmapped: body.unmapped.length, unsupported: skipped.length };
    }

    // These directories filter by distance upstream, so a preview asking for
    // exactly the chosen radius could only ever draw stations inside the ring —
    // and the one thing the form cannot tell you is whether a slightly wider
    // search would find anything. So the preview asks for half again the
    // radius and dims what falls outside it. The extra ground costs one larger
    // body on the same single request, not a second one.
    const PREVIEW_RANGE_FACTOR = 1.5;

    // What the current filters would return, as positions only. Never throws
    // at the caller as a query failure would: a preview that cannot be drawn is
    // a map without squares on it, not a reason to stop the user filling in the
    // form. The shell reports the reason in the debug panel.
    async function previewRemote(values) {
      const radiusKm = Number(values.radius);
      if (!values.position || !Number.isFinite(radiusKm) || radiusKm <= 0) {
        return null;
      }
      const url = buildQueryUrl(values, radiusKm * PREVIEW_RANGE_FACTOR);
      // Keyed on the request without its range. The body already covers half
      // again the radius that fetched it, so every smaller radius is contained
      // in one already in hand and needs only re-flagging, which markInRange
      // does without a request -- and nudging the range is the commonest edit
      // in this form, so keying on the URL whole made the cache miss precisely
      // where it was meant to help. The covered range is recorded alongside, and
      // the test is against the widened area rather than the radius: a body
      // fetched for 20 km reaches 30, and reusing it for a 30 km search would
      // leave nothing beyond the ring to dim -- the map would report nothing
      // just outside while the ground it never fetched was full of repeaters.
      // Every body covers 1.5x the radius that fetched it, so this reduces to
      // "any radius up to the one it was fetched for".
      const key = keyWithoutRange(url);
      const cached = previewCache.get(key);
      if (cached && cached.rangeKm >= radiusKm * PREVIEW_RANGE_FACTOR) {
        return summarizeRemote(cached, values.position, radiusKm);
      }
      const text = await withRequestTimeout(`${label} preview`, async (signal) => {
        const response = await fetch(url.toString(), { signal });
        if (!response.ok) {
          throw new Error(`${actionLabel} preview failed: HTTP ${response.status}`);
        }
        return response.text();
      });
      const parsed = parsePrzemiennikiXml(text);
      const plotted = [];
      const unmapped = [];
      for (const repeater of parsed.repeaters) {
        const point = previewPoint(repeater.latitude, repeater.longitude);
        if (point) {
          plotted.push({ point, repeater });
        } else {
          // The query inserts this one; only the map cannot place it. Counted
          // rather than dropped, or the caption would undercount what pressing
          // Query API is about to do.
          unmapped.push(repeater);
        }
      }
      // The radius this body actually covers, not the one asked for: a later,
      // narrower search may reuse it, a wider one may not.
      const body = {
        perspective: parsed.perspective,
        plotted,
        unmapped,
        rangeKm: radiusKm * PREVIEW_RANGE_FACTOR,
      };
      rememberBounded(previewCache, key, body, PREVIEW_CACHE_LIMIT);
      return summarizeRemote(body, values.position, radiusKm);
    }

    return {
      key,
      toolbarButton,
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
        // Above the coordinates because it is how most people know where they
        // are: picking a place fills latitude, longitude and the locator and
        // recentres the preview, so the three inputs below read as the result
        // of this one rather than as something to fill in by hand.
        { kind: "city", key: "city", label: "City/Locality", placeholder: "e.g. Warszawa" },
        { kind: "position", locatorPlaceholder: "e.g. JO91GG" },
        { kind: "number", key: "radius", label: "Range (km)", min: 1, step: 1, value: 30 },
      ],
      loadOptions: () => {
        if (!optionsPromise) {
          optionsPromise = (async () => {
            // The whole exchange runs under one deadline, body read included:
            // this fetch is what the modal blocks on while it opens, so a
            // stalled proxy would otherwise leave the toolbar click doing nothing
            // visible for minutes.
            const text = await withRequestTimeout(`${label} dictionary request`, async (signal) => {
              const response = await fetch(metaUrl, { signal });
              if (!response.ok) {
                throw new Error(`Dictionary request failed: HTTP ${response.status}`);
              }
              return response.text();
            });
            const parsed = parsePrzemiennikiMetaJson(text);
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
      previewQuery: (values) => previewRemote(values),
      runQuery: async (values) => {
        const country = String(values.country || "").trim().toLowerCase();
        const url = buildQueryUrl(values, values.radius);
        log.setStatus(`Querying ${label}...`);
        // Both the request and the body read sit inside the deadline: the
        // error-path read of a failed response can stall exactly as the success
        // path can, and either one strands the submit button on "Querying...".
        const text = await withRequestTimeout(`${label} query`, async (signal) => {
          const response = await fetch(url.toString(), { signal });
          if (!response.ok) {
            const body = await response.text();
            throw new Error(`${actionLabel} query failed: HTTP ${response.status}\n${body.slice(0, 800)}`);
          }
          return response.text();
        });
        const parsed = parsePrzemiennikiXml(text);
        const { rows, skipped } = buildPrzemiennikiRows(
          parsed.repeaters,
          ctx.table.rowBuilderHooks(),
          { perspective: parsed.perspective },
        );
        for (const entry of skipped) {
          log.logDebug(`${actionLabel.toUpperCase()} SKIPPED ${entry.repeater} (${skippedReason(entry)})`);
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
    // Records keyed by locator square. RSGB is the expensive source by a wide
    // margin -- one request and some 75 kB per square, and a radius spans
    // several -- so this is what makes the preview affordable at all: nudging
    // the radius or dragging the map within the squares already fetched costs
    // nothing, and only stepping into a new square costs a request.
    const squareCache = new Map();

    // Fetch only the squares not already held, then answer from the union.
    //
    // The cached squares are read out *before* the fetch is awaited. A second
    // call can run during that await -- the submitted query starting while a
    // superseded preview is still downloading -- and its eviction must not be
    // able to empty a square this call has already classified as cached. With
    // the records in hand up front, nothing that happens to the cache
    // afterwards can change this plan's answer, so eviction needs no notion
    // of in-flight plans.
    //
    // `onSquare` is called once per square of the plan, whether it was fetched
    // now or served from the cache, and says which, so the debug panel keeps a
    // line per square however little of the plan cost a request this time.
    async function recordsForSquares(squares, { onSquare } = {}) {
      const held = new Map();
      const missing = [];
      for (const locator of squares) {
        if (squareCache.has(locator)) {
          held.set(locator, squareCache.get(locator));
        } else {
          missing.push(locator);
        }
      }
      if (missing.length > 0) {
        const fetched = await fetchRsgbRecords({ squares: missing });
        // fetchRsgbRecords returns one flat list, so the records are put back
        // under the square they came from. A square that legitimately holds no
        // repeaters caches as an empty list, which is what stops it being
        // re-requested on every redraw. A record whose locator names a square
        // outside the request is filed under the first square asked for rather
        // than dropped on an assumption about the API nothing here verifies;
        // it is outside the radius either way, so the distance filter drops it.
        const buckets = new Map(missing.map((locator) => [locator, []]));
        for (const record of fetched) {
          const locator = String(record?.locator || "").slice(0, 4).toUpperCase();
          buckets.get(buckets.has(locator) ? locator : missing[0]).push(record);
        }
        for (const [locator, records] of buckets) {
          held.set(locator, records);
          rememberBounded(squareCache, locator, records, PREVIEW_CACHE_LIMIT);
        }
      }
      if (typeof onSquare === "function") {
        for (const locator of squares) {
          onSquare({
            locator,
            count: held.get(locator).length,
            cached: !missing.includes(locator),
          });
        }
      }
      return squares.flatMap((locator) => held.get(locator));
    }

    // RSGB filters client-side, so the preview is the real filter run over the
    // squares in reach -- no widened request needed. Everything the fan-out
    // covers is offered to the map, with the ones the radius excludes dimmed.
    async function previewRsgb(values) {
      const position = values.position;
      const radiusKm = Number(values.radius);
      if (!position || !Number.isFinite(radiusKm) || radiusKm <= 0) {
        return null;
      }
      const plan = squaresForRadius(position.latitude, position.longitude, radiusKm);
      if (plan.squares.length === 0) {
        return { points: [] };
      }
      const deduped = dedupeRsgbRecords(await recordsForSquares(plan.squares));
      const modes = values.modes.length > 0 ? values.modes : ["A"];
      // No radius: the distance filter is what the ring already draws, and
      // applying it here would throw away the out-of-range stations that are
      // the most useful thing on the map.
      const entries = filterRsgbRecords(deduped, {
        latitude: position.latitude,
        longitude: position.longitude,
        bands: values.bands,
        modes,
        onlyOperational: values.only,
      });
      const points = entries
        .map((entry) => previewPoint(entry.latitude, entry.longitude, {
          inRange: entry.distanceKm <= radiusKm,
          // A 4-character locator is a box some 111 km across, so the position
          // drawn is the middle of a guess. The map says so rather than
          // presenting it as surveyed.
          approximate: entry.approximate,
        }))
        .filter(Boolean);
      // What the radio cannot express, over the in-range entries only -- the
      // ones beyond the ring are context for widening the search, not results
      // the query would insert. Every RSGB position comes from a locator, so
      // there is nothing unmapped here.
      const { skipped } = buildRsgbRows(
        entries.filter((entry) => entry.distanceKm <= radiusKm),
        ctx.table.rowBuilderHooks(),
        { modes },
      );
      return { points, truncated: plan.truncated, unmapped: 0, unsupported: skipped.length };
    }

    return {
      key: "rsgb",
      toolbarButton: "channelImportRsgbEl",
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
        // Above the coordinates because it is how most people know where they
        // are: picking a place fills latitude, longitude and the locator and
        // recentres the preview, so the three inputs below read as the result
        // of this one rather than as something to fill in by hand.
        { kind: "city", key: "city", label: "City/Locality", placeholder: "e.g. Manchester" },
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
      previewQuery: (values) => previewRsgb(values),
      runQuery: async (values) => {
        const position = values.position;
        if (!position) {
          throw new RepeaterInputError("Set a location first: use the 🛰️ button or type a latitude and longitude.");
        }
        const radiusKm = values.radius;
        if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
          throw new RepeaterInputError("Distance must be a positive number of kilometres.");
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

        // Through the same cache the preview fills. The normal workflow is to
        // pause long enough to see the preview and then press Query API, so
        // fetching directly here downloaded every square a second time -- up to
        // 24 more responses of roughly 75 kB, for records already in hand.
        const records = await recordsForSquares(plan.squares, {
          onSquare: ({ locator, count, cached }) => log.logDebug(
            `RSGB SQUARE ${locator} -> ${count}${cached ? " (cached)" : ""}`,
          ),
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
          log.logDebug(`RSGB SKIPPED ${entry.repeater} (${skippedReason(entry)})`);
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
      toolbarButton: "channelImportPrzemiennikiEl",
      sourceEndpoints: endpoints?.przemienniki,
    }),
    remoteDirectorySource({
      key: "repeaterbook",
      label: "repeaterbook.com",
      actionLabel: "RepeaterBook",
      insertLabel: "repeaterbook",
      toolbarButton: "channelImportRepeaterbookEl",
      sourceEndpoints: endpoints?.repeaterbook,
    }),
    remoteDirectorySource({
      key: "irts",
      label: "IRTS",
      actionLabel: "IRTS",
      insertLabel: "IRTS",
      toolbarButton: "channelImportIrtsEl",
      sourceEndpoints: endpoints?.irts,
    }),
    rsgbSource(),
  ];
}

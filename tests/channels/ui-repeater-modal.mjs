import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPEATER_REQUEST_TIMEOUT_MS } from "../../web/js/request-timeout.js";
import { createRepeaterQuery } from "../../web/js/ui/repeater-query.js";
import { FakeElement, installFakeDom } from "../support/fake-dom.mjs";
import { fakeXmlGlobals } from "../support/fake-xml.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

// The unified query modal is driven directly rather than through
// createUiController, so each test can assert on exactly what it hands its
// siblings — which URLs it fetched, which rows it inserted, what it logged.
// Every field element is built by query-fields.js via document.createElement,
// so the shared fake DOM needs no static markup: a real classList (the
// modal's open/closed state lives there), a querySelectorAll that understands
// `input[name="x"]:checked` and throws on any shape it cannot match, and
// attribute get/set for the aria-label.

function descendants(root) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

const DOM_KEYS = [
  "channelImportPrzemiennikiEl", "channelImportRepeaterbookEl", "channelImportIrtsEl", "channelImportRsgbEl",
  "repeaterQueryModalEl", "repeaterQueryFormEl", "repeaterQueryTitleEl",
  "repeaterQueryGridEl", "repeaterQueryCancelEl", "repeaterQuerySubmitEl",
];

const META_JSON = JSON.stringify({
  filters: {
    country: ["PL", "DE"],
    band: ["2m", "70cm"],
    mode: ["fm", "dstar"],
  },
});

const IRTS_META_JSON = JSON.stringify({
  filters: {
    country: ["ie", "gb"],
    band: ["10m", "2m", "4m", "70cm"],
    mode: ["dmr", "dstar", "fm", "fusion", "nxdn"],
  },
});

function installFetch(routes) {
  const calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      const text = String(url);
      calls.push({ url: text, init });
      for (const route of routes) {
        if (text.includes(route.match)) {
          return {
            ok: route.ok !== false,
            status: route.status ?? (route.ok !== false ? 200 : 500),
            text: async () => route.body ?? "",
          };
        }
      }
      throw new Error(`Unrouted fetch: ${text}`);
    },
  });
  return calls;
}

// installFetch()'s sibling for the stall case. A route marked `stall` accepts
// the request and then never answers, which is what a proxy that hangs after
// the connection looks like from the browser; the promise settles only when the
// request deadline aborts the signal, rejecting the way a real fetch does.
// Routes are matched in order, so a stalling catch-all can follow the routes
// that answer.
//
// Not to be confused with installGatedRsgbFetch() below: that one holds a
// request open until the *test* releases it, so a query can be caught mid-
// flight; this one is never released at all, so only the deadline can end it.
function installStalledFetch(routes) {
  const calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (url, init) => {
      const text = String(url);
      calls.push({ url: text, init });
      const route = routes.find((entry) => text.includes(entry.match));
      if (!route) {
        return Promise.reject(new Error(`Unrouted fetch: ${text}`));
      }
      if (!route.stall) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => route.body ?? "",
          json: async () => JSON.parse(route.body ?? "null"),
        });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // A real fetch rejects with an AbortError DOMException carrying the
          // platform's own wording — the sentence the deadline replaces.
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
      });
    },
  });
  return calls;
}

// Let every pending microtask run so the in-flight fetch has actually been
// issued before the mocked clock is advanced past the deadline. setImmediate is
// left unmocked by t.mock.timers.enable({ apis: ["setTimeout"] }), so it still
// yields to the real event loop.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildHarness({
  repeaterApiBase = "https://proxy.example.com",
  headers = ["Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Power", "Comment"],
  // What the stand-in radio's Mode column advertises. The default set has DV,
  // so D-STAR repeaters are buildable; pass ["FM", "NFM"] for an FM-only radio.
  modeOptions = ["FM", "NFM", "DV"],
  // The driver's CTCSS table. null means "accepts any tone", which is what
  // every test that is not about tones wants; a list stands in for a radio
  // whose table is missing the directory's tone.
  toneOptions = null,
} = {}) {
  // parsePrzemiennikiXml reaches for DOMParser, so it is installed with the
  // rest of the fake DOM globals.
  const { document } = installFakeDom({ globals: fakeXmlGlobals() });
  // The meta tag is registered only when a base is provided; an unregistered
  // non-id selector resolves to null, as an absent tag would.
  if (repeaterApiBase !== undefined) {
    const meta = new FakeElement("meta", document);
    meta.setAttribute("content", String(repeaterApiBase ?? ""));
    document.register('meta[name="webchirp-repeater-api-base"]', meta);
  }

  const dom = Object.fromEntries(DOM_KEYS.map((key) => [key, new FakeElement("div")]));
  // The modal starts closed, exactly as index.html ships it.
  dom.repeaterQueryModalEl.classList.add("hidden");

  const log = { statuses: [], debug: [], errors: [], cancelled: [] };
  const table = { inserted: [] };

  const ctx = {
    dom,
    state: { currentHeaders: headers },
    log: {
      setStatus: (message) => log.statuses.push(String(message)),
      logDebug: (message) => log.debug.push(String(message)),
      reportActionError: (label, error) => log.errors.push(`${label}: ${error?.message || error}`),
      reportActionCancelled: (label, message) => log.cancelled.push(`${label}: ${message}`),
    },
    table: {
      insertRowsAtSelectionOrEnd: (rows, label) => table.inserted.push({ rows, label }),
      rowBuilderHooks: () => ({
        createBlankRow: () => Object.fromEntries(headers.map((column) => [column, ""])),
        // Returns whether the write took, as channel-table.js's does.
        setRowValue: (row, column, value) => {
          if (!headers.includes(column)) {
            return false;
          }
          // Stands in for a 2m/70cm radio: the grid refuses a frequency the
          // driver cannot tune and leaves the previous value in place.
          if (column === "Frequency" && Number.parseFloat(value) > 470) {
            return false;
          }
          // A tone outside the driver's table is refused the way the grid
          // refuses it: the first option is left in the cell, so only the
          // return value says the write did not take.
          if (toneOptions && (column === "rToneFreq" || column === "cToneFreq")
              && !toneOptions.includes(String(value))) {
            row[column] = String(toneOptions[0]);
            return false;
          }
          row[column] = String(value ?? "");
          return true;
        },
        // Choice order decides, as channel-table.js's findEnumOption does, and
        // a radio that advertises none of the choices answers with "".
        findEnumOption: (column, choices) => {
          // Low first, as roughly half of CHIRP's drivers order them.
          const options = column === "Mode" ? modeOptions : column === "Power" ? ["Low", "High"] : null;
          if (options === null) {
            return choices[0] || "";
          }
          for (const choice of choices) {
            const match = options.find((option) => option.toLowerCase() === String(choice).toLowerCase());
            if (match) {
              return match;
            }
          }
          return "";
        },
      }),
    },
  };

  const query = createRepeaterQuery(ctx);
  query.bindEvents();
  return { query, dom, log, table, ctx };
}

function installGeolocation(result) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      geolocation: result === null ? undefined : {
        getCurrentPosition(resolve, reject) {
          if (result instanceof Error || result instanceof PositionError) {
            reject(result);
          } else {
            resolve(result);
          }
        },
      },
    },
  });
}

// Stand-in for the browser's GeolocationPositionError: a platform object that
// is not an Error instance, carries only a numeric `code`, and stringifies to
// "[object GeolocationPositionError]". The real thing is not constructible by
// page script, so the tests build the shape the browser rejects with.
class PositionError {
  constructor(code) {
    this.code = code;
  }
}

function grid(dom) {
  return dom.repeaterQueryGridEl;
}

function fieldByName(dom, name) {
  const match = descendants(grid(dom)).find((el) => el.name === name && el.tagName !== "OPTION");
  assert.ok(match, `field named "${name}" is in the grid`);
  return match;
}

function countrySelect(dom) {
  const select = descendants(grid(dom)).find((el) => el.tagName === "SELECT");
  assert.ok(select, "country select is in the grid");
  return select;
}

function geolocateButton(dom) {
  const button = descendants(grid(dom)).find((el) => el.textContent === "🛰️");
  assert.ok(button, "geolocate button is in the grid");
  return button;
}

function clearLocationButton(dom) {
  const button = descendants(grid(dom)).find((el) => el.textContent === "🗑️");
  assert.ok(button, "clear-location button is in the grid");
  return button;
}

function previewCanvas(dom) {
  const canvas = descendants(grid(dom)).find((el) => el.className === "repeater-map-canvas");
  assert.ok(canvas, "the coordinate preview canvas is in the grid");
  return canvas;
}

function previewTiles(dom) {
  return previewCanvas(dom).children.filter((child) => child.className === "repeater-map-tile");
}

function queryUrl(calls) {
  const call = calls.find((entry) => !entry.url.includes("/meta"));
  assert.ok(call, "a query request was made");
  return new URL(call.url);
}

test("opening przemienniki builds the form from the dictionary, once", async () => {
  const { dom, log } = buildHarness();
  const calls = installFetch([{ match: "/przemienniki/meta", body: META_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");

  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query przemienniki.net");
  assert.deepEqual(calls.map((call) => call.url), ["https://proxy.example.com/przemienniki/meta"]);

  const select = countrySelect(dom);
  assert.equal(select.children[0].value, "");
  assert.equal(select.children[0].textContent, "Any country");
  // Sorted by display name (Germany before Poland) and carrying the flag.
  assert.deepEqual(select.children.slice(1).map((option) => option.value), ["DE", "PL"]);
  assert.ok(select.children.slice(1).every((option) => option.textContent.includes(" ")));

  const bands = grid(dom).querySelectorAll('input[name="band"]');
  assert.deepEqual(bands.map((el) => el.value), ["2m", "70cm"]);
  // 2m + 70cm on FM start ticked, the same defaults as RSGB.
  assert.deepEqual(bands.map((el) => el.checked), [true, true]);
  const modes = grid(dom).querySelectorAll('input[name="mode"]');
  assert.deepEqual(modes.map((el) => `${el.value}${el.checked ? "*" : ""}`), ["dstar", "fm*"]);
  assert.equal(fieldByName(dom, "only").checked, true);
  assert.equal(fieldByName(dom, "radius").value, "30");

  assert.ok(log.statuses.includes("Loading przemienniki.net query options..."));
  assert.ok(log.statuses.includes("Configure przemienniki.net query."));

  // A second open reuses the cached dictionary.
  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(calls.length, 1);
});

test("przemienniki digital modes are shown disabled, matching RSGB", async () => {
  const { dom } = buildHarness();
  installFetch([{
    match: "/przemienniki/meta",
    // The live /meta vocabulary as of 2026-09-14: fm and dstar plus the six
    // digital modes a channel row cannot express usefully.
    body: JSON.stringify({
      filters: {
        country: ["PL"],
        band: ["2m", "70cm"],
        mode: ["apco25", "atv", "c4fm", "dstar", "fm", "m17", "mototrbo", "tetra"],
      },
    }),
  }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");

  const [, modeBox] = descendants(grid(dom)).filter((el) => el.className === "modal-modes");
  const modeInputs = grid(dom).querySelectorAll('input[name="mode"]');
  // Dictionary order is label-sorted, so the digital names sit among fm/dstar
  // rather than after them the way RSGB appends its unsupported flags.
  assert.deepEqual(
    modeInputs.map((el) => el.value),
    ["apco25", "atv", "c4fm", "dstar", "fm", "m17", "mototrbo", "tetra"],
  );
  assert.deepEqual(
    modeInputs.filter((el) => el.disabled).map((el) => el.value),
    ["apco25", "atv", "c4fm", "m17", "mototrbo", "tetra"],
  );
  assert.deepEqual(
    modeInputs.filter((el) => el.checked).map((el) => el.value),
    ["fm"],
  );
  assert.deepEqual(
    modeBox.children
      .filter((option) => option.title === "Only analogue modes and dstar are supported fully")
      .map((option) => option.children[1].textContent),
    ["apco25", "atv", "c4fm", "m17", "mototrbo", "tetra"],
  );
});

test("a failed dictionary fetch reports the error and retries on the next open", async () => {
  const { dom, log } = buildHarness();
  let failFirst = true;
  const calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url) => {
      calls.push(String(url));
      const failing = failFirst;
      failFirst = false;
      return { ok: !failing, status: failing ? 502 : 200, text: async () => META_JSON };
    },
  });

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /^Przemienniki modal: Dictionary request failed: HTTP 502/);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
  assert.equal(calls.length, 2);
});

test("submitting sends the selected filters as URL parameters", async () => {
  const { dom, table } = buildHarness();
  const calls = installFetch([
    { match: "/przemienniki/meta", body: META_JSON },
    { match: "/przemienniki", body: "<rxf><perspective>repeater</perspective></rxf>" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  countrySelect(dom).value = "PL";
  // Start from a clean slate so the URL reflects exactly this test's picks,
  // not the 2m/70cm/fm defaults.
  for (const el of grid(dom).querySelectorAll('input[name="band"]')) {
    el.checked = false;
  }
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = false;
  }
  const band = grid(dom).querySelectorAll('input[name="band"]')[0];
  band.checked = true;
  // Mode options come back label-sorted from the dictionary: dstar, fm.
  // Tick both: the union must go as one comma-joined value, not repeated
  // mode= keys of which the API would keep only the last.
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = true;
  }
  const latitude = fieldByName(dom, "latitude");
  latitude.value = "52.2297";
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = "21.0122";
  await longitude.dispatch("input");

  await dom.repeaterQueryFormEl.dispatch("submit");

  const url = queryUrl(calls);
  assert.equal(url.pathname, "/przemienniki");
  assert.equal(url.searchParams.get("country"), "pl");
  assert.equal(url.searchParams.get("band"), "2m");
  assert.equal(url.searchParams.get("mode"), "dstar,fm");
  assert.equal(url.searchParams.get("onlyworking"), "true");
  assert.equal(url.searchParams.get("latitude"), "52.2297");
  assert.equal(url.searchParams.get("longitude"), "21.0122");
  assert.equal(url.searchParams.get("range"), "30");

  assert.equal(table.inserted.length, 1);
  assert.equal(table.inserted[0].label, "przemienniki");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
});

test("blank optional filters are omitted from the query", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/repeaterbook/meta", body: META_JSON },
    { match: "/repeaterbook", body: "<rxf><perspective>repeater</perspective></rxf>" },
  ]);

  await dom.channelImportRepeaterbookEl.dispatch("click");
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query repeaterbook.com");
  fieldByName(dom, "only").checked = false;
  // Untick the default band selection to make every optional filter blank.
  // The modes stay on their fm default: an empty mode selection is not blank,
  // it falls back (see the fallback test below).
  for (const el of grid(dom).querySelectorAll('input[name="band"]')) {
    el.checked = false;
  }

  await dom.repeaterQueryFormEl.dispatch("submit");

  const url = queryUrl(calls);
  for (const param of ["country", "band", "onlyworking", "latitude", "longitude"]) {
    assert.equal(url.searchParams.get(param), null, `no ${param} parameter`);
  }
  assert.equal(url.searchParams.get("range"), "30");
});

test("an RXF query with no mode selected falls back to analogue only", async () => {
  // The form presents every digital mode as unavailable, so an empty mode
  // selection must not omit the parameter and let the directory return them
  // all — even on a radio that advertises DMR, a digital row must stay out.
  const { dom } = buildHarness({ modeOptions: ["FM", "NFM", "DV", "DMR"] });
  const calls = installFetch([
    { match: "/przemienniki/meta", body: META_JSON },
    { match: "/przemienniki", body: "<rxf><perspective>repeater</perspective></rxf>" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = false;
  }
  await dom.repeaterQueryFormEl.dispatch("submit");

  const url = queryUrl(calls);
  assert.deepEqual(url.searchParams.getAll("mode"), ["fm"]);
});

test("IRTS loads its dictionary and submits through the shared RXF flow", async () => {
  const { dom, table } = buildHarness();
  const calls = installFetch([
    { match: "/irts/meta", body: IRTS_META_JSON },
    {
      match: "/irts",
      body: `
        <rxf><perspective>radio</perspective><repeaters><repeater>
          <qra>EI2TRR</qra><mode>fm</mode>
          <qrg type="rx">145.6</qrg><qrg type="tx">145</qrg>
          <qth>Three Rock, Co. Dublin</qth><remarks>Channel: RV48 / (R0)</remarks>
          <link>https://www.irts.ie/cgi/repeater.cgi</link><ctcss type="tx">88.5</ctcss>
          <location><latitude>53.229167</latitude><longitude>-6.208333</longitude></location>
        </repeater></repeaters></rxf>
      `,
    },
  ]);

  await dom.channelImportIrtsEl.dispatch("click");

  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query IRTS");
  assert.deepEqual(countrySelect(dom).children.slice(1).map((option) => option.value), ["IE", "GB"]);
  assert.deepEqual(grid(dom).querySelectorAll('input[name="band"]').map((el) => el.value), ["10m", "2m", "4m", "70cm"]);
  const irtsModes = grid(dom).querySelectorAll('input[name="mode"]');
  assert.deepEqual(
    irtsModes.map((el) => el.value),
    ["dmr", "dstar", "fm", "fusion", "nxdn"],
  );
  assert.deepEqual(
    irtsModes.filter((el) => el.disabled).map((el) => el.value),
    ["dmr", "fusion", "nxdn"],
  );

  countrySelect(dom).value = "IE";
  await dom.repeaterQueryFormEl.dispatch("submit");

  const url = queryUrl(calls);
  assert.equal(url.pathname, "/irts");
  assert.equal(url.searchParams.get("country"), "ie");
  assert.equal(url.searchParams.get("band"), "2m,70cm");
  assert.deepEqual(url.searchParams.getAll("mode"), ["fm"]);
  assert.equal(table.inserted[0].label, "IRTS");
  assert.equal(table.inserted[0].rows.length, 1);
  assert.equal(table.inserted[0].rows[0].Frequency, "145.600000");
  assert.equal(table.inserted[0].rows[0].Duplex, "-");
  assert.equal(table.inserted[0].rows[0].Offset, "0.600000");
  assert.equal(table.inserted[0].rows[0].rToneFreq, "88.5");
});

test("IRTS rejects an RXF response without a frequency perspective", async () => {
  const { dom, log, table } = buildHarness();
  installFetch([
    { match: "/irts/meta", body: IRTS_META_JSON },
    { match: "/irts", body: "<rxf><repeaters></repeaters></rxf>" },
  ]);

  await dom.channelImportIrtsEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.equal(table.inserted.length, 0);
  assert.match(log.errors.join("\n"), /^IRTS query: RXF response is missing its frequency perspective\./);
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
});

test("IRTS skips and reports a digital mode the selected radio cannot use", async () => {
  const { dom, log, table } = buildHarness({ modeOptions: ["FM", "DIG"] });
  installFetch([
    { match: "/irts/meta", body: IRTS_META_JSON },
    {
      match: "/irts",
      body: `
        <rxf><perspective>radio</perspective><repeaters><repeater>
          <qra>EI7DMR</qra><mode>dmr</mode><country>ie</country>
          <qrg type="rx">439.5</qrg><qrg type="tx">430.5</qrg>
        </repeater></repeaters></rxf>
      `,
    },
  ]);

  await dom.channelImportIrtsEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.equal(table.inserted.length, 1);
  assert.deepEqual(table.inserted[0].rows, []);
  assert.match(log.debug.join("\n"), /IRTS SKIPPED EI7DMR \(DMR not supported by the selected radio\)/);
  assert.ok(log.statuses.includes("Inserted 0 channel(s); skipped 1 in a mode it cannot use."));
});

test("IRTS skips a repeater the selected radio cannot tune", async () => {
  const { dom, log, table } = buildHarness();
  installFetch([
    { match: "/irts/meta", body: IRTS_META_JSON },
    {
      match: "/irts",
      body: `
        <rxf><perspective>radio</perspective><repeaters>
          <repeater>
            <qra>EI2TRR</qra><mode>fm</mode><country>ie</country>
            <qrg type="rx">145.6</qrg><qrg type="tx">145</qrg>
          </repeater>
          <repeater>
            <qra>EI23CM</qra><mode>fm</mode><country>ie</country>
            <qrg type="rx">1298.5</qrg><qrg type="tx">1290.9</qrg>
          </repeater>
        </repeaters></rxf>
      `,
    },
  ]);

  await dom.channelImportIrtsEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  // The 23cm repeater is above the harness radio's 470 MHz ceiling. Before the
  // frequency guard it arrived as a row with a blank Frequency and a -7.6 MHz
  // Offset, which erases the memory it lands on when uploaded.
  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["EI2TRR"]);
  assert.ok(table.inserted[0].rows.every((row) => Number.parseFloat(row.Frequency) > 0));
  assert.ok(log.debug.some((line) => /IRTS SKIPPED EI23CM \(frequency not supported/.test(line)));
  assert.ok(
    log.statuses.includes("Inserted 1 channel(s); skipped 1 outside its frequency range."),
    `status lines were: ${log.statuses.join(" | ")}`,
  );
});

test("an RXF entry missing one qrg imports as simplex, not as a bogus split", async () => {
  const { dom, table } = buildHarness();
  installFetch([
    { match: "/irts/meta", body: IRTS_META_JSON },
    {
      match: "/irts",
      body: `
        <rxf><perspective>radio</perspective><repeaters><repeater>
          <qra>EI2ONE</qra><mode>fm</mode><country>ie</country>
          <qrg type="tx">145.6</qrg>
        </repeater></repeaters></rxf>
      `,
    },
  ]);

  await dom.channelImportIrtsEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  // An absent <qrg> used to parse as Number("") === 0, a finite value that
  // satisfied every downstream isFinite guard: this row arrived as a 0 MHz
  // receive frequency and was dropped as out of band. It now parses as NaN and
  // falls back to the one frequency the entry does carry.
  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["EI2ONE"]);
  assert.equal(table.inserted[0].rows[0].Frequency, "145.600000");
  assert.equal(table.inserted[0].rows[0].Duplex, "");
  assert.equal(table.inserted[0].rows[0].Offset, "0.000000");
});

test("a failed query reports the error and leaves the modal open", async () => {
  const { dom, log, table } = buildHarness();
  installFetch([
    { match: "/przemienniki/meta", body: META_JSON },
    { match: "/przemienniki", ok: false, status: 503, body: "proxy down" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /^Przemienniki query: Przemienniki query failed: HTTP 503/);
  assert.equal(table.inserted.length, 0);
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
});

test("filters reset to source defaults on reopen while the position persists", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  countrySelect(dom).value = "PL";
  // Invert the default selection: bands off, dstar on instead of fm.
  for (const el of grid(dom).querySelectorAll('input[name="band"]')) {
    el.checked = false;
  }
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = el.value === "dstar";
  }
  fieldByName(dom, "only").checked = false;
  fieldByName(dom, "radius").value = "120";
  const latitude = fieldByName(dom, "latitude");
  latitude.value = "52.2297";
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = "21.0122";
  await longitude.dispatch("input");

  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");

  assert.equal(countrySelect(dom).value, "");
  assert.deepEqual(
    grid(dom).querySelectorAll('input[name="band"]:checked').map((el) => el.value),
    ["2m", "70cm"],
  );
  assert.deepEqual(
    grid(dom).querySelectorAll('input[name="mode"]:checked').map((el) => el.value),
    ["fm"],
  );
  assert.equal(fieldByName(dom, "only").checked, true);
  assert.equal(fieldByName(dom, "radius").value, "30");
  assert.equal(fieldByName(dom, "latitude").value, "52.2297");
  assert.equal(fieldByName(dom, "longitude").value, "21.0122");
  assert.equal(fieldByName(dom, "locator").value, "KO02MF");
});

test("the position carries over when switching sources", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  const latitude = fieldByName(dom, "latitude");
  latitude.value = "51.5";
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = "-0.12";
  await longitude.dispatch("input");
  await dom.repeaterQueryCancelEl.dispatch("click");

  await dom.channelImportRepeaterbookEl.dispatch("click");
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query repeaterbook.com");
  assert.equal(fieldByName(dom, "latitude").value, "51.5");
  assert.equal(fieldByName(dom, "longitude").value, "-0.12");
});

test("opening the modal draws the coordinate preview for the persisted position", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);

  // A first open with nothing entered has nothing to draw.
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(previewCanvas(dom).hidden, true);
  assert.equal(previewTiles(dom).length, 0);

  const latitude = fieldByName(dom, "latitude");
  latitude.value = "52.2297";
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = "21.0122";
  await longitude.dispatch("input");
  await dom.repeaterQueryCancelEl.dispatch("click");

  // Reopening rebuilds the field around the persisted position, and the shell
  // refreshes the preview once the overlay is visible — without waiting for
  // the typing debounce, which is what a rebuilt field would otherwise need.
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(previewCanvas(dom).hidden, false);
  assert.ok(previewTiles(dom).length >= 1);
});

test("the preview draws the range filter's circle and follows edits to it", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  const latitude = fieldByName(dom, "latitude");
  latitude.value = "52";
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = "-2";
  await longitude.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 400));

  // The source's default range (30 km) is already applied when the form is
  // built, without the user touching the field.
  const ring = () => previewCanvas(dom).children.find((el) => el.className === "repeater-map-range");
  assert.ok(ring(), "the default range is drawn on the preview");
  const zoomOf = () => Number(previewCanvas(dom).children[0].src.split("/")[3]);
  const defaultZoom = zoomOf();

  const range = fieldByName(dom, "radius");
  range.value = "300";
  await range.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(ring(), "the widened range is still drawn");
  assert.ok(zoomOf() < defaultZoom, "a wider range zooms the preview out");
});

test("clearing the location empties the persisted position too", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);
  installGeolocation({ coords: { latitude: 51.520833, longitude: -0.125 } });

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await geolocateButton(dom).dispatch("click");
  await clearLocationButton(dom).dispatch("click");
  assert.equal(fieldByName(dom, "latitude").value, "");
  assert.equal(fieldByName(dom, "longitude").value, "");
  assert.equal(fieldByName(dom, "locator").value, "");

  // The cleared position is what persists into the next open.
  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(fieldByName(dom, "latitude").value, "");
  assert.equal(fieldByName(dom, "locator").value, "");
});

test("geolocate fills the position fields and reports the locator", async () => {
  const { dom, log } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);
  installGeolocation({ coords: { latitude: 51.520833, longitude: -0.125 } });

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await geolocateButton(dom).dispatch("click");

  assert.equal(fieldByName(dom, "latitude").value, "51.520833");
  assert.equal(fieldByName(dom, "longitude").value, "-0.125000");
  assert.equal(fieldByName(dom, "locator").value, "IO91WM");
  assert.ok(log.statuses.includes("Location set to IO91WM."));
});

test("a denied geolocation prompt is reported like a cancellation, never filed as an error", async () => {
  const { dom, log } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);
  // The real Firefox 155 shape: a platform object with a numeric code and no
  // message, no stack -- stringifying it reads "[object
  // GeolocationPositionError]". Code 1 is the user denying the prompt.
  installGeolocation(new PositionError(1));

  await dom.channelImportRepeaterbookEl.dispatch("click");
  await geolocateButton(dom).dispatch("click");

  assert.equal(fieldByName(dom, "latitude").value, "", "refusing permission sets no position");
  assert.equal(log.errors.length, 0, "a permission refusal is the user's call, not a Sentry-worthy defect");
  assert.equal(log.cancelled.length, 1);
  assert.match(
    log.cancelled[0],
    /^RepeaterBook geolocation: Location permission was denied by the browser\.$/,
  );
});

test("a geolocation timeout maps to its code's sentence and stays a cancellation", async () => {
  const { dom, log } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);
  installGeolocation(new PositionError(3));

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await geolocateButton(dom).dispatch("click");

  assert.equal(log.errors.length, 0);
  assert.equal(log.cancelled.length, 1);
  assert.match(log.cancelled[0], /Przemienniki geolocation: Getting the location timed out\.$/);
});

test("an unexpected geolocation result keeps the error funnel", async () => {
  const { dom, log } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);
  // The browser resolved but with coordinates that make no sense: not a
  // refusal the user chose, so the traceback keeps its Sentry capture.
  installGeolocation({ coords: { latitude: "nonsense", longitude: 0 } });

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await geolocateButton(dom).dispatch("click");

  assert.equal(fieldByName(dom, "latitude").value, "");
  assert.equal(log.cancelled.length, 0, "only the refusal codes are cancellations");
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /Geolocation did not return valid coordinates/);
});

test("submitting without a channel schema fetches nothing", async () => {
  const { dom, log } = buildHarness({ headers: [] });
  const calls = installFetch([{ match: "/meta", body: META_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.ok(log.statuses.includes("No channel schema loaded yet."));
  assert.equal(calls.length, 1, "only the dictionary was fetched");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
});

test("backdrop clicks close the modal; clicks inside it do not", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await dom.repeaterQueryModalEl.dispatch("click", { target: dom.repeaterQueryFormEl });
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
  await dom.repeaterQueryModalEl.dispatch("click", { target: dom.repeaterQueryModalEl });
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
});

test("a blank API base hides proxy sources but leaves IRTS available", async () => {
  const { dom, log } = buildHarness({ repeaterApiBase: "" });
  const calls = installFetch([]);

  assert.equal(dom.channelImportPrzemiennikiEl.hidden, true);
  assert.equal(dom.channelImportRepeaterbookEl.hidden, true);
  assert.equal(dom.channelImportIrtsEl.hidden, false);
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
  assert.equal(calls.length, 0);

  // IRTS remains visible on the default hosted endpoint and reports a service
  // failure when used instead of disappearing with the proxy-backed sources.
  await dom.channelImportIrtsEl.dispatch("click");
  assert.deepEqual(calls.map((call) => call.url), ["https://api.codeplug.org/irts/meta"]);
  assert.match(log.errors.join("\n"), /^IRTS modal: Unrouted fetch:/);

  // RSGB needs no CORS proxy, so it stays available on such deployments.
  assert.equal(dom.channelImportRsgbEl.hidden, false);
  await dom.channelImportRsgbEl.dispatch("click");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
});

// --- RSGB/ETCC ---------------------------------------------------------------

// Two locator squares' worth of canned responses, keyed by the square in the
// URL. Anything not listed answers the way the real API answers a miss.
function installRsgbFetch(bySquare) {
  const calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      calls.push({ url: String(url), init });
      const square = String(url).split("/").pop();
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: bySquare[square] ?? null }),
      };
    },
  });
  return calls;
}

// Like installRsgbFetch, but every response waits on a gate the test opens.
// That holds a query in flight for as long as the test needs, which is what it
// takes to land a second submit on the first one — the double-click the
// in-flight guard exists to absorb.
function installGatedRsgbFetch(bySquare) {
  const calls = [];
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      calls.push({ url: String(url), init });
      await gate;
      const square = String(url).split("/").pop();
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: bySquare[square] ?? null }),
      };
    },
  });
  return { calls, release: () => openGate() };
}

// installGatedRsgbFetch() with an escape hatch: the RSGB square requests wait
// on the gate, but a URL matching one of the routes (a directory's /meta, say)
// answers straight away. That is what it takes to open a *different* directory
// while an RSGB query is still in flight.
function installGatedRsgbFetchExcept(bySquare, routes) {
  const calls = [];
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      const text = String(url);
      calls.push({ url: text, init });
      const route = routes.find((entry) => text.includes(entry.match));
      if (route) {
        return {
          ok: true,
          status: 200,
          text: async () => route.body ?? "",
          json: async () => JSON.parse(route.body ?? "null"),
        };
      }
      await gate;
      const square = text.split("/").pop();
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: bySquare[square] ?? null }),
      };
    },
  });
  return { calls, release: () => openGate() };
}

// installGatedRsgbFetch()'s general-purpose sibling: every request is held open
// until the test releases it, whatever the URL, so a source can be caught with
// its dictionary still loading.
function installGatedFetch(routes) {
  const calls = [];
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      const text = String(url);
      calls.push({ url: text, init });
      await gate;
      const route = routes.find((entry) => text.includes(entry.match));
      if (!route) {
        throw new Error(`Unrouted fetch: ${text}`);
      }
      return { ok: true, status: 200, text: async () => route.body ?? "" };
    },
  });
  return { calls, release: () => openGate() };
}

function repeaterRecord(overrides = {}) {
  return {
    id: 199,
    status: "OPERATIONAL",
    town: "HERNE BAY",
    modeCodes: ["A"],
    tx: 145662500,
    rx: 145062500,
    ctcss: 103.5,
    txbw: 12.5,
    band: "2M",
    repeater: "GB3KI",
    locator: "JO01NI",
    ...overrides,
  };
}

const LONDON = { coords: { latitude: 51.5072, longitude: -0.1276 } };

async function openRsgb(dom) {
  await dom.channelImportRsgbEl.dispatch("click");
}

// Every directory is one click from every other now that the toolbar carries
// them all, so a dictionary that is still loading has to lose to the source
// the user asked for next. Before the generation check, the late resolution
// rebuilt the modal under the newer source's title.
test("a directory still loading its options cannot replace the one opened after it", async () => {
  const { query, dom, log } = buildHarness();
  const { calls, release } = installGatedFetch([{ match: "/przemienniki/meta", body: META_JSON }]);

  // przemienniki has to fetch its filter dictionary; RSGB's options are
  // static, so the second click finishes while the first is still in flight.
  const pending = dom.channelImportPrzemiennikiEl.dispatch("click");
  await flush();
  assert.deepEqual(calls.map((call) => call.url), ["https://proxy.example.com/przemienniki/meta"]);
  await dom.channelImportRsgbEl.dispatch("click");
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query RSGB ETCC API");

  release();
  await pending;
  await flush();

  assert.equal(query.isModalOpen(), true, "the modal the user asked for must stay open");
  assert.equal(
    dom.repeaterQueryTitleEl.textContent,
    "Query RSGB ETCC API",
    "the superseded load must not retitle the modal",
  );
  // The fields belong to RSGB too, not just the title: RSGB offers a locator,
  // which no przemienniki form does.
  assert.ok(grid(dom).querySelectorAll('input[name="locator"]').length > 0);
  assert.equal(log.statuses.at(-1), "Configure RSGB ETCC query.");
});

// The button is hidden by web/js/ui/repeater-query.js when a blank proxy base
// makes its source unavailable, which only works if the stylesheet lets it:
// the toolbar's own display declaration outranks the browser's [hidden] rule,
// so a visible button would sit there doing nothing when clicked.
test("the toolbar lets an unavailable source's button stay hidden", () => {
  const styles = fs.readFileSync(path.join(repoRoot, "web", "styles.css"), "utf8");
  const rule = styles.match(/\.channel-toolbar button\[hidden\] \{([^}]*)\}/);
  assert.ok(rule, "toolbar buttons need a rule restoring the [hidden] default");
  assert.match(rule[1], /display:\s*none/);
});

test("the RSGB modal opens without a network round trip", async () => {
  const { query, dom, table } = buildHarness();
  const calls = installRsgbFetch({});
  assert.equal(query.isModalOpen(), false);

  await openRsgb(dom);
  assert.equal(query.isModalOpen(), true);
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query RSGB ETCC API");
  assert.deepEqual(calls, [], "the static filter options need no dictionary fetch");
  // The first focusable control is the first band checkbox — the fixed
  // country row offers nothing to focus.
  assert.equal(grid(dom).querySelectorAll('input[name="band"]')[0].focused, true);

  query.setModalOpen(false);
  assert.equal(query.isModalOpen(), false);
});

test("opening the RSGB modal preselects 2m, 70cm and analogue", async () => {
  const { dom } = buildHarness();
  await openRsgb(dom);

  const checkedBands = grid(dom).querySelectorAll('input[name="band"]:checked');
  const checkedModes = grid(dom).querySelectorAll('input[name="mode"]:checked');
  assert.deepEqual(checkedBands.map((el) => el.value), ["70CM", "2M"]);
  assert.deepEqual(checkedModes.map((el) => el.value), ["A"]);
});

test("RSGB band and mode labels match the other sources' casing, with unsupported modes disabled", async () => {
  const { dom } = buildHarness();
  await openRsgb(dom);

  const [bandBox, modeBox] = descendants(grid(dom)).filter((el) => el.className === "modal-modes");
  // Labels are display-only lowercase; the values behind them stay the API's
  // own band codes and mode flags.
  assert.deepEqual(
    bandBox.children.map((option) => option.children[1].textContent),
    ["70cm", "2m", "23cm", "6m", "10m", "9cm", "3cm"],
  );
  assert.deepEqual(
    modeBox.children.map((option) => option.children[1].textContent),
    ["fm", "dstar", "dmr", "p25", "nxdn", "m17"],
  );

  const modeInputs = grid(dom).querySelectorAll('input[name="mode"]');
  assert.deepEqual(modeInputs.map((el) => el.value), ["A", "D", "M", "P", "N", "7"]);
  assert.deepEqual(modeInputs.filter((el) => el.disabled).map((el) => el.value), ["M", "P", "N", "7"]);
  assert.deepEqual(
    modeBox.children
      .filter((option) => option.title === "Only analogue modes and dstar are supported fully")
      .map((option) => option.children[1].textContent),
    ["dmr", "p25", "nxdn", "m17"],
  );
});

test("reopening the RSGB modal restores every default, not the last selection", async () => {
  const { query, dom } = buildHarness();
  await openRsgb(dom);

  for (const el of grid(dom).querySelectorAll('input[name="band"]')) {
    el.checked = el.value === "23CM";
  }
  fieldByName(dom, "only").checked = false;
  fieldByName(dom, "radius").value = "250";
  query.setModalOpen(false);
  await openRsgb(dom);

  assert.deepEqual(
    grid(dom).querySelectorAll('input[name="band"]:checked').map((el) => el.value),
    ["70CM", "2M"],
  );
  assert.equal(fieldByName(dom, "only").checked, true);
  assert.equal(fieldByName(dom, "radius").value, "30");
});

test("an unavailable geolocation API is reported, not swallowed", async () => {
  const { dom, log } = buildHarness();
  installGeolocation(null);
  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  assert.equal(fieldByName(dom, "latitude").value, "");
  // The browser having no geolocation at all is a capability gap, not a
  // refusal by the user, so it keeps the error funnel rather than reading as
  // an action the user called off.
  assert.equal(log.cancelled.length, 0);
  assert.match(log.errors.join("\n"), /^RSGB ETCC geolocation: .*not available in this browser/);
});

test("a coordinate-free or ill-formed RSGB query never reaches the network", async () => {
  const { dom, log } = buildHarness();
  const calls = installRsgbFetch({});
  await openRsgb(dom);

  await dom.repeaterQueryFormEl.dispatch("submit");
  assert.match(log.errors.join("\n"), /Set a location first/);

  const latitude = fieldByName(dom, "latitude");
  latitude.value = "51.5072";
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = "-0.1276";
  await longitude.dispatch("input");
  for (const radius of ["", "0", "-5"]) {
    fieldByName(dom, "radius").value = radius;
    await dom.repeaterQueryFormEl.dispatch("submit");
  }
  assert.equal(log.errors.filter((line) => /positive number of kilometres/.test(line)).length, 3);

  assert.deepEqual(calls, [], "nothing should have been fetched");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false, "the modal stays open on an error");
  // Four submits were accepted, so a failed query must release the in-flight
  // guard rather than leaving the form wedged.
  assert.equal(dom.repeaterQuerySubmitEl.disabled, false, "a failed query leaves the button usable");
});

test("an RSGB query fans out over the squares and inserts the matching repeaters", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  const calls = installRsgbFetch({
    // London's 30 km radius spans the IO/JO field boundary.
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" })],
    JO01: [
      repeaterRecord({ id: 2, repeater: "GB3BK", tx: 430900000, rx: 438500000, locator: "JO01AK", band: "70CM" }),
      // Filtered out: a simplex gateway is not a repeater.
      repeaterRecord({ id: 3, repeater: "MB7IBR", tx: 144962500, rx: 144962500, locator: "JO01AK" }),
    ],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.deepEqual(calls.map((call) => call.url).sort(), [
    "https://api-beta.rsgb.online/locator/IO91",
    "https://api-beta.rsgb.online/locator/JO01",
  ]);
  // A custom header would force the CORS preflight the API answers with 405.
  // The abort signal that bounds the request is not a header, so the request
  // stays a simple one — init may carry that and nothing else.
  assert.ok(calls.every((call) => Object.keys(call.init || {}).join() === "signal"));

  assert.deepEqual(log.errors, []);
  assert.equal(table.inserted.length, 1);
  const { rows, label } = table.inserted[0];
  assert.equal(label, "RSGB ETCC");
  assert.deepEqual(rows.map((row) => row.Name), ["GB3XP", "GB3BK"]);
  assert.equal(rows[0].Frequency, "145.687500");
  assert.equal(rows[0].Duplex, "-");
  assert.equal(rows[0].Power, "High", "a repeater channel must not default to Low");
  // Three records came back across both squares; the gateway is not a repeater.
  assert.ok(log.debug.some((line) => line.includes("3 fetched, 3 unique, 2 matched")));
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true, "a successful query closes the modal");
});

test("repeaters the radio cannot tune are reported, not silently missing", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  installRsgbFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" }),
      // A 1312 MHz ATV repeater: the harness radio refuses anything over 470.
      repeaterRecord({ id: 2, repeater: "GB3EN", tx: 1312000000, rx: 1249000000, locator: "IO91XP", band: "23CM" }),
    ],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  // Clear the band filter so the 23cm record is not excluded before the builder.
  for (const el of grid(dom).querySelectorAll('input[name="band"]')) {
    el.checked = false;
  }
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);
  assert.ok(
    log.debug.some((line) => /SKIPPED GB3EN \(frequency not supported/.test(line)),
    "the drop must name the repeater and the reason",
  );
  assert.ok(
    log.statuses.some((line) => /skipped 1 outside its frequency range/.test(line)),
    "and be said in the status line, not only the debug log",
  );
});

test("a repeater in an unusable mode is reported separately from an untunable one", async () => {
  const { dom, log, table } = buildHarness({ modeOptions: ["FM", "NFM"] });
  installGeolocation(LONDON);
  installRsgbFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", modeCodes: ["A"] }),
      // D-STAR only, on a harness radio whose Mode column answers NFM to
      // everything: writing NFM here would be a channel that cannot work it.
      repeaterRecord({ id: 2, repeater: "GB7DS", tx: 145737500, rx: 145137500, locator: "IO91VJ", modeCodes: ["D"] }),
    ],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  // Both modes selected, so the D-STAR record reaches the row builder — an
  // empty selection would fall back to analogue-only and filter it earlier.
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = !el.disabled;
  }
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);
  assert.ok(log.debug.some((line) => /SKIPPED GB7DS \(mode not supported/.test(line)));
  assert.ok(
    log.statuses.some((line) => /skipped 1 in a mode it cannot use/.test(line)),
    `status lines were: ${log.statuses.join(" | ")}`,
  );
});

test("a repeater whose tone the radio cannot send is reported, not written as 67.0", async () => {
  // The rejected tone write leaves the driver's first tone in the cell, so an
  // unreported skip here would look like a perfectly good 67.0 Hz channel that
  // never opens the repeater (issue #104).
  const { dom, log, table } = buildHarness({ toneOptions: ["67.0", "88.5", "110.9"] });
  installGeolocation(LONDON);
  installRsgbFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", ctcss: 110.9 }),
      repeaterRecord({ id: 2, repeater: "GB3TN", tx: 145737500, rx: 145137500, locator: "IO91VJ", ctcss: 141.3 }),
    ],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);
  assert.equal(table.inserted[0].rows[0].rToneFreq, "110.9");
  assert.ok(
    log.debug.some((line) => /SKIPPED GB3TN \(141\.3 Hz tone not in the selected radio's tone table\)/.test(line)),
    `debug lines were: ${log.debug.join(" | ")}`,
  );
  assert.ok(
    log.statuses.some((line) => /skipped 1 needing a tone it cannot send/.test(line)),
    `status lines were: ${log.statuses.join(" | ")}`,
  );
});

test("an RSGB query with no mode selected falls back to analogue only", async () => {
  // The form presents dmr/p25/nxdn/m17 as unavailable, so an empty mode
  // selection must not become filterRsgbRecords()'s "any mode" — even on a
  // radio that advertises DMR, a DMR-only record must stay out.
  const { dom, table } = buildHarness({ modeOptions: ["FM", "NFM", "DV", "DMR"] });
  installGeolocation(LONDON);
  installRsgbFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", modeCodes: ["A"] }),
      repeaterRecord({ id: 2, repeater: "GB7DMR", tx: 439412500, rx: 430412500, locator: "IO91VJ", band: "70CM", modeCodes: ["M:1"] }),
      repeaterRecord({ id: 3, repeater: "GB7DS", tx: 145737500, rx: 145137500, locator: "IO91VJ", modeCodes: ["D"] }),
    ],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = false;
  }
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);
});

test("the RSGB band and mode checkboxes filter what is inserted", async () => {
  const { dom, table } = buildHarness();
  installGeolocation(LONDON);
  installRsgbFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", modeCodes: ["A"] }),
      repeaterRecord({ id: 2, repeater: "GB7DS", tx: 439412500, rx: 430412500, locator: "IO91VJ", band: "70CM", modeCodes: ["D"] }),
    ],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  // Defaults (2m + 70cm, analogue) keep only the analogue one.
  await dom.repeaterQueryFormEl.dispatch("submit");
  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);

  await openRsgb(dom);
  for (const el of grid(dom).querySelectorAll('input[name="mode"]')) {
    el.checked = el.value === "D";
  }
  await dom.repeaterQueryFormEl.dispatch("submit");
  assert.deepEqual(table.inserted[1].rows.map((row) => row.Name), ["GB7DS"]);
});

test("unticking 'only operational' admits the off-air repeaters", async () => {
  const { dom, table } = buildHarness();
  installGeolocation(LONDON);
  installRsgbFetch({
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", status: "NOT OPERATIONAL" })],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");
  // The grid is handed the empty set rather than being skipped: it owns the
  // "no entries to insert" message.
  assert.deepEqual(table.inserted[0].rows, []);

  await openRsgb(dom);
  fieldByName(dom, "only").checked = false;
  await dom.repeaterQueryFormEl.dispatch("submit");
  assert.deepEqual(table.inserted[1].rows.map((row) => row.Name), ["GB3XP"]);
  assert.match(table.inserted[1].rows[0].Comment, /NOT OPERATIONAL$/);
});

test("an RSGB transport failure is reported and leaves the modal open", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.match(log.errors.join("\n"), /^RSGB ETCC query: .*HTTP 503/m);
  assert.deepEqual(table.inserted, []);
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false, "the user keeps their filters to retry with");
});

test("an RSGB query with no channel schema loaded does nothing", async () => {
  const { dom, log, table } = buildHarness({ headers: [] });
  installGeolocation(LONDON);
  const calls = installRsgbFetch({});

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");

  assert.deepEqual(calls, []);
  assert.deepEqual(table.inserted, []);
  assert.ok(log.statuses.includes("No channel schema loaded yet."));
});

test("a second submit while a query is in flight is ignored, not duplicated", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  const { calls, release } = installGatedRsgbFetch({
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" })],
    JO01: [repeaterRecord({ id: 2, repeater: "GB3BK", tx: 430900000, rx: 438500000, locator: "JO01AK", band: "70CM" })],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");

  // Not awaited: the query is suspended on the gated fetch, exactly as it is
  // suspended on a real fan-out that takes seconds.
  const first = dom.repeaterQueryFormEl.dispatch("submit");
  assert.equal(dom.repeaterQuerySubmitEl.disabled, true, "the button says the query is running");
  assert.equal(dom.repeaterQuerySubmitEl.textContent, "Querying...");

  const second = dom.repeaterQueryFormEl.dispatch("submit");
  release();
  await Promise.all([first, second]);

  assert.deepEqual(log.errors, []);
  assert.equal(table.inserted.length, 1, "the second submit must not insert a second copy");
  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP", "GB3BK"]);
  // Two squares for London at 30 km: the second submit fanned out over none.
  assert.equal(calls.length, 2, "the second submit must not reach the network");
  assert.equal(dom.repeaterQuerySubmitEl.disabled, false, "the button comes back for the next query");
  assert.equal(dom.repeaterQuerySubmitEl.textContent, "Query API");
});

test("a cancelled query cannot insert into, or close, the directory opened next", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  const { release } = installGatedRsgbFetchExcept({
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" })],
  }, [{ match: "/przemienniki/meta", body: META_JSON }]);

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  // Not awaited: the RSGB fan-out is suspended on the gate, which is the
  // several seconds a real one takes.
  const pending = dom.repeaterQueryFormEl.dispatch("submit");
  assert.equal(dom.repeaterQuerySubmitEl.disabled, true, "the query is running");

  await dom.repeaterQueryCancelEl.dispatch("click");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
  assert.equal(dom.repeaterQuerySubmitEl.disabled, false, "cancelling gives the button back");
  assert.equal(dom.repeaterQuerySubmitEl.textContent, "Query API");

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query przemienniki.net");
  assert.equal(dom.repeaterQuerySubmitEl.disabled, false, "the new directory's query is runnable");

  release();
  await pending;

  assert.deepEqual(table.inserted, [], "the cancelled directory's repeaters must not reach the grid");
  assert.equal(
    dom.repeaterQueryModalEl.classList.contains("hidden"),
    false,
    "the cancelled query must not close the modal that replaced it",
  );
  assert.equal(dom.repeaterQuerySubmitEl.disabled, false);
  assert.equal(dom.repeaterQuerySubmitEl.textContent, "Query API");
  assert.deepEqual(log.errors, []);
  // Dropped rows are still accounted for where diagnostics belong.
  assert.match(log.debug.join("\n"), /^RSGB DISCARDED 1 row\(s\): the query was abandoned$/m);
});

// --- Request deadline --------------------------------------------------------

// A host that accepts the connection and then answers nothing used to leave the
// modal stuck on "Querying..." until the browser's own network timeout fired
// (~300 s in Chrome for a stalled connection), with an empty debug panel. These
// drive the real deadline over a mocked clock, so they assert the shipped
// REPEATER_REQUEST_TIMEOUT_MS rather than a value only the test knows.

test("a stalled RSGB request times out and reports a readable error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  const calls = installStalledFetch([{ match: "api-beta.rsgb.online", stall: true }]);

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  const pending = dom.repeaterQueryFormEl.dispatch("submit");
  await flush();

  assert.ok(calls.length > 0, "the squares are actually in flight");
  assert.deepEqual(log.errors, [], "nothing is reported while the request is still inside its window");

  t.mock.timers.tick(REPEATER_REQUEST_TIMEOUT_MS);
  await pending;

  assert.equal(log.errors.length, 1);
  // The square is named so the debug panel says which request stalled, and the
  // words "timed out" are what classifyErrorKind() matches on.
  assert.match(log.errors[0], /^RSGB ETCC query: RSGB query for [A-Z]{2}\d{2} timed out after 10 s: /);
  assert.deepEqual(table.inserted, []);
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false, "the user keeps their filters to retry with");
  // The in-flight guard releases on a timeout as it does on any other failure,
  // so the retry the deadline exists to make possible is actually possible —
  // a deadline that left the form wedged on "Querying..." would have replaced
  // one stuck modal with another.
  assert.equal(dom.repeaterQuerySubmitEl.disabled, false);
  assert.equal(dom.repeaterQuerySubmitEl.textContent, "Query API");
});

test("a stalled dictionary request times out instead of leaving the modal opening forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dom, log } = buildHarness();
  installStalledFetch([{ match: "/meta", stall: true }]);

  const pending = dom.channelImportPrzemiennikiEl.dispatch("click");
  await flush();
  assert.deepEqual(log.errors, []);

  t.mock.timers.tick(REPEATER_REQUEST_TIMEOUT_MS);
  await pending;

  assert.deepEqual(log.errors, [
    "Przemienniki modal: przemienniki.net dictionary request timed out after 10 s: the server accepted the request but never answered.",
  ]);
});

test("a stalled przemienniki query times out with the dictionary already loaded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dom, log, table } = buildHarness();
  // The dictionary answers so the modal opens normally; only the query stalls.
  installStalledFetch([
    { match: "/meta", body: META_JSON },
    { match: "", stall: true },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.deepEqual(log.errors, [], "the dictionary fetch is well inside the deadline");

  const pending = dom.repeaterQueryFormEl.dispatch("submit");
  await flush();
  t.mock.timers.tick(REPEATER_REQUEST_TIMEOUT_MS);
  await pending;

  assert.deepEqual(log.errors, [
    "Przemienniki query: przemienniki.net query timed out after 10 s: the server accepted the request but never answered.",
  ]);
  assert.deepEqual(table.inserted, []);
});

test("a request answering inside the deadline is unaffected by it", async (t) => {
  // The deadline must not fire on a query that simply took a moment, and its
  // timer must be cleared once the request lands — an outstanding timer would
  // abort the *next* request on a browser that reuses the connection.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dom, log, table } = buildHarness();
  installStalledFetch([
    { match: "/meta", body: META_JSON },
    {
      match: "",
      body: `
        <rxf><perspective>radio</perspective><repeaters><repeater>
          <qra>SR5WA</qra><mode>fm</mode>
          <qrg type="rx">145.6125</qrg><qrg type="tx">145.0125</qrg>
          <qth>Warszawa</qth><ctcss type="tx">88.5</ctcss>
        </repeater></repeaters></rxf>
      `,
    },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await dom.repeaterQueryFormEl.dispatch("submit");
  t.mock.timers.tick(REPEATER_REQUEST_TIMEOUT_MS * 2);

  assert.deepEqual(log.errors, []);
  assert.equal(table.inserted.length, 1);
});

// --- Place name across opens -------------------------------------------------

const KRAKOW_JSON = JSON.stringify({
  query: "krak",
  results: [{
    id: 3094802,
    name: "Kraków",
    region: "Lesser Poland",
    country: "Poland",
    cc: "PL",
    lat: 50.06143,
    lon: 19.93658,
  }],
});

// Type into the Place name box and take the top suggestion the way a user
// leaving the field does. The lookup fires on the keystroke, so the only wait
// is for the stubbed fetch to settle.
async function pickCity(dom, text) {
  const city = fieldByName(dom, "city");
  city.value = text;
  await city.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await city.dispatch("blur");
  return city;
}

test("a chosen city fills the position, the locator and the box itself", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }, { match: "/cities", body: KRAKOW_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  const city = await pickCity(dom, "krak");

  assert.equal(city.value, "Kraków, Lesser Poland, Poland");
  assert.equal(fieldByName(dom, "latitude").value, "50.061430");
  assert.equal(fieldByName(dom, "longitude").value, "19.936580");
  assert.equal(fieldByName(dom, "locator").value, "JO90XB");
});

test("the chosen city persists across a reopen and a source switch", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }, { match: "/cities", body: KRAKOW_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await pickCity(dom, "krak");
  await dom.repeaterQueryCancelEl.dispatch("click");

  // Same source again: the name is back in the box, in step with the
  // coordinates the position field restores beside it.
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(fieldByName(dom, "city").value, "Kraków, Lesser Poland, Poland");
  assert.equal(fieldByName(dom, "latitude").value, "50.061430");
  await dom.repeaterQueryCancelEl.dispatch("click");

  // A different directory is still the same place, so the name carries over
  // exactly as the coordinates already did.
  await dom.channelImportRepeaterbookEl.dispatch("click");
  assert.equal(fieldByName(dom, "city").value, "Kraków, Lesser Poland, Poland");
  assert.equal(fieldByName(dom, "latitude").value, "50.061430");
});

test("restoring a city costs no lookup", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/cities", body: KRAKOW_JSON },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await pickCity(dom, "krak");
  const afterPick = calls.filter((call) => call.url.includes("/cities")).length;
  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");

  // The coordinates the name produced are already in the form; asking the
  // gazetteer to rediscover them would be a request whose answer is on screen.
  assert.equal(calls.filter((call) => call.url.includes("/cities")).length, afterPick);
});

test("moving the position by hand drops the city name it no longer describes", async () => {
  const { dom } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }, { match: "/cities", body: KRAKOW_JSON }]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await pickCity(dom, "krak");

  const latitude = fieldByName(dom, "latitude");
  latitude.value = "51.5";
  await latitude.dispatch("input");

  // The box would otherwise still claim these coordinates are Kraków.
  assert.equal(fieldByName(dom, "city").value, "");
  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(fieldByName(dom, "city").value, "", "and it stays dropped on reopen");
  assert.equal(fieldByName(dom, "latitude").value, "51.5");
});

// --- Map preview of what a query would return --------------------------------

// Two repeaters near Kraków: one about 10 km out, one about 40 km. The preview
// asks the directory for 1.5x the chosen radius, so at 30 km both come back and
// the second is the one the ring excludes.
const PREVIEW_RXF = `
  <rxf><perspective>radio</perspective><repeaters>
    <repeater>
      <qra>SR6NEAR</qra><mode>fm</mode>
      <qrg type="rx">145.6</qrg><qrg type="tx">145</qrg>
      <location><latitude>50.15</latitude><longitude>19.94</longitude></location>
    </repeater>
    <repeater>
      <qra>SR6FAR</qra><mode>fm</mode>
      <qrg type="rx">145.7</qrg><qrg type="tx">145.1</qrg>
      <location><latitude>50.42</latitude><longitude>19.94</longitude></location>
    </repeater>
  </repeaters></rxf>
`;

// The preview waits for the form to settle before asking anything
// (PREVIEW_QUERY_DEBOUNCE_MS, 600 ms), so a test that edits has to outwait it.
function afterPreviewQuery() {
  return new Promise((resolve) => setTimeout(resolve, 750));
}

// A position no other test in this file uses, so a preview can be attributed to
// the test that asked for it. Tests here end with their modal still open, and a
// preview it scheduled fires on a real timer -- into whichever fetch stub is
// installed by then. That is honest behaviour for a modal that is still on
// screen, so the tests identify their own request rather than the code
// pretending an open form stops previewing.
const PREVIEW_LAT = 49.5;
const PREVIEW_LON = 20.5;

// The caption under the map preview, which is the field's own element rather
// than anything web/js/ui/dom.js knows about.
function previewCaption(dom) {
  const match = descendants(grid(dom)).find((el) => el.className === "modal-map-preview-count");
  assert.ok(match, "the map preview has a caption");
  return match;
}

function previewCalls(calls, match) {
  return calls.filter((call) => call.url.includes(match)
    && !call.url.includes("/meta")
    && call.url.includes(`latitude=${PREVIEW_LAT}&`));
}

// Edit one control the way a browser reports it. The fields' own listeners sit
// on the control, while the preview listens once on the grid and relies on the
// event bubbling there -- and the fake DOM has no bubbling, so the dispatch is
// repeated at the delegating element with `target` set, which is exactly what a
// real browser hands that listener.
async function editField(dom, name, value) {
  const field = fieldByName(dom, name);
  field.value = String(value);
  await field.dispatch("input");
  await grid(dom).dispatch("input", { target: field });
}

async function setPreviewPosition(dom) {
  const latitude = fieldByName(dom, "latitude");
  latitude.value = String(PREVIEW_LAT);
  await latitude.dispatch("input");
  const longitude = fieldByName(dom, "longitude");
  longitude.value = String(PREVIEW_LON);
  await longitude.dispatch("input");
}

test("setting a position previews what the filters would return", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await afterPreviewQuery();

  const preview = previewCalls(calls, "/przemienniki");
  assert.equal(preview.length, 1);
  // Half again the chosen radius, so the map can show what a wider search
  // would add rather than only what this one keeps.
  assert.equal(new URL(preview[0].url).searchParams.get("range"), "45");
  // The filters are the form's own, not a bare position query.
  assert.equal(new URL(preview[0].url).searchParams.get("band"), "2m,70cm");
});

test("a burst of edits costs one preview, not one per keystroke", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  for (const value of ["40", "50", "60"]) {
    await editField(dom, "radius", value);
  }
  await afterPreviewQuery();

  // A drag rewrites the coordinates on every pointermove and RSGB's fan-out is
  // nine requests wide, so this delay is what makes the feature affordable.
  assert.equal(previewCalls(calls, "/przemienniki").length, 1);
  assert.equal(new URL(previewCalls(calls, "/przemienniki")[0].url).searchParams.get("range"), "90");
});

test("an unchanged search redraws from cache instead of asking again", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await afterPreviewQuery();
  const first = previewCalls(calls, "/przemienniki").length;

  // Close and reopen on the same position and filters: the request would be
  // byte for byte the one already answered.
  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await afterPreviewQuery();

  assert.equal(previewCalls(calls, "/przemienniki").length, first);
});

test("a preview is never issued for a form with no position", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await editField(dom, "radius", "50");
  await afterPreviewQuery();

  assert.equal(previewCalls(calls, "/przemienniki").length, 0);
});

test("a directory that refuses a preview leaves the form usable", async () => {
  const { dom, log, table } = buildHarness();
  installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", ok: false, status: 503, body: "down" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await afterPreviewQuery();

  // A preview is a hint. It must not read as a failed query: nothing was asked
  // for, the modal stays open, and the status line is left for the real one.
  assert.deepEqual(log.errors, []);
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), false);
  assert.equal(table.inserted.length, 0);
  assert.ok(log.debug.some((line) => /PREVIEW FAILED/.test(line)), "the reason reaches the debug panel");
});

test("closing the modal abandons a preview still in flight", async () => {
  const { dom } = buildHarness();
  installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  // Inside the debounce window, so the request has not gone out yet.
  await dom.repeaterQueryCancelEl.dispatch("click");
  await afterPreviewQuery();

  // Nothing to assert on the map — the point is that no error and no stray
  // render follow a modal that is gone.
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
});

// --- Preview review follow-ups ------------------------------------------------

test("an invalid radius is an inactive preview, not an empty one", async () => {
  const { dom, log } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await editField(dom, "radius", "");
  await afterPreviewQuery();

  // No directory was contacted, so captioning the map "0 in range" and logging
  // a successful zero-result preview would both be inventions.
  assert.equal(previewCalls(calls, "/przemienniki").length, 0);
  assert.ok(!log.debug.some((line) => /PREVIEW 0 repeater/.test(line)));
});

test("a failed city lookup puts the whole error in the debug panel", async () => {
  const { dom, log } = buildHarness();
  installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/cities", ok: false, status: 503, body: "down" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  const city = fieldByName(dom, "city");
  city.value = "krak";
  await city.dispatch("input");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    log.debug.some((line) => /CITY LOOKUP FAILED/.test(line)),
    "a service failure must be diagnosable from Debug Output",
  );
  // Still only a hint: the status line belongs to the real query.
  assert.deepEqual(log.errors, []);
});

// --- RSGB preview cache -------------------------------------------------------

test("the submitted RSGB query reuses what the preview already downloaded", async () => {
  const { dom, log } = buildHarness();
  installGeolocation(LONDON);
  const calls = installRsgbFetch({
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" })],
    JO01: [],
  });

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  // Long enough for the automatic preview to run its fan-out.
  await afterPreviewQuery();
  const afterPreview = calls.length;
  assert.ok(afterPreview > 0, "the preview fanned out");

  await dom.repeaterQueryFormEl.dispatch("submit");

  // The normal workflow is to pause long enough to see the preview and then
  // press Query API. Fetching again here downloaded every square a second
  // time — up to 24 more responses of roughly 75 kB, for records in hand.
  assert.equal(calls.length, afterPreview, "no square is downloaded twice");
  assert.deepEqual(log.errors, []);
  // The per-square debug line still comes from the squares actually fetched.
  assert.ok(log.debug.some((line) => /RSGB SQUARE IO91 -> 1/.test(line)));
});

test("making room in the square cache never drops a square the search needs", async () => {
  const { dom, log, table } = buildHarness();
  // A plan can be as wide as the cache is deep (both 24 squares), so a second
  // overlapping plan pushes the cache over its cap — and the oldest entries
  // then are precisely the overlapping ones the new plan still needs.
  const squares = {};
  for (const field of ["IO", "JO"]) {
    for (let lon = 0; lon < 5; lon += 1) {
      for (let lat = 0; lat < 5; lat += 1) {
        squares[`${field}${lon}${lat}`] = [];
      }
    }
  }
  squares.IO91 = [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" })];
  installRsgbFetch(squares);
  installGeolocation(LONDON);

  await openRsgb(dom);
  await geolocateButton(dom).dispatch("click");
  // A wide search first, to fill the cache, then back to a narrow one whose
  // squares the wide one already holds.
  await editField(dom, "radius", "500");
  await afterPreviewQuery();
  await editField(dom, "radius", "30");
  await afterPreviewQuery();

  await dom.repeaterQueryFormEl.dispatch("submit");

  // Evicting before reading would hand back an empty list for a square just
  // fetched, and the query would quietly omit its repeaters.
  assert.deepEqual(log.errors, []);
  assert.equal(table.inserted.length, 1);
  assert.equal(table.inserted[0].rows.length, 1, "GB3XP survived the cache making room");
});

// --- Second review round ------------------------------------------------------

test("no radio loaded means no preview and a caption saying why", async () => {
  const { dom } = buildHarness({ headers: [] });
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await afterPreviewQuery();

  // Query API refuses this with "No channel schema loaded yet", so plotting
  // squares and captioning a count would promise results the button cannot
  // deliver — and spend a directory request to do it.
  assert.equal(previewCalls(calls, "/przemienniki").length, 0);
  assert.equal(previewCaption(dom).textContent, "Select a radio to preview repeaters.");
});

test("nudging the radius reuses the body already fetched", async () => {
  const { dom } = buildHarness();
  const calls = installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", body: PREVIEW_RXF },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await afterPreviewQuery();
  assert.equal(previewCalls(calls, "/przemienniki").length, 1);

  // A body fetched at 1.5x the radius already covers every smaller one, so
  // narrowing only re-flags which side of the ring each station falls on.
  // Keying the cache on the whole URL made this miss, which is the commonest
  // edit in the form.
  await editField(dom, "radius", "20");
  await afterPreviewQuery();
  assert.equal(previewCalls(calls, "/przemienniki").length, 1, "narrowing asks nothing");

  // Wider than the cached body covers, so this one genuinely needs more ground.
  await editField(dom, "radius", "300");
  await afterPreviewQuery();
  assert.equal(previewCalls(calls, "/przemienniki").length, 2);
});

test("a preview failure reaches the debug panel with its stack", async () => {
  const { dom, log } = buildHarness();
  installFetch([
    { match: "/meta", body: META_JSON },
    { match: "/przemienniki", ok: false, status: 503, body: "down" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await afterPreviewQuery();

  const line = log.debug.find((entry) => /PREVIEW FAILED/.test(entry));
  assert.ok(line, "the failure is logged");
  // error.message alone cannot say which step threw.
  assert.match(line, /at /, "the stack comes with it");
});

// Repeaters due north of the preview position. A degree of latitude is ~111 km,
// and the distances are chosen against what the map can actually show: the ring
// fills 0.9 of the width, so the viewport reaches radius/0.9 and only that
// narrow band beyond the ring can hold a square the caption will count as
// "just outside".
function previewRepeaterAt(latitude, call) {
  return `
    <repeater>
      <qra>SR${call}</qra><mode>fm</mode>
      <qrg type="rx">145.6</qrg><qrg type="tx">145</qrg>
      <location><latitude>${latitude}</latitude><longitude>${PREVIEW_LON}</longitude></location>
    </repeater>
  `;
}

function previewRxf(...repeaters) {
  return `<rxf><perspective>radio</perspective><repeaters>${repeaters.join("")}</repeaters></rxf>`;
}

// 11 km: inside a 20 km ring.
const NEAR_11KM = previewRepeaterAt(PREVIEW_LAT + 0.1, "A");
// 21 km: outside a 20 km ring, inside the 22.2 km viewport it frames.
const NEAR_21KM = previewRepeaterAt(PREVIEW_LAT + 0.189, "B");
// 32 km: outside a 30 km ring, inside the 33.3 km viewport it frames.
const NEAR_32KM = previewRepeaterAt(PREVIEW_LAT + 0.288, "C");

test("a cached body is only reused when it covers the widened area too", async () => {
  const { dom } = buildHarness();
  // The directory filters by distance upstream, so each range gets what that
  // range would really contain.
  installFetch([
    { match: "/meta", body: META_JSON },
    { match: "range=30", body: previewRxf(NEAR_11KM, NEAR_21KM) },
    { match: "range=45", body: previewRxf(NEAR_11KM, NEAR_21KM, NEAR_32KM) },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  await setPreviewPosition(dom);
  await editField(dom, "radius", "20");
  await afterPreviewQuery();
  assert.equal(previewCaption(dom).textContent, "1 in range, 1 just outside");

  await editField(dom, "radius", "30");
  await afterPreviewQuery();

  // The 20 km search fetched 30 km of ground. Reusing it for a 30 km search
  // leaves nothing beyond that ring to dim, so the map would claim there is
  // nothing just outside while the repeater at 32 km went unfetched.
  assert.equal(previewCaption(dom).textContent, "2 in range, 1 just outside");
});

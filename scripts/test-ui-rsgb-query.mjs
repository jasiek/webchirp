import assert from "node:assert/strict";
import test from "node:test";

import { createRsgbQuery } from "../web/js/ui/rsgb-query.js";

// The module is driven directly rather than through createUiController, so each
// test can assert on exactly what it hands its siblings — which squares it
// fetched, which rows it inserted, what it logged. The fake DOM below is richer
// than the one in test-ui-repeater-query.mjs because this module reads state
// back out of the DOM: a real classList (the modal's open/closed state lives
// there) and a querySelectorAll that understands `input[name="x"]:checked`.
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.type = "";
    this.name = "";
    this.title = "";
    this.checked = false;
    this.focused = false;
    this._value = "";
    this._textContent = "";
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    };
  }

  get value() {
    return this._value;
  }

  set value(next) {
    this._value = String(next ?? "");
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(next) {
    this._textContent = String(next ?? "");
  }

  set innerHTML(next) {
    this._textContent = String(next ?? "");
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key).push(handler);
  }

  // Returns the handlers' promises so a test can await an async listener.
  dispatch(type, event = {}) {
    const handlers = this.listeners.get(String(type)) || [];
    return Promise.all(handlers.map((handler) => handler({ type, preventDefault() {}, ...event })));
  }

  // Only the shapes this module actually queries: `input[name="x"]` with an
  // optional `:checked`. Descends the whole subtree, as the real one does.
  querySelectorAll(selector) {
    const match = /^input\[name="([^"]+)"\](:checked)?$/.exec(String(selector));
    if (!match) {
      throw new Error(`FakeElement.querySelectorAll cannot handle: ${selector}`);
    }
    const [, name, checkedOnly] = match;
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === "INPUT" && child.name === name && (!checkedOnly || child.checked)) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  focus() {
    this.focused = true;
  }
}

const DOM_KEYS = [
  "channelImportRsgbEl", "rsgbModalEl", "rsgbFormEl", "rsgbBandListEl", "rsgbModeListEl",
  "rsgbOnlyOperationalEl", "rsgbLatitudeEl", "rsgbLongitudeEl", "rsgbLocatorEl", "rsgbRadiusEl",
  "rsgbGeolocateEl", "rsgbCancelEl",
];

function buildHarness({
  headers = ["Name", "Frequency", "Duplex", "Offset", "Tone", "rToneFreq", "Mode", "Power", "Comment"],
  // What the stand-in radio's Mode column advertises. The default set has DV,
  // so D-STAR repeaters are buildable; pass ["FM", "NFM"] for an FM-only radio.
  modeOptions = ["FM", "NFM", "DV"],
} = {}) {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tagName) => new FakeElement(tagName) },
  });

  const dom = Object.fromEntries(DOM_KEYS.map((key) => [key, new FakeElement("div")]));
  dom.rsgbOnlyOperationalEl.type = "checkbox";
  dom.rsgbOnlyOperationalEl.checked = true;
  dom.rsgbRadiusEl.value = "30";
  // The modal starts closed, exactly as index.html ships it.
  dom.rsgbModalEl.classList.add("hidden");

  const log = { statuses: [], debug: [], errors: [] };
  const table = { menuOpenCalls: [], inserted: [] };

  const ctx = {
    dom,
    state: { currentHeaders: headers },
    log: {
      setStatus: (message) => log.statuses.push(String(message)),
      logDebug: (message) => log.debug.push(String(message)),
      reportActionError: (label, error) => log.errors.push(`${label}: ${error?.message || error}`),
    },
    table: {
      setMenuOpen: (open) => table.menuOpenCalls.push(open),
      insertRowsAtSelectionOrEnd: (rows, label) => table.inserted.push({ rows, label }),
      rowBuilderHooks: () => ({
        createBlankRow: () => Object.fromEntries(headers.map((column) => [column, ""])),
        setRowValue: (row, column, value) => {
          if (!headers.includes(column)) {
            return;
          }
          // Stands in for a 2m/70cm radio: the grid refuses a frequency the
          // driver cannot tune and leaves the previous value in place.
          if (column === "Frequency" && Number.parseFloat(value) > 470) {
            return;
          }
          row[column] = String(value ?? "");
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

  const query = createRsgbQuery(ctx);
  query.bindEvents();
  return { query, dom, log, table, ctx };
}

function installGeolocation(result) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      geolocation: result === null ? undefined : {
        getCurrentPosition: (ok, fail) => {
          if (result instanceof Error) {
            fail(result);
            return;
          }
          ok(result);
        },
      },
    },
  });
}

// Two locator squares' worth of canned responses, keyed by the square in the
// URL. Anything not listed answers the way the real API answers a miss.
function installFetch(bySquare) {
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

test("the modal opens closed, opens on the menu item, and closes the actions menu", async () => {
  const { query, dom, table } = buildHarness();
  assert.equal(query.isModalOpen(), false);

  await dom.channelImportRsgbEl.dispatch("click");
  assert.equal(query.isModalOpen(), true);
  assert.deepEqual(table.menuOpenCalls, [false], "the actions menu must close behind the modal");
  assert.equal(dom.rsgbRadiusEl.focused, true);

  query.setModalOpen(false);
  assert.equal(query.isModalOpen(), false);
});

test("cancel and a backdrop click close the modal; a click inside does not", async () => {
  const { query, dom } = buildHarness();

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbCancelEl.dispatch("click");
  assert.equal(query.isModalOpen(), false);

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbModalEl.dispatch("click", { target: dom.rsgbFormEl });
  assert.equal(query.isModalOpen(), true, "a click on the card must not dismiss it");
  await dom.rsgbModalEl.dispatch("click", { target: dom.rsgbModalEl });
  assert.equal(query.isModalOpen(), false);
});

test("opening the modal preselects 2m, 70cm and analogue", async () => {
  const { dom } = buildHarness();
  await dom.channelImportRsgbEl.dispatch("click");

  const checkedBands = dom.rsgbBandListEl.querySelectorAll('input[name="rsgb-band"]:checked');
  const checkedModes = dom.rsgbModeListEl.querySelectorAll('input[name="rsgb-mode"]:checked');
  assert.deepEqual(checkedBands.map((el) => el.value), ["70CM", "2M"]);
  assert.deepEqual(checkedModes.map((el) => el.value), ["A"]);
});

test("reopening restores the defaults rather than the last selection", async () => {
  const { query, dom } = buildHarness();
  await dom.channelImportRsgbEl.dispatch("click");

  for (const el of dom.rsgbBandListEl.querySelectorAll('input[name="rsgb-band"]')) {
    el.checked = el.value === "23CM";
  }
  query.setModalOpen(false);
  await dom.channelImportRsgbEl.dispatch("click");

  assert.deepEqual(
    dom.rsgbBandListEl.querySelectorAll('input[name="rsgb-band"]:checked').map((el) => el.value),
    ["70CM", "2M"],
  );
});

test("the locator field stays blank until both coordinates are real numbers", async () => {
  const { dom } = buildHarness();
  await dom.channelImportRsgbEl.dispatch("click");
  // Number("") is 0, so an empty modal once claimed to be in JJ00AA.
  assert.equal(dom.rsgbLocatorEl.value, "");

  dom.rsgbLatitudeEl.value = "51.5072";
  await dom.rsgbLatitudeEl.dispatch("input");
  assert.equal(dom.rsgbLocatorEl.value, "", "latitude alone is not a position");

  dom.rsgbLongitudeEl.value = "-0.1276";
  await dom.rsgbLongitudeEl.dispatch("input");
  assert.equal(dom.rsgbLocatorEl.value, "IO91WM");

  for (const outOfRange of ["91", "-100", "abc"]) {
    dom.rsgbLatitudeEl.value = outOfRange;
    await dom.rsgbLatitudeEl.dispatch("input");
    assert.equal(dom.rsgbLocatorEl.value, "", `${outOfRange} is not a latitude`);
  }
});

test("locator edits move the coordinates to the square's centre", async () => {
  const { dom } = buildHarness();
  await dom.channelImportRsgbEl.dispatch("click");

  dom.rsgbLocatorEl.value = "IO91WM";
  await dom.rsgbLocatorEl.dispatch("input");
  assert.equal(dom.rsgbLatitudeEl.value, "51.520833");
  assert.equal(dom.rsgbLongitudeEl.value, "-0.125000");

  // Lower case and 4-character precision both decode.
  dom.rsgbLocatorEl.value = "io91";
  await dom.rsgbLocatorEl.dispatch("input");
  assert.equal(dom.rsgbLatitudeEl.value, "51.500000");
  assert.equal(dom.rsgbLongitudeEl.value, "-1.000000");
});

test("partial or invalid locator text leaves the coordinates alone", async () => {
  const { dom } = buildHarness();
  await dom.channelImportRsgbEl.dispatch("click");

  dom.rsgbLatitudeEl.value = "51.5072";
  dom.rsgbLongitudeEl.value = "-0.1276";
  for (const text of ["", "I", "IO9", "99AB", "ZZ11"]) {
    dom.rsgbLocatorEl.value = text;
    await dom.rsgbLocatorEl.dispatch("input");
    assert.equal(dom.rsgbLatitudeEl.value, "51.5072", `coords survived "${text}"`);
    assert.equal(dom.rsgbLongitudeEl.value, "-0.1276", `coords survived "${text}"`);
  }
});

test("the location button fills both fields and the locator", async () => {
  const { dom, log } = buildHarness();
  installGeolocation(LONDON);
  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");

  assert.equal(dom.rsgbLatitudeEl.value, "51.507200");
  assert.equal(dom.rsgbLongitudeEl.value, "-0.127600");
  assert.equal(dom.rsgbLocatorEl.value, "IO91WM");
  assert.ok(log.debug.some((line) => line.includes("RSGB GEO 51.507200,-0.127600 IO91WM")));
  assert.deepEqual(log.errors, []);
});

test("a denied or unavailable location is reported, not swallowed", async () => {
  const denied = buildHarness();
  installGeolocation(new Error("User denied Geolocation"));
  await denied.dom.rsgbGeolocateEl.dispatch("click");
  assert.equal(denied.dom.rsgbLatitudeEl.value, "");
  assert.match(denied.log.errors.join("\n"), /User denied Geolocation/);

  const unavailable = buildHarness();
  installGeolocation(null);
  await unavailable.dom.rsgbGeolocateEl.dispatch("click");
  assert.match(unavailable.log.errors.join("\n"), /not available in this browser/);
});

test("a coordinate-free or ill-formed query never reaches the network", async () => {
  const { dom, log } = buildHarness();
  const calls = installFetch({});
  await dom.channelImportRsgbEl.dispatch("click");

  await dom.rsgbFormEl.dispatch("submit");
  assert.match(log.errors.join("\n"), /Set a location first/);

  dom.rsgbLatitudeEl.value = "51.5072";
  dom.rsgbLongitudeEl.value = "-0.1276";
  for (const radius of ["", "0", "-5"]) {
    dom.rsgbRadiusEl.value = radius;
    await dom.rsgbFormEl.dispatch("submit");
  }
  assert.equal(log.errors.filter((line) => /positive number of kilometres/.test(line)).length, 3);

  assert.deepEqual(calls, [], "nothing should have been fetched");
  assert.equal(dom.rsgbModalEl.classList.contains("hidden"), false, "the modal stays open on an error");
});

test("a query fans out over the squares and inserts the matching repeaters", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  const calls = installFetch({
    // London's 30 km radius spans the IO/JO field boundary.
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" })],
    JO01: [
      repeaterRecord({ id: 2, repeater: "GB3BK", tx: 430900000, rx: 438500000, locator: "JO01AK", band: "70CM" }),
      // Filtered out: a simplex gateway is not a repeater.
      repeaterRecord({ id: 3, repeater: "MB7IBR", tx: 144962500, rx: 144962500, locator: "JO01AK" }),
    ],
  });

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  await dom.rsgbFormEl.dispatch("submit");

  assert.deepEqual(calls.map((call) => call.url).sort(), [
    "https://api-beta.rsgb.online/locator/IO91",
    "https://api-beta.rsgb.online/locator/JO01",
  ]);
  // A custom header would force the CORS preflight the API answers with 405.
  assert.ok(calls.every((call) => call.init === undefined));

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
  assert.equal(query_isClosed(dom), true, "a successful query closes the modal");
});

function query_isClosed(dom) {
  return dom.rsgbModalEl.classList.contains("hidden");
}

test("repeaters the radio cannot tune are reported, not silently missing", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  installFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ" }),
      // A 1312 MHz ATV repeater: the harness radio refuses anything over 470.
      repeaterRecord({ id: 2, repeater: "GB3EN", tx: 1312000000, rx: 1249000000, locator: "IO91XP", band: "23CM" }),
    ],
  });

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  // Clear the band filter so the 23cm record is not excluded before the builder.
  for (const el of dom.rsgbBandListEl.querySelectorAll('input[name="rsgb-band"]')) {
    el.checked = false;
  }
  await dom.rsgbFormEl.dispatch("submit");

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
  installFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", modeCodes: ["A"] }),
      // D-STAR only, on a harness radio whose Mode column answers NFM to
      // everything: writing NFM here would be a channel that cannot work it.
      repeaterRecord({ id: 2, repeater: "GB7DS", tx: 145737500, rx: 145137500, locator: "IO91VJ", modeCodes: ["D"] }),
    ],
  });

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  for (const el of dom.rsgbModeListEl.querySelectorAll('input[name="rsgb-mode"]')) {
    el.checked = false;
  }
  await dom.rsgbFormEl.dispatch("submit");

  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);
  assert.ok(log.debug.some((line) => /SKIPPED GB7DS \(mode not supported/.test(line)));
  assert.ok(
    log.statuses.some((line) => /skipped 1 in a mode it cannot use/.test(line)),
    `status lines were: ${log.statuses.join(" | ")}`,
  );
});

test("the band and mode checkboxes filter what is inserted", async () => {
  const { dom, table } = buildHarness();
  installGeolocation(LONDON);
  installFetch({
    IO91: [
      repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", modeCodes: ["A"] }),
      repeaterRecord({ id: 2, repeater: "GB7DS", tx: 439412500, rx: 430412500, locator: "IO91VJ", band: "70CM", modeCodes: ["D"] }),
    ],
  });

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  // Defaults (2m + 70cm, analogue) keep only the analogue one.
  await dom.rsgbFormEl.dispatch("submit");
  assert.deepEqual(table.inserted[0].rows.map((row) => row.Name), ["GB3XP"]);

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  for (const el of dom.rsgbModeListEl.querySelectorAll('input[name="rsgb-mode"]')) {
    el.checked = el.value === "D";
  }
  await dom.rsgbFormEl.dispatch("submit");
  assert.deepEqual(table.inserted[1].rows.map((row) => row.Name), ["GB7DS"]);
});

test("reopening restores the checkbox and radius, not just the two lists", async () => {
  // Rebuilding the band and mode lists reset those, but 'only operational' and
  // the radius are plain DOM properties: a user who once included off-air
  // repeaters kept including them in every later query.
  const { query, dom } = buildHarness();
  await dom.channelImportRsgbEl.dispatch("click");

  dom.rsgbOnlyOperationalEl.checked = false;
  dom.rsgbRadiusEl.value = "250";
  query.setModalOpen(false);
  await dom.channelImportRsgbEl.dispatch("click");

  assert.equal(dom.rsgbOnlyOperationalEl.checked, true);
  assert.equal(dom.rsgbRadiusEl.value, "30");
});

test("unticking 'only operational' admits the off-air repeaters", async () => {
  const { dom, table } = buildHarness();
  installGeolocation(LONDON);
  installFetch({
    IO91: [repeaterRecord({ id: 1, repeater: "GB3XP", tx: 145687500, rx: 145087500, locator: "IO91VJ", status: "NOT OPERATIONAL" })],
  });

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  await dom.rsgbFormEl.dispatch("submit");
  // The grid is handed the empty set rather than being skipped: it owns the
  // "no entries to insert" message.
  assert.deepEqual(table.inserted[0].rows, []);

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  dom.rsgbOnlyOperationalEl.checked = false;
  await dom.rsgbFormEl.dispatch("submit");
  assert.deepEqual(table.inserted[1].rows.map((row) => row.Name), ["GB3XP"]);
  assert.match(table.inserted[1].rows[0].Comment, /NOT OPERATIONAL$/);
});

test("a transport failure is reported and leaves the modal open", async () => {
  const { dom, log, table } = buildHarness();
  installGeolocation(LONDON);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  await dom.rsgbFormEl.dispatch("submit");

  assert.match(log.errors.join("\n"), /HTTP 503/);
  assert.deepEqual(table.inserted, []);
  assert.equal(query_isClosed(dom), false, "the user keeps their filters to retry with");
});

test("a query with no channel schema loaded does nothing", async () => {
  const { dom, log, table } = buildHarness({ headers: [] });
  installGeolocation(LONDON);
  const calls = installFetch({});

  await dom.channelImportRsgbEl.dispatch("click");
  await dom.rsgbGeolocateEl.dispatch("click");
  await dom.rsgbFormEl.dispatch("submit");

  assert.deepEqual(calls, []);
  assert.deepEqual(table.inserted, []);
  assert.ok(log.statuses.includes("No channel schema loaded yet."));
});

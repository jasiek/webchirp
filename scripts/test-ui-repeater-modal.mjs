import assert from "node:assert/strict";
import test from "node:test";

import { createRepeaterQuery } from "../web/js/ui/repeater-query.js";

// The unified query modal is driven directly rather than through
// createUiController, so each test can assert on exactly what it hands its
// siblings — which URLs it fetched, which rows it inserted, what it logged.
// Every field element is built by query-fields.js via document.createElement,
// so the fake DOM below needs no static markup: a real classList (the modal's
// open/closed state lives there), a querySelectorAll that understands
// `input[name="x"]:checked`, and attribute get/set for the aria-label.
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.type = "";
    this.name = "";
    this.title = "";
    this.id = "";
    this.className = "";
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

  setAttribute(name, val) {
    this.attributes.set(String(name), String(val));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  // Only the shapes the module and these tests actually query: `input[name="x"]`
  // with an optional `:checked`. Descends the whole subtree.
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

// parsePrzemiennikiXml runs in the browser on DOMParser; the query tests only
// need the transport and URL side, so an empty-but-valid document is enough.
class FakeXmlDocument {
  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

const DOM_KEYS = [
  "channelImportPrzemiennikiEl", "channelImportRepeaterbookEl",
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

function buildHarness({ repeaterApiBase = "https://proxy.example.com", headers = ["Name", "Frequency"] } = {}) {
  const metas = new Map();
  if (repeaterApiBase !== undefined) {
    const meta = new FakeElement("meta");
    meta.setAttribute("content", String(repeaterApiBase ?? ""));
    metas.set('meta[name="webchirp-repeater-api-base"]', meta);
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tagName) => new FakeElement(tagName),
      querySelector: (selector) => metas.get(String(selector)) || null,
    },
  });
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    value: class {
      parseFromString() {
        return new FakeXmlDocument();
      }
    },
  });

  const dom = Object.fromEntries(DOM_KEYS.map((key) => [key, new FakeElement("div")]));
  // The modal starts closed, exactly as index.html ships it.
  dom.repeaterQueryModalEl.classList.add("hidden");

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
          row[column] = String(value ?? "");
        },
        findEnumOption: (column, choices) => choices[0] || "",
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
      geolocation: {
        getCurrentPosition(resolve, reject) {
          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result);
          }
        },
      },
    },
  });
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
  const button = descendants(grid(dom)).find((el) => el.className === "modal-geo-button");
  assert.ok(button, "geolocate button is in the grid");
  return button;
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
  assert.deepEqual(bands.map((el) => el.checked), [false, false]);
  assert.equal(fieldByName(dom, "only").checked, true);
  assert.equal(fieldByName(dom, "radius").value, "30");

  assert.ok(log.statuses.includes("Loading przemienniki.net query options..."));
  assert.ok(log.statuses.includes("Configure przemienniki.net query."));

  // A second open reuses the cached dictionary.
  await dom.repeaterQueryCancelEl.dispatch("click");
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(calls.length, 1);
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
    { match: "/przemienniki", body: "<xml/>" },
  ]);

  await dom.channelImportPrzemiennikiEl.dispatch("click");
  countrySelect(dom).value = "PL";
  const band = grid(dom).querySelectorAll('input[name="band"]')[0];
  band.checked = true;
  // Mode options come back label-sorted from the dictionary: dstar, fm.
  const mode = grid(dom).querySelectorAll('input[name="mode"]')[0];
  assert.equal(mode.value, "dstar");
  mode.checked = true;
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
  assert.deepEqual(url.searchParams.getAll("mode"), ["dstar"]);
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
    { match: "/repeaterbook", body: "<xml/>" },
  ]);

  await dom.channelImportRepeaterbookEl.dispatch("click");
  assert.equal(dom.repeaterQueryTitleEl.textContent, "Query repeaterbook.com");
  fieldByName(dom, "only").checked = false;

  await dom.repeaterQueryFormEl.dispatch("submit");

  const url = queryUrl(calls);
  for (const param of ["country", "band", "mode", "onlyworking", "latitude", "longitude"]) {
    assert.equal(url.searchParams.get(param), null, `no ${param} parameter`);
  }
  assert.equal(url.searchParams.get("range"), "30");
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
  grid(dom).querySelectorAll('input[name="band"]')[0].checked = true;
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
  assert.deepEqual(grid(dom).querySelectorAll('input[name="band"]:checked'), []);
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

test("a geolocation failure is reported with the active source's label", async () => {
  const { dom, log } = buildHarness();
  installFetch([{ match: "/meta", body: META_JSON }]);
  installGeolocation(new Error("User denied Geolocation"));

  await dom.channelImportRepeaterbookEl.dispatch("click");
  await geolocateButton(dom).dispatch("click");

  assert.equal(fieldByName(dom, "latitude").value, "");
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /^RepeaterBook geolocation: User denied Geolocation/);
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

test("a blank API base hides the remote source buttons and refuses to open", async () => {
  const { dom } = buildHarness({ repeaterApiBase: "" });
  const calls = installFetch([]);

  assert.equal(dom.channelImportPrzemiennikiEl.hidden, true);
  assert.equal(dom.channelImportRepeaterbookEl.hidden, true);
  await dom.channelImportPrzemiennikiEl.dispatch("click");
  assert.equal(dom.repeaterQueryModalEl.classList.contains("hidden"), true);
  assert.equal(calls.length, 0);
});

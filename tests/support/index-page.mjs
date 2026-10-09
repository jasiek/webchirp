// The app's real page, web/index.html, parsed into jsdom for the headless UI
// tests. Every element web/js/ui/dom.ts queries exists because the markup the
// browser gets is the markup the tests get; selectors, bubbling, focus, form
// controls and attribute reflection are the library's, not a stand-in's.
//
// Parsing the page is the expensive part (tens of milliseconds, and importing
// jsdom itself costs a few hundred once per process), so one page is parsed
// per test file and reset between tests: installIndexPage() swaps in a fresh
// copy of the parsed <html> element, which drops every element listener with
// the elements, then removes the listeners the previous test bound on window
// and document and undoes its overrides. A test that needs a page nobody else
// has touched passes { fresh: true }.
//
// What no DOM library does is layout: getBoundingClientRect() is all zeros,
// clientHeight and scrollHeight are 0, and requestAnimationFrame and
// ResizeObserver are absent, so the channel table renders every row instead of
// a window of them. Windowing is covered by the browser tests in tests/e2e.
import fs from "node:fs";
import path from "node:path";

import { JSDOM, VirtualConsole } from "jsdom";

import { webDir } from "./repo-paths.mjs";

const INDEX_HTML = fs.readFileSync(path.join(webDir, "index.html"), "utf8");

// Same-origin with the dev server and off the production host, so the
// analytics and error-reporting gates stay shut as they do in development.
export const PAGE_URL = "http://localhost:8000/";

// Window members copied onto globalThis, because the app reads them as bare
// identifiers (document.querySelector, navigator.serial, x instanceof Element)
// and Node resolves a bare identifier against its own global object, not the
// jsdom window. Event constructors are included so a test or module that
// builds an event gets one jsdom will dispatch.
const WINDOW_GLOBALS = Object.freeze([
  "window",
  "document",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "getComputedStyle",
  "DOMParser",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "InputEvent",
  "UIEvent",
]);

let page = null;

// Listener results collected while a dispatch is in progress; see
// collectListenerResults().
let collecting = null;

// Wraps EventTarget's add/removeEventListener in this window so that (a) every
// listener's return value can be collected, which is how a test awaits an
// async handler it triggered (a submit that fetches, a drop that reads a file),
// and (b) the listeners bound on window and document are known, so the next
// test's reset can remove them. Dispatch itself stays the library's.
function instrumentListeners(window, tracked) {
  // listener -> "type|capture" -> wrapper, so removeEventListener finds the
  // wrapper that was actually registered.
  const wrappers = new WeakMap();
  const keyOf = (type, options) => {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    return `${type}|${capture}`;
  };
  const wrapperFor = (listener, key) => {
    let byKey = wrappers.get(listener);
    if (!byKey) {
      byKey = new Map();
      wrappers.set(listener, byKey);
    }
    let wrapper = byKey.get(key);
    if (!wrapper) {
      wrapper = function instrumentedListener(event) {
        const result = typeof listener === "function"
          ? listener.call(this, event)
          : listener.handleEvent(event);
        if (collecting && result && typeof result.then === "function") {
          collecting.push(result);
        }
        return result;
      };
      byKey.set(key, wrapper);
    }
    return wrapper;
  };
  // The prototype that actually implements addEventListener for elements,
  // the document and the window (one EventTarget.prototype in jsdom).
  const owners = new Set([window.document.body, window.document, window].map((target) => {
    let proto = target;
    while (!Object.prototype.hasOwnProperty.call(proto, "addEventListener")) {
      proto = Object.getPrototypeOf(proto);
    }
    return proto;
  }));
  for (const proto of owners) {
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    proto.addEventListener = function addEventListener(type, listener, options) {
      if (!listener) {
        return add.call(this, type, listener, options);
      }
      const wrapper = wrapperFor(listener, keyOf(type, options));
      if (this === window || this === window.document) {
        tracked.push({ target: this, type, wrapper, options });
      }
      return add.call(this, type, wrapper, options);
    };
    proto.removeEventListener = function removeEventListener(type, listener, options) {
      const wrapper = listener ? wrappers.get(listener)?.get(keyOf(type, options)) : undefined;
      return remove.call(this, type, wrapper || listener, options);
    };
  }
  return () => {
    for (const { target, type, wrapper, options } of tracked.splice(0)) {
      target.removeEventListener(type, wrapper, options);
    }
  };
}

// Runs fn (which dispatches events) and returns its result together with the
// promises every listener it reached returned, so the caller can await the
// async handlers the way the browser never lets a page do.
export function collectListenerResults(fn) {
  const outer = collecting;
  collecting = [];
  try {
    const value = fn();
    return { value, results: collecting };
  } finally {
    const inner = collecting;
    collecting = outer;
    outer?.push(...inner);
  }
}

// The layout and pointer-capture APIs the UI calls that jsdom does not
// implement. Inert, as they would be on an element that is not rendered.
function addMissingLayoutApis(window) {
  const proto = window.Element.prototype;
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = function scrollIntoView() {};
  }
  if (typeof proto.setPointerCapture !== "function") {
    proto.setPointerCapture = function setPointerCapture() {};
    proto.releasePointerCapture = function releasePointerCapture() {};
    proto.hasPointerCapture = function hasPointerCapture() {
      return false;
    };
  }
}

// A listener that throws is reported by jsdom, as a browser reports it to
// window.onerror, rather than thrown out of dispatchEvent. Rethrow it outside
// the dispatch so node:test fails the running test: under the fake DOM a
// throwing listener failed the test, and nothing should start passing quietly.
function failOnListenerErrors() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (error.type === "unhandled-exception") {
      queueMicrotask(() => {
        throw error.cause;
      });
    }
  });
  return virtualConsole;
}

// Parses web/index.html into a new jsdom window. Scripts are not run and no
// subresource is fetched: the tests import the modules they exercise.
function parsePage() {
  const dom = new JSDOM(INDEX_HTML, { url: PAGE_URL, virtualConsole: failOnListenerErrors() });
  const { window } = dom;
  addMissingLayoutApis(window);
  const tracked = [];
  const removeTrackedListeners = instrumentListeners(window, tracked);
  return {
    dom,
    window,
    document: window.document,
    pristine: window.document.documentElement.cloneNode(true),
    removeTrackedListeners,
    // Property descriptors to put back at the next reset, as [object, name, descriptor|undefined].
    undo: [],
  };
}

// Defines value as an own property of target, remembering what was there.
function override(target, name, value) {
  page.undo.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
  Object.defineProperty(target, name, { configurable: true, enumerable: true, writable: true, value });
}

// Puts back every property override() replaced since the given mark, newest
// first, so a property overridden twice ends up as it started.
function undoOverrides(mark = 0) {
  for (const [target, name, descriptor] of page.undo.splice(mark).reverse()) {
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete target[name];
    }
  }
}

// Puts the reused page's document and storage back into the state index.html
// ships in. Listeners and overrides are undone separately, before this.
function resetDocument() {
  const { document, window } = page;
  document.documentElement.remove();
  document.appendChild(page.pristine.cloneNode(true));
  window.localStorage.clear();
  window.sessionStorage.clear();
  page.dom.cookieJar.removeAllCookiesSync();
  if (window.location.href !== PAGE_URL) {
    window.history.replaceState(null, "", PAGE_URL);
  }
}

// Loads (or resets) web/index.html and installs its window, document,
// navigator and the other WINDOW_GLOBALS on globalThis so the UI modules can
// be imported and booted headless. Returns the installed objects plus a
// restore() that puts the previous globals back, for a test that must not
// leak its environment into the next file in the same process.
//
// Options:
//   fresh      parse a new page instead of resetting the shared one.
//   window     extra window properties (matchMedia, innerWidth, open...).
//   navigator  extra navigator properties (clipboard, serial, onLine...).
//   globals    any further globals to define (fetch, a DOMParser stand-in...).
// Everything installed here, globals included, is undone by the next
// installIndexPage() call, so one test's stubs never reach the next.
export function installIndexPage({
  fresh = false,
  window: windowOverrides = {},
  navigator: navigatorOverrides = {},
  globals = {},
} = {}) {
  if (page) {
    undoOverrides();
    page.removeTrackedListeners();
  }
  if (!page || fresh) {
    page?.window.close();
    page = parsePage();
  } else {
    resetDocument();
  }
  const { window, document } = page;
  for (const [name, value] of Object.entries(windowOverrides)) {
    override(window, name, value);
  }
  for (const [name, value] of Object.entries(navigatorOverrides)) {
    override(window.navigator, name, value);
  }
  const globalsMark = page.undo.length;
  for (const name of WINDOW_GLOBALS) {
    override(globalThis, name, window[name]);
  }
  for (const [name, value] of Object.entries(globals)) {
    override(globalThis, name, value);
  }
  const installedPage = page;
  const restore = () => {
    if (page === installedPage) {
      undoOverrides(globalsMark);
    }
  };
  return { document, window, navigator: window.navigator, restore };
}

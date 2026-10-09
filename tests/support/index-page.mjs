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
import { afterEach } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import { REQUIRED_ELEMENTS } from "../../web/js/ui/dom.ts";
import { webDir } from "./repo-paths.mjs";

// Same-origin with the dev server and off the production host, so the
// analytics and error-reporting gates stay shut as they do in development.
export const PAGE_ORIGIN = "http://localhost:8000/";

// The markup of each web/ page parsed so far, by file name.
const pageSources = new Map();

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
//
// clientHeight is the exception that is taken away rather than added. jsdom
// answers 0 for every layout metric, and the channel grid would read a 0 as a
// real, empty viewport and render only its overscan rows. With no layout there
// is no viewport to measure, so clientHeight reads as unmeasured, which is the
// grid's headless path (visibleRowRange() in web/js/ui/channel-table.ts):
// every row is rendered and the tests see the whole grid. Row windowing itself
// is covered by the browser tests in tests/e2e. A test that wants the
// windowing arithmetic gives the viewport a height with setLayout().
function addMissingLayoutApis(window) {
  const proto = window.Element.prototype;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => undefined });
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
// the dispatch so node:test fails the running test: a listener that throws is
// a failure, not something a test may pass over quietly.
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

// Parses a page under web/ (index.html unless a test names another) into a
// new jsdom window at its own URL. Scripts are not run and no subresource is
// fetched: the tests import the modules they exercise.
function parsePage(name) {
  if (!pageSources.has(name)) {
    pageSources.set(name, fs.readFileSync(path.join(webDir, name), "utf8"));
  }
  const url = new URL(name === "index.html" ? "" : name, PAGE_ORIGIN).href;
  const dom = new JSDOM(pageSources.get(name), { url, virtualConsole: failOnListenerErrors() });
  const { window } = dom;
  addMissingLayoutApis(window);
  const tracked = [];
  const removeTrackedListeners = instrumentListeners(window, tracked);
  return {
    name,
    url,
    dom,
    window,
    document: window.document,
    pristine: window.document.documentElement.cloneNode(true),
    removeTrackedListeners,
    // Property descriptors to put back at the next reset, as [object, name, descriptor|undefined].
    undo: [],
    // The objects a test receives, as parsed: restorePageObjects() returns
    // them to this before every reuse.
    snapshots: [window, window.navigator, window.document].map((target) => [target, snapshotOwnProperties(target)]),
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

// Every own property of target, name and symbol keys alike, with its
// descriptor: what restoreOwnProperties() puts back.
function snapshotOwnProperties(target) {
  return new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]));
}

// Whether two property descriptors describe the same property.
function sameDescriptor(a, b) {
  return ["value", "get", "set", "writable", "enumerable", "configurable"].every((field) => Object.is(a[field], b[field]));
}

// Puts target's own properties back the way snapshotOwnProperties() found
// them, whatever a test did in between: a property assigned or defined since
// is deleted (unless keepAdded), and one that was replaced -- a value, a
// getter, a read-only property redefined -- or deleted is defined again from
// its snapshot. A test cannot make a stub permanent, because the restore can
// only fail on a property it made non-configurable, and that fails loudly.
function restoreOwnProperties(target, snapshot, { keepAdded = false } = {}) {
  for (const key of Reflect.ownKeys(target)) {
    const before = snapshot.get(key);
    if (!before) {
      if (!keepAdded && !Reflect.deleteProperty(target, key)) {
        throw new Error(`index-page reset cannot remove ${String(key)}: a test made it non-configurable`);
      }
      continue;
    }
    if (!sameDescriptor(before, Object.getOwnPropertyDescriptor(target, key))) {
      Object.defineProperty(target, key, before);
    }
  }
  for (const [key, before] of snapshot) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      Object.defineProperty(target, key, before);
    }
  }
}

// globalThis as the last installIndexPage() (or its restore()) left it: the
// page's globals and whatever the test had set up before installing it.
let globalBaseline = null;

// Undoes whatever a test did directly to the objects the page hands out
// (window, navigator, document): a stub it assigned or defined itself, which
// installIndexPage()'s option list never saw.
function restorePageObjects() {
  for (const [target, snapshot] of page.snapshots) {
    restoreOwnProperties(target, snapshot);
  }
}

// At the end of every test in a file that uses the page, put back the page's
// objects and every global the test changed after installing the page (a
// fetch or navigator stub, say), so no stub reaches the next test. It runs as
// an afterEach hook rather than at the next install because only the test
// boundary says whose a change is: a stub a test set before installing the
// page (a fetch, mocked timers) is part of that test's baseline and stays for
// the rest of it. node:test runs afterEach before a test's own t.after hooks
// and before it resets t.mock, so both still find what they set up. Globals
// added since the install are kept: they are module and runtime state a file
// shares on purpose (the Pyodide harness's serial_* bridge, the app's
// currentRows), and removing them would strand a memoized runtime.
afterEach(() => {
  if (!page) {
    return;
  }
  restorePageObjects();
  restoreOwnProperties(globalThis, globalBaseline, { keepAdded: true });
});

// Puts the reused page's document and storage back into the state index.html
// ships in. Listeners and overrides are undone separately, before this.
function resetDocument() {
  const { document, window } = page;
  document.documentElement.remove();
  document.appendChild(page.pristine.cloneNode(true));
  window.localStorage.clear();
  window.sessionStorage.clear();
  page.dom.cookieJar.removeAllCookiesSync();
  if (window.location.href !== page.url) {
    window.history.replaceState(null, "", page.url);
  }
}

// Loads (or resets) web/index.html and installs its window, document,
// navigator and the other WINDOW_GLOBALS on globalThis so the UI modules can
// be imported and booted headless. Returns the installed objects plus a
// restore() that puts the previous globals back, for a test that must not
// leak its environment into the next file in the same process.
//
// Options:
//   page       another page under web/ (serial-test.html), for the modules
//              that belong to it; switching pages parses the new one.
//   url        the address the page is at, relative to it ("?radio=uv5r:X"),
//              for code that reads location; reset with the page.
//   fresh      parse a new page instead of resetting the shared one.
//   window     extra window properties (matchMedia, innerWidth, open...).
//   navigator  extra navigator properties (clipboard, serial, onLine...).
//   globals    any further globals to define (fetch, a DOMParser stand-in...).
// Everything installed here, globals included, is undone by the next
// installIndexPage() call, and a stub a test assigns straight onto the
// window, navigator, document or a global after installing the page is undone
// when the test ends (the afterEach hook above), so one test's stubs never
// reach the next.
export function installIndexPage({
  page: pageName = "index.html",
  url = null,
  fresh = false,
  window: windowOverrides = {},
  navigator: navigatorOverrides = {},
  globals = {},
} = {}) {
  if (page) {
    undoOverrides();
    page.removeTrackedListeners();
    restorePageObjects();
  }
  if (!page || fresh || page.name !== pageName) {
    page?.window.close();
    page = parsePage(pageName);
  } else {
    resetDocument();
  }
  const { window, document } = page;
  if (url !== null) {
    window.history.replaceState(null, "", new URL(url, page.url).href);
  }
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
      globalBaseline = snapshotOwnProperties(globalThis);
    }
  };
  globalBaseline = snapshotOwnProperties(globalThis);
  return { document, window, navigator: window.navigator, restore };
}

// The installed page's element for a web/js/ui/dom.ts name
// (pageElement("radioDownloadEl")), for a test that hands a module a ctx.dom
// of a few elements rather than booting the whole UI.
export function pageElement(name) {
  const selector = REQUIRED_ELEMENTS[name];
  if (!selector) {
    throw new Error(`web/js/ui/dom.ts declares no element named ${name}`);
  }
  return page.document.querySelector(selector);
}

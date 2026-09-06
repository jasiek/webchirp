// Shared fake DOM for the headless UI tests. The UI modules under web/js/ui
// only ever touch a small slice of the DOM API (create/append elements, set
// text and attributes, toggle classes, listen for and dispatch events, walk up
// to a delegating ancestor), so a few hundred lines stand in for a browser
// without pulling jsdom into the test suite. Every UI test used to carry its
// own copy of this with slightly different holes; this module is the union of
// those copies so a behaviour fixed here is fixed for every test at once.
//
// Fidelity is deliberately partial: there is no event bubbling (tests dispatch
// at the element that delegates, with `target` set, which is what a real
// browser hands that listener) and no layout (getBoundingClientRect() is all
// zeros unless a test overrides it).

// Mirrors DOMTokenList closely enough for classList.add/remove/toggle/contains.
// A real Set rather than no-op stubs, because several modules keep their
// open/closed state in a "hidden" class and the tests read it back.
export class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.classes.add(String(token)));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.classes.delete(String(token)));
  }

  toggle(token, force) {
    const key = String(token);
    if (force === true) {
      this.classes.add(key);
      return true;
    }
    if (force === false) {
      this.classes.delete(key);
      return false;
    }
    if (this.classes.has(key)) {
      this.classes.delete(key);
      return false;
    }
    this.classes.add(key);
    return true;
  }

  contains(token) {
    return this.classes.has(String(token));
  }

  toString() {
    return Array.from(this.classes).join(" ");
  }
}

// Attributes the UI sets as properties (input.name = "band") but then queries
// as attributes (input[name="band"]); the real DOM reflects these both ways.
const REFLECTED_ATTRIBUTES = ["id", "name", "type", "title", "placeholder"];

// Parses one compound selector ("li[role='option']", "input.foo:checked",
// "#id", "[data-row-idx]") into the pieces matchesCompound() checks. Throws on
// anything it does not understand: a selector that silently matched nothing
// would let a test pass against an element the UI never found.
function parseCompound(compound) {
  const parsed = { tag: null, id: null, classes: [], attributes: [], checked: false };
  let rest = compound.trim();
  const tag = rest.match(/^([a-zA-Z][\w-]*|\*)/);
  if (tag) {
    parsed.tag = tag[1] === "*" ? null : tag[1].toUpperCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let match = rest.match(/^#([\w-]+)/);
    if (match) {
      parsed.id = match[1];
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^\.([\w-]+)/);
    if (match) {
      parsed.classes.push(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/);
    if (match) {
      parsed.attributes.push({ name: match[1], value: match[2] ?? match[3] ?? null });
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^:checked/);
    if (match) {
      parsed.checked = true;
      rest = rest.slice(match[0].length);
      continue;
    }
    throw new Error(`FakeElement cannot match selector: ${compound}`);
  }
  return parsed;
}

// Splits a selector list on commas and keeps only the rightmost compound of
// each part. The fakes have no document tree to scope by, so ".left-panel
// button" is matched as "button" — which is what every test that queried a
// scoped collection relied on.
function parseSelectorList(selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseCompound(part.split(/\s+/).at(-1)));
}

const EMPTY_RECT = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });

// The element stand-in. Constructed either directly by a test building a
// fixture or via FakeDocument.createElement()/querySelector(). Everything the
// UI modules read or write is a plain property except value, textContent,
// innerHTML and className, whose accessors keep the same invariants a browser
// would (setting innerHTML empties the children, a <select> answers with its
// first option, className and classList are one thing).
export class FakeElement {
  constructor(tagName = "div", ownerDocument = null, id = "") {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.eventListeners = new Map();
    this.classList = new FakeClassList();
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.checked = false;
    this.focused = false;
    this.type = "";
    this.name = "";
    this.title = "";
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientWidth = 0;
    this.offsetHeight = 0;
    this._value = "";
    this._textContent = "";
    this._innerHTML = "";
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList.classes = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  // A <progress> reflects .value to its value attribute, and removing that
  // attribute is what makes the bar indeterminate — the tests observe that
  // through hasAttribute("value"). A <select> with nothing chosen reports its
  // first option, as the browser does.
  get value() {
    if (this.tagName === "PROGRESS") {
      return this.attributes.get("value") ?? "";
    }
    if (this.tagName === "SELECT" && !this._value) {
      return this.children[0]?.value || "";
    }
    return this._value;
  }

  set value(next) {
    if (this.tagName === "PROGRESS") {
      this.attributes.set("value", String(next));
      return;
    }
    this._value = String(next ?? "");
  }

  // Own text followed by the children's, so a list item made of spans reads
  // as one string the way it does in a browser.
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(next) {
    this._textContent = String(next ?? "");
    this._innerHTML = "";
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(next) {
    this._innerHTML = String(next ?? "");
    this._textContent = "";
    this._value = "";
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    const key = String(name);
    if (this.attributes.has(key)) {
      return this.attributes.get(key);
    }
    if (REFLECTED_ATTRIBUTES.includes(key) && this[key] !== "" && this[key] !== undefined) {
      return String(this[key]);
    }
    return null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  // Moves the child as a browser would, so a row re-appended after a
  // re-render is not listed under two parents.
  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === "SELECT" && !this._value) {
      this._value = child.value || "";
    }
    return child;
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) {
      return this.appendChild(child);
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((each) => each !== child);
    if (child.parentNode === this) {
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(target) {
    if (target === this) {
      return true;
    }
    return this.children.some((child) => child.contains(target));
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.eventListeners.get(String(type));
    if (handlers) {
      this.eventListeners.set(String(type), handlers.filter((each) => each !== handler));
    }
  }

  // Calls this element's listeners for event.type with the event as given.
  // No bubbling: dispatch at the delegating ancestor with `target` set.
  dispatchEvent(event) {
    for (const handler of this.eventListeners.get(String(event?.type || "")) || []) {
      handler(event);
    }
    return true;
  }

  // Convenience over dispatchEvent(): builds the event from a type plus
  // overrides and returns the handlers' results as one promise, so a test can
  // await an async listener (a form submit that fetches, say) before asserting.
  dispatch(type, init = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...init };
    const handlers = this.eventListeners.get(String(type)) || [];
    return Promise.all(handlers.map((handler) => handler(event)));
  }

  // A programmatic click reaches the click listeners, as in a browser; the
  // debug-panel tests toggle the disclosure this way.
  click() {
    this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {} });
  }

  focus() {
    this.focused = true;
  }

  blur() {
    this.focused = false;
  }

  select() {}

  scrollIntoView() {}

  getBoundingClientRect() {
    return { ...EMPTY_RECT };
  }

  matches(selector) {
    return parseSelectorList(selector).some((compound) => this.matchesCompound(compound));
  }

  matchesCompound({ tag, id, classes, attributes, checked }) {
    if (tag && this.tagName !== tag) {
      return false;
    }
    if (id && this.id !== id) {
      return false;
    }
    if (!classes.every((name) => this.classList.contains(name))) {
      return false;
    }
    if (checked && !this.checked) {
      return false;
    }
    return attributes.every(({ name, value }) => {
      const dataKey = name.startsWith("data-")
        ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
        : null;
      const actual = dataKey !== null && this.dataset[dataKey] !== undefined
        ? String(this.dataset[dataKey])
        : this.getAttribute(name);
      return value === null ? actual !== null : actual === value;
    });
  }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (node.matches?.(selector)) {
        return node;
      }
    }
    return null;
  }

  // Descendants in document order that match the selector.
  querySelectorAll(selector) {
    const compounds = parseSelectorList(selector);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (compounds.some((compound) => child.matchesCompound(compound))) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

// Elements web/js/ui/dom.js requires that are stubbed with their real tag,
// because the tag is load-bearing somewhere: sidebarControlEls filters on
// BUTTON/INPUT, a <select> answers with its first option, a <progress>
// reflects value to an attribute. Anything else the UI queries auto-vivifies
// as a div. Every entry must be an element dom.js declares —
// test-ui-radio-loading.mjs pins that so a removed id fails loudly.
export const UI_STUBBED_SELECTORS = new Map([
  ["#mem-table thead", "thead"],
  ["#mem-table tbody", "tbody"],
  ["#channel-editor", "div"],
  ["#settings-editor", "div"],
  ["#view-channels", "button"],
  ["#view-settings", "button"],
  ["#settings-tabs", "div"],
  ["#settings-summary", "div"],
  ["#settings-empty", "div"],
  ["#settings-content", "div"],
  ["#csv-file", "input"],
  ["#img-file", "input"],
  ["#debug-output", "textarea"],
  ["#report-issue", "button"],
  ["#live-radio-support-warning", "p"],
  ["#radio-search", "input"],
  ["#radio-search-results", "ul"],
  ["#serial-connect-toggle", "button"],
  ["#radio-download", "button"],
  ["#radio-upload", "button"],
  ["#clone-progress-bar", "progress"],
  ["#app-progress-bar", "progress"],
  ["#channel-insert", "button"],
  ["#channel-remove", "button"],
  ["#channel-menu-toggle", "button"],
  ["#channel-menu-popup", "div"],
  ["#channel-add-gmrs", "button"],
  ["#channel-add-frs", "button"],
  ["#channel-add-pmr446", "button"],
  ["#channel-import-przemienniki", "button"],
  ["#channel-import-repeaterbook", "button"],
  ["#channel-import-irts", "button"],
  ["#repeater-query-form", "form"],
  ["#repeater-query-cancel", "button"],
  ["#import-csv", "button"],
  ["#export-csv", "button"],
  ["#export-binary", "button"],
  ["#import-binary", "button"],
  ["#debug-clear", "button"],
]);

// Default vivification rule: index.html always provides every #id element
// dom.js requires, so an unregistered id stands for markup the test does not
// care about, not a missing element. Anything that is not an id lookup (the
// repeater-API meta tag, say) resolves to null unless the test registered it,
// matching a genuinely absent element.
function vivifyIdsOnly(selector) {
  return selector.startsWith("#") ? UI_STUBBED_SELECTORS.get(selector) || "div" : null;
}

// The document stand-in: a registry of elements by selector plus the handful
// of document-level calls the UI makes. Tests register the elements they
// assert on; everything else comes from the vivify rule.
export class FakeDocument {
  constructor({ vivify = vivifyIdsOnly } = {}) {
    this.elements = new Map();
    this.eventListeners = new Map();
    this.cookie = "";
    this.vivify = vivify;
    this.body = new FakeElement("body", this);
    this.activeElement = null;
  }

  register(selector, element) {
    this.elements.set(String(selector), element);
    return element;
  }

  querySelector(selector) {
    const key = String(selector);
    if (!this.elements.has(key)) {
      const tagName = this.vivify(key);
      if (!tagName) {
        return null;
      }
      const id = key.match(/^#([\w-]+)$/)?.[1] || "";
      this.elements.set(key, new FakeElement(tagName, this, id));
    }
    return this.elements.get(key);
  }

  // Registered elements matching the selector list. There is no tree to
  // scope by, so ".left-panel button" is every registered button.
  querySelectorAll(selector) {
    const compounds = parseSelectorList(selector);
    const seen = new Set();
    return Array.from(this.elements.values()).filter((element) => {
      if (seen.has(element) || !compounds.some((compound) => element.matchesCompound(compound))) {
        return false;
      }
      seen.add(element);
      return true;
    });
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key).push(handler);
  }

  dispatchEvent(event) {
    for (const handler of this.eventListeners.get(String(event?.type || "")) || []) {
      handler(event);
    }
    return true;
  }
}

// The window stand-in records its listeners so a test can fire the
// window-level events the UI listens for (drag-and-drop lands on window).
// emit() awaits each handler and resolves to whether any called
// preventDefault(), which is what decides between "the app takes this drag"
// and "the browser navigates away from the app".
export class FakeWindow {
  constructor(overrides = {}) {
    this.listeners = new Map();
    Object.assign(this, overrides);
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(String(type));
    if (handlers) {
      this.listeners.set(String(type), handlers.filter((each) => each !== handler));
    }
  }

  open() {}

  getSelection() {
    return null;
  }

  async emit(type, event) {
    let defaultPrevented = false;
    for (const handler of this.listeners.get(String(type)) || []) {
      await handler({
        ...event,
        type,
        preventDefault() {
          defaultPrevented = true;
        },
      });
    }
    return defaultPrevented;
  }
}

const GLOBAL_NAMES = ["document", "window", "navigator", "CSS", "Node"];

// Installs document/window/navigator/CSS/Node on globalThis so the UI modules
// can be imported and booted headless. Returns the installed objects plus a
// restore() that puts the previous globals back for tests that must not leak
// their environment into the next file in the same process.
//
// Options:
//   vivify(selector)  overrides which unregistered selectors resolve to a new
//                     element (return a tag name) or null.
//   window            extra window properties (matchMedia, innerWidth...).
//   navigator         extra navigator properties (clipboard, maxTouchPoints...).
//   globals           any further globals to define (DOMParser, fetch...).
export function installFakeDom({ vivify, window: windowOverrides = {}, navigator: navigatorOverrides = {}, globals = {} } = {}) {
  const document = new FakeDocument(vivify ? { vivify } : {});
  const window = new FakeWindow(windowOverrides);
  const navigator = {
    userAgent: "FakeBrowser/1.0",
    language: "en-US",
    appVersion: "FakeBrowser/1.0",
    ...navigatorOverrides,
  };
  const installed = {
    document,
    window,
    navigator,
    CSS: { escape: (value) => String(value) },
    Node: FakeElement,
    ...globals,
  };
  const previous = new Map();
  for (const name of Object.keys(installed)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: installed[name] });
  }
  const restore = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  };
  return { document, window, navigator, restore };
}

// A promise a test resolves by hand, to hold a runtime call (a clipboard
// write, a metadata fetch) in flight while asserting on the intermediate UI.
export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

// Lets every already-resolved promise in a load chain settle. setImmediate
// runs after the microtask queue drains, which is what the UI's chained
// awaits need before their effects are visible.
export function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// A keydown event carrying the key with the no-op methods the handlers call.
export function keydownEvent(key) {
  return { type: "keydown", key, preventDefault() {}, stopPropagation() {} };
}

// Types into the radio search box the way a user does, which opens the
// suggestion list without selecting anything.
export function typeRadioSearch(document, query) {
  const searchEl = document.querySelector("#radio-search");
  searchEl.value = query;
  searchEl.dispatchEvent({ type: "input" });
  return searchEl;
}

// Picks a radio the way the UI requires: type into the search box and accept
// the pre-highlighted first suggestion with Enter. Without this no radio is
// selected, so the driver's column metadata is never fetched.
export function selectRadioBySearch(document, query) {
  typeRadioSearch(document, query).dispatchEvent(keydownEvent("Enter"));
}

// Drives the Import CSV path the way the file picker does: hand the hidden
// input a file and fire the change event it listens for. The stubbed parser
// decides what rows come back, so the file's text is irrelevant.
export async function importSampleCsv(document, name = "sample.csv") {
  const fileInput = document.querySelector("#csv-file");
  fileInput.files = [{ name, text: async () => "" }];
  fileInput.dispatchEvent({ type: "change" });
  await flushMicrotasks();
}

// The grid renders spacer rows around the windowed channel rows, so the
// channel rows are the ones carrying a row index.
export function channelRows(document) {
  const tbody = document.querySelector("#mem-table tbody");
  return tbody.children.filter((tr) => tr.dataset.rowIdx !== undefined);
}

// The Name column's editor value for every rendered channel row.
export function tableNames(document) {
  return channelRows(document).map((tr) => tr.children[1]?.children[0]?.value ?? "");
}

// Clicks a row's Location button. Cell events are delegated to the tbody, so
// dispatch there with the button as the target, which is what bubbling gives
// the handler in a real browser. Modifier keys select ranges.
export function clickLocationButton(document, rowIdx, modifiers = {}) {
  const tbody = document.querySelector("#mem-table tbody");
  const button = channelRows(document)[rowIdx].children[0].children[0];
  tbody.dispatchEvent({
    type: "click",
    target: button,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...modifiers,
  });
}

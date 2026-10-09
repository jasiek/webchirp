// What a user does to the page, and what a test reads back from it, for the
// headless UI tests that run on web/index.html in jsdom
// (tests/support/index-page.mjs): typing into the radio search, picking a
// file, clicking a row's Location button, reading the channel grid. Events
// are real events dispatched at the element the user would touch; they bubble
// and the UI's delegated listeners receive them as they do in a browser.
//
// dispatch() and emit() also await whatever the listeners they reached
// returned, which no browser does but which lets a test wait for an async
// handler (a submit that fetches, a drop that reads a file) before asserting.
import { collectListenerResults } from "./index-page.mjs";

// Event types that do not bubble or cannot be cancelled in a browser, so a
// synthetic one behaves like the real one.
const NON_BUBBLING = new Set([
  "focus", "blur", "load", "scroll", "resize", "toggle",
  "mouseenter", "mouseleave", "pointerenter", "pointerleave",
]);
const KEYBOARD = new Set(["keydown", "keyup", "keypress"]);
const MOUSE = new Set([
  "click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout",
  "mouseenter", "mouseleave",
]);
const POINTER = new Set([
  "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave",
  "pointercancel", "lostpointercapture", "gotpointercapture",
]);
const FOCUS = new Set(["focus", "blur", "focusin", "focusout"]);

// Builds a real event of the class a browser would use for this type, from
// the page currently installed on globalThis. init carries the event's
// properties: constructor fields (key, shiftKey, clientX...) go to the
// constructor; anything the class has no field for (dataTransfer,
// clipboardData) is defined on the instance, which is how a test hands a
// drop its files. A target cannot be set on a real event: dispatch at the
// element instead and let the event bubble.
export function domEvent({ type, ...init }) {
  if ("target" in init) {
    throw new Error(`domEvent("${type}"): dispatch at the target element instead of setting target`);
  }
  for (const method of ["preventDefault", "stopPropagation", "stopImmediatePropagation"]) {
    if (method in init) {
      throw new Error(`domEvent("${type}"): the event has a real ${method}(); read defaultPrevented or listen instead`);
    }
  }
  const win = globalThis.window;
  const options = { bubbles: !NON_BUBBLING.has(type), cancelable: !NON_BUBBLING.has(type), ...init };
  let EventClass = win.Event;
  if (KEYBOARD.has(type)) {
    EventClass = win.KeyboardEvent;
  } else if (POINTER.has(type)) {
    EventClass = win.PointerEvent;
  } else if (MOUSE.has(type)) {
    EventClass = win.MouseEvent;
  } else if (FOCUS.has(type)) {
    EventClass = win.FocusEvent;
  } else if (type === "input" || type === "beforeinput") {
    EventClass = win.InputEvent;
  }
  const event = new EventClass(type, options);
  for (const [name, value] of Object.entries(init)) {
    if (event[name] !== value) {
      Object.defineProperty(event, name, { configurable: true, value });
    }
  }
  return event;
}

// Dispatches a real event of the given type at target and resolves once every
// listener it reached has settled, with the event itself. init is as for
// domEvent(). Listener rejections reject the returned promise.
export async function dispatch(target, type, init = {}) {
  const event = domEvent({ type, ...init });
  const { results } = collectListenerResults(() => target.dispatchEvent(event));
  await Promise.all(results);
  return event;
}

// Fires a window-level event (drag-and-drop, online/offline, keydown that
// reaches window) and resolves, once the listeners have settled, to whether
// one of them called preventDefault() during dispatch -- which for a drop is
// the difference between "the app takes it" and "the browser navigates away".
// Read synchronously, as the browser reads it: a preventDefault() after an
// await is too late in a browser, and is too late here.
export async function emit(target, type, init = {}) {
  const event = domEvent({ type, ...init });
  const { value: notCancelled, results } = collectListenerResults(() => target.dispatchEvent(event));
  await Promise.all(results);
  return !notCancelled;
}

// The Debug Output panel's elements from the page, in the folded state
// index.html ships them in, keyed as createDebugLog expects them.
export function debugPanelElements(document = globalThis.document) {
  const element = (id) => document.getElementById(id);
  return {
    debugToggleEl: element("debug-toggle"),
    debugActionsEl: element("debug-actions"),
    debugOutputContentEl: element("debug-output-content"),
    debugOutputEl: element("debug-output"),
    debugClearEl: element("debug-clear"),
    debugCopyEl: element("debug-copy"),
  };
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

// A keydown event carrying the key, as a keyboard produces it: it bubbles
// and can be cancelled.
export function keydownEvent(key, init = {}) {
  return domEvent({ type: "keydown", key, ...init });
}

// Types into the radio search box the way a user does, which opens the
// suggestion list without selecting anything.
export function typeRadioSearch(document, query) {
  const searchEl = document.querySelector("#radio-search");
  searchEl.value = query;
  searchEl.dispatchEvent(domEvent({ type: "input" }));
  return searchEl;
}

// Picks a radio the way the UI requires: type into the search box and accept
// the pre-highlighted first suggestion with Enter. Without this no radio is
// selected, so the driver's column metadata is never fetched.
export function selectRadioBySearch(document, query) {
  typeRadioSearch(document, query).dispatchEvent(keydownEvent("Enter"));
}

// Drives the Load CSV path the way the file picker does: hand the hidden
// input a file and fire the change event it listens for. The stubbed parser
// decides what rows come back, so the file's text is irrelevant. A real
// input's files is a read-only FileList, so the list is defined on the
// element.
export async function importSampleCsv(document, name = "sample.csv") {
  const fileInput = document.querySelector("#codeplug-file");
  setInputFiles(fileInput, [{ name, text: async () => "" }]);
  fileInput.dispatchEvent(domEvent({ type: "change" }));
  await flushMicrotasks();
}

// Gives a file input the files a picker would, as a test-owned list: jsdom
// has no way to build a FileList, and the UI only indexes and iterates it.
export function setInputFiles(input, files) {
  Object.defineProperty(input, "files", { configurable: true, value: files });
}

// Gives an element the layout metrics a browser would have computed for it
// (clientWidth, clientHeight, scrollHeight, offsetHeight...). jsdom does no
// layout, so these read 0 unless a test that depends on a size states it.
export function setLayout(element, metrics) {
  for (const [name, value] of Object.entries(metrics)) {
    Object.defineProperty(element, name, { configurable: true, writable: true, value });
  }
}

// The grid renders spacer rows around the windowed channel rows, so the
// channel rows are the ones carrying a row index.
export function channelRows(document) {
  const tbody = document.querySelector("#mem-table tbody");
  return Array.from(tbody.children).filter((tr) => tr.dataset.rowIdx !== undefined);
}

// The Name column's editor value for every rendered channel row.
export function tableNames(document) {
  return channelRows(document).map((tr) => tr.children[1]?.children[0]?.value ?? "");
}

// Clicks a row's Location button. The click bubbles to the tbody, where the
// grid delegates cell events. Modifier keys select ranges.
export function clickLocationButton(document, rowIdx, modifiers = {}) {
  const button = channelRows(document)[rowIdx].children[0].children[0];
  button.dispatchEvent(domEvent({ type: "click", ...modifiers }));
}

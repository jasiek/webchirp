import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { createDeferred, flushMicrotasks } from "../support/ui-interactions.mjs";
import { ELEMENT_COLLECTIONS, REQUIRED_ELEMENTS } from "../../web/js/ui/dom.ts";
import { markBootstrapFailure } from "../../web/js/runtime-bootstrap.ts";

// index.html is what the user looks at while Pyodide boots, and what they are
// left with when it never does: the grid, the radio search and the clone
// controls only change once init() hears back from the runtime, and a failed
// init() changes none of them. So every element the UI shows, hides, enables
// or disables ships in its pre-runtime state: the "No channels loaded" notice
// once shipped hidden, which left the channel panel blank until the runtime
// was up.

// Every element the UI can reach: the ones it queries by name and by group
// (web/js/ui/dom.ts), plus anything the markup itself ships hidden or
// disabled, which only script can change.
function toggleableElements(document) {
  const elements = new Set();
  for (const selector of Object.values(REQUIRED_ELEMENTS)) {
    elements.add(document.querySelector(selector));
  }
  for (const selector of Object.values(ELEMENT_COLLECTIONS)) {
    for (const element of document.querySelectorAll(selector)) {
      elements.add(element);
    }
  }
  for (const element of document.body.querySelectorAll("[hidden], [disabled], .hidden")) {
    elements.add(element);
  }
  return [...elements];
}

function describe(element) {
  if (element.id) {
    return `#${element.id}`;
  }
  const parent = element.parentElement?.closest("[id]");
  const classes = String(element.className || "").split(" ").filter(Boolean);
  return `${parent ? `#${parent.id} ` : ""}${element.tagName.toLowerCase()}`
    + classes.map((name) => `.${name}`).join("");
}

// What the user can see and press, per element: the hidden attribute, the
// modal overlays' hidden class, and disabled where the element has one.
function visibility(elements) {
  return Object.fromEntries(elements.map((element) => [describe(element), {
    hidden: element.hidden,
    hiddenClass: element.classList.contains("hidden"),
    disabled: "disabled" in element ? element.disabled : null,
  }]));
}

// The entries of now that differ from the markup.
function changesFrom(markup, now) {
  return Object.fromEntries(Object.entries(now).filter(
    ([name, state]) => JSON.stringify(state) !== JSON.stringify(markup[name]),
  ));
}

// What init() changes before its first runtime call, from what the page knows
// without one: the driver-set link the URL calls for (the default CHIRP set
// offers the unofficial Quansheng one), and the connect buttons for the
// transports this browser has, shown but still disabled. Nothing here waits
// for Pyodide, so the markup cannot be its boot state; everything else's is.
const SET_BEFORE_THE_RUNTIME = {
  "#use-quansheng-drivers": { hidden: false, hiddenClass: false, disabled: null },
  "#serial-connect-webbluetooth": { hidden: false, hiddenClass: false, disabled: true },
};

async function bootUntilRuntimeAnswers() {
  const { document } = installIndexPage();
  const elements = toggleableElements(document);
  const markup = visibility(elements);
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  // listRadios is init()'s first runtime call, the one that boots Pyodide.
  const boot = createDeferred();
  ui.setRuntimeApi({ listRadios: () => boot.promise });
  // As web/app.ts hands it over: a browser with every transport.
  ui.setSerialController({
    capability: { supported: true, native: true, webusb: true, webbluetooth: true },
    async choosePort() {},
  });
  const initialized = ui.init(true);
  await flushMicrotasks();
  return { document, elements, markup, boot, initialized };
}

test("the markup is the boot state of every element the UI toggles", async () => {
  const { elements, markup, boot, initialized } = await bootUntilRuntimeAnswers();
  // A derived set that found nothing would pass vacuously.
  assert.ok(elements.length > 100, `only ${elements.length} toggleable elements found`);

  assert.deepEqual(changesFrom(markup, visibility(elements)), SET_BEFORE_THE_RUNTIME);

  boot.reject(markBootstrapFailure(new Error("Pyodide failed to load")));
  await initialized;
});

test("a failed boot leaves the markup defaults, with the error in Debug Output", async () => {
  const { document, elements, markup, boot, initialized } = await bootUntilRuntimeAnswers();
  boot.reject(markBootstrapFailure(new Error("Pyodide failed to load")));
  await initialized;

  // The failure is logged, and logging an error opens the debug panel: the
  // only thing a failed boot reveals.
  assert.deepEqual(changesFrom(markup, visibility(elements)), {
    ...SET_BEFORE_THE_RUNTIME,
    "#debug-actions": { hidden: false, hiddenClass: false, disabled: null },
    "#debug-output-content": { hidden: false, hiddenClass: false, disabled: null },
  });
  assert.match(document.querySelector("#debug-output").value, /INITIALIZATION ERROR/);

  // Which leaves nothing that needs the runtime usable: no radio can be
  // searched for, no port opened and no clone started.
  for (const id of ["#radio-search", "#serial-connect-toggle", "#serial-connect-webusb",
    "#serial-connect-webbluetooth", "#radio-download", "#radio-upload", "#view-settings"]) {
    assert.equal(document.querySelector(id).disabled, true, `${id} is usable after a failed boot`);
  }
  assert.equal(document.querySelector("#channel-empty-state").hidden, false);
});

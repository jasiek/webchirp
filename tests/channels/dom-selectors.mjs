import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ELEMENT_COLLECTIONS, REQUIRED_ELEMENTS } from "../../web/js/ui/dom.ts";
import { installIndexPage } from "../support/index-page.mjs";

// Guards the contract between index.html and web/js/ui/dom.ts: every element the
// UI declares as required must actually exist in the page. Renaming or removing
// an id without updating dom.ts is otherwise invisible until someone clicks the
// control that no longer works — which is how the #serial-transaction handler
// survived long after its markup was deleted.
//
// The page is index.html parsed by jsdom (tests/support/index-page.mjs), the
// same page every headless UI test runs on, so a selector is resolved exactly
// as the browser resolves it: any selector shape dom.ts uses is checked, and
// nothing stands in for an element the page lacks.

test("every required UI element exists in index.html", () => {
  const { document } = installIndexPage();
  const missing = Object.entries(REQUIRED_ELEMENTS)
    .filter(([, selector]) => document.querySelector(selector) === null)
    .map(([name, selector]) => `${name} -> ${selector}`);

  assert.deepEqual(missing, [], "index.html is missing elements that web/js/ui/dom.ts requires");
});

test("required element names and selectors are unique", () => {
  const selectors = Object.values(REQUIRED_ELEMENTS);
  const duplicates = selectors.filter((s, i) => selectors.indexOf(s) !== i);
  assert.deepEqual(duplicates, [], "the same selector is bound to two names");
});

test("each required selector names exactly one element", () => {
  // querySelector takes the first match, so a selector that matches twice
  // binds whichever comes first in the markup and silently ignores the other.
  const { document } = installIndexPage();
  const ambiguous = Object.entries(REQUIRED_ELEMENTS)
    .filter(([, selector]) => document.querySelectorAll(selector).length > 1)
    .map(([name, selector]) => `${name} -> ${selector}`);
  assert.deepEqual(ambiguous, [], "these selectors match more than one element in index.html");
});

test("collection selectors match markup that exists", () => {
  const { document } = installIndexPage();
  for (const [name, selector] of Object.entries(ELEMENT_COLLECTIONS)) {
    // A renamed container would quietly yield an empty list.
    assert.ok(document.querySelectorAll(selector).length > 0, `${name}: ${selector} matches nothing in index.html`);
  }
});

test("queryUiElements reports every missing element at once", async () => {
  const { queryUiElements } = await import("../../web/js/ui/dom.ts");
  // A page with exactly one of the required elements present. The next
  // installIndexPage() puts index.html back.
  const { document } = installIndexPage();
  document.documentElement.innerHTML = '<head></head><body><input id="radio-search"></body>';
  assert.throws(
    () => queryUiElements(),
    (error) => {
      const total = Object.keys(REQUIRED_ELEMENTS).length;
      assert.match(error.message, /index\.html is missing/);
      // Every missing element is named, not just the first one.
      assert.match(error.message, new RegExp(`missing ${total - 1} required`));
      assert.match(error.message, /tableHead -> #mem-table thead/);
      assert.ok(
        !error.message.includes("radioSearchEl"),
        "elements that resolved should not be reported missing",
      );
      return true;
    },
  );
});

// #debug-actions is toggled hidden with the Debug Output disclosure, so any
// control that must stay reachable while the panel is folded has to live
// outside it. Report Bug is that control: a user who cannot open the panel is
// exactly the user with something to report.
test("Report Bug sits outside the collapsible debug actions", () => {
  const { document } = installIndexPage();
  const actions = document.querySelector("#debug-actions");
  assert.ok(actions, "index.html has no #debug-actions container");
  assert.ok(
    !actions.contains(document.querySelector("#report-issue")),
    "#report-issue is inside #debug-actions and disappears when Debug Output is folded",
  );
  assert.ok(
    actions.hidden,
    "#debug-actions is expected to start hidden; this test's premise no longer holds",
  );
});

// The element interface each tag stands for in UiElementTypes
// (web/js/ui/dom.ts); any tag not listed is a plain HTMLElement there.
const TAG_INTERFACES = Object.freeze({
  a: "HTMLAnchorElement",
  button: "HTMLButtonElement",
  canvas: "HTMLCanvasElement",
  details: "HTMLDetailsElement",
  dialog: "HTMLDialogElement",
  form: "HTMLFormElement",
  img: "HTMLImageElement",
  input: "HTMLInputElement",
  label: "HTMLLabelElement",
  ol: "HTMLOListElement",
  pre: "HTMLPreElement",
  progress: "HTMLProgressElement",
  select: "HTMLSelectElement",
  table: "HTMLTableElement",
  tbody: "HTMLTableSectionElement",
  textarea: "HTMLTextAreaElement",
  thead: "HTMLTableSectionElement",
  ul: "HTMLUListElement",
});

// UiElementTypes is what npm run check:js trusts for every dom.* member: a
// button typed HTMLElement hides .disabled from the checker, and a div typed
// HTMLButtonElement lets code call what the element does not have. It is a
// type, so nothing ties it to the markup but this test.
test("the element types dom.ts declares match index.html's tags", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "web", "js", "ui", "dom.ts"), "utf8");
  const block = source.match(/^export type UiElementTypes = \{\n([\s\S]*?)\n\};/m);
  assert.ok(block, "web/js/ui/dom.ts no longer declares UiElementTypes in the expected shape");
  const declared = Object.fromEntries(
    [...block[1].matchAll(/^\s+(\w+): (\w+);$/gm)].map(([, name, type]) => [name, type]),
  );
  const { document, window } = installIndexPage();
  const wrong = [];
  for (const [name, selector] of Object.entries(REQUIRED_ELEMENTS)) {
    const element = document.querySelector(selector);
    const tag = element.tagName.toLowerCase();
    const expected = TAG_INTERFACES[tag] || "HTMLElement";
    const actual = declared[name] || "HTMLElement";
    if (actual !== expected || !(element instanceof window[actual])) {
      wrong.push(`${name} (${selector}) is <${tag}>: expected ${expected}, declared ${actual}`);
    }
  }
  const unknown = Object.keys(declared).filter((name) => !(name in REQUIRED_ELEMENTS));
  assert.deepEqual(unknown, [], "UiElementTypes names elements REQUIRED_ELEMENTS does not");
  assert.deepEqual(wrong, [], "update UiElementTypes in web/js/ui/dom.ts to the markup");
});

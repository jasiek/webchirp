import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ELEMENT_COLLECTIONS, REQUIRED_ELEMENTS } from "../../web/js/ui/dom.js";
import { FakeDocument } from "../support/fake-dom.mjs";

// Guards the contract between index.html and web/js/ui/dom.js: every element the
// UI declares as required must actually exist in the page. Renaming or removing
// an id without updating dom.js is otherwise invisible until someone clicks the
// control that no longer works — which is how the #serial-transaction handler
// survived long after its markup was deleted.
const HTML = fs.readFileSync(
  path.join(process.cwd(), "web", "index.html"),
  "utf8",
);

// Minimal, dependency-free resolution of the selector shapes dom.js uses:
// "#id" and "#id descendant-tag". Anything else is rejected so a new selector
// shape cannot silently skip this check.
function resolveInHtml(selector) {
  const simpleId = selector.match(/^#([\w-]+)$/);
  if (simpleId) {
    return HTML.includes(`id="${simpleId[1]}"`);
  }

  const idWithChild = selector.match(/^#([\w-]+)\s+([\w-]+)$/);
  if (idWithChild) {
    const [, id, childTag] = idWithChild;
    const idAt = HTML.indexOf(`id="${id}"`);
    if (idAt < 0) {
      return false;
    }
    // Scope the descendant search to the element carrying the id.
    const openAt = HTML.lastIndexOf("<", idAt);
    const ownerTag = HTML.slice(openAt + 1).match(/^[\w-]+/)?.[0];
    const closeAt = ownerTag ? HTML.indexOf(`</${ownerTag}>`, idAt) : -1;
    const block = HTML.slice(idAt, closeAt < 0 ? HTML.length : closeAt);
    return new RegExp(`<${childTag}[\\s/>]`).test(block);
  }

  return null; // unsupported shape
}

test("every required UI element exists in index.html", () => {
  const missing = [];
  const unsupported = [];

  for (const [name, selector] of Object.entries(REQUIRED_ELEMENTS)) {
    const found = resolveInHtml(selector);
    if (found === null) {
      unsupported.push(`${name} -> ${selector}`);
    } else if (!found) {
      missing.push(`${name} -> ${selector}`);
    }
  }

  assert.deepEqual(
    unsupported,
    [],
    "selector shape not understood by this test; extend resolveInHtml()",
  );
  assert.deepEqual(
    missing,
    [],
    "index.html is missing elements that web/js/ui/dom.js requires",
  );
});

test("required element names and selectors are unique", () => {
  const selectors = Object.values(REQUIRED_ELEMENTS);
  const duplicates = selectors.filter((s, i) => selectors.indexOf(s) !== i);
  assert.deepEqual(duplicates, [], "the same selector is bound to two names");
});

test("collection selectors match markup that exists", () => {
  for (const [name, selector] of Object.entries(ELEMENT_COLLECTIONS)) {
    // Collections are class-scoped group lookups; assert the scope exists so a
    // renamed container does not quietly yield an empty list.
    const scope = selector.match(/^\.([\w-]+)/)?.[1];
    assert.ok(scope, `${name}: expected a class-scoped selector, got ${selector}`);
    assert.ok(
      new RegExp(`class="[^"]*\\b${scope}\\b[^"]*"`).test(HTML),
      `${name}: index.html has no .${scope} container`,
    );
  }
});

test("queryUiElements reports every missing element at once", async () => {
  const { queryUiElements } = await import("../../web/js/ui/dom.js");
  const previousDocument = globalThis.document;
  // A page with exactly one of the required elements present.
  globalThis.document = new FakeDocument({
    vivify: (selector) => (selector === "#radio-search" ? "input" : null),
  });
  try {
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
  } finally {
    globalThis.document = previousDocument;
  }
});

// #debug-actions is toggled hidden with the Debug Output disclosure, so any
// control that must stay reachable while the panel is folded has to live
// outside it. Report Bug is that control: a user who cannot open the panel is
// exactly the user with something to report.
test("Report Bug sits outside the collapsible debug actions", () => {
  const actionsAt = HTML.indexOf('id="debug-actions"');
  assert.ok(actionsAt > 0, "index.html has no #debug-actions container");
  const actionsEnd = HTML.indexOf("</div>", actionsAt);
  const collapsible = HTML.slice(actionsAt, actionsEnd);

  assert.ok(
    !collapsible.includes('id="report-issue"'),
    "#report-issue is inside #debug-actions and disappears when Debug Output is folded",
  );
  assert.ok(
    /<div id="debug-actions"[^>]*\shidden/.test(HTML),
    "#debug-actions is expected to start hidden; this test's premise no longer holds",
  );
});

// The element interface each tag stands for in UiElementTypes
// (web/js/ui/dom.js); any tag not listed is a plain HTMLElement there.
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

// The tag a REQUIRED_ELEMENTS selector lands on: the id's own element, or the
// descendant tag a "#id tag" selector names.
function tagOf(selector) {
  const idWithChild = selector.match(/^#[\w-]+\s+([\w-]+)$/);
  if (idWithChild) {
    return idWithChild[1].toLowerCase();
  }
  const id = selector.match(/^#([\w-]+)$/)[1];
  return HTML.match(new RegExp(`<([\\w-]+)[^>]*\\bid="${id}"`))[1].toLowerCase();
}

// UiElementTypes is what npm run check:js trusts for every dom.* member: a
// button typed HTMLElement hides .disabled from the checker, and a div typed
// HTMLButtonElement lets code call what the element does not have. It is a
// JSDoc typedef, so nothing ties it to the markup but this test.
test("the element types dom.js declares match index.html's tags", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "web", "js", "ui", "dom.js"), "utf8");
  const block = source.match(/@typedef \{\{\n([\s\S]*?)\n \* \}\} UiElementTypes/);
  assert.ok(block, "web/js/ui/dom.js no longer declares UiElementTypes in the expected shape");
  const declared = Object.fromEntries(
    [...block[1].matchAll(/^ \*\s+(\w+): (\w+),?$/gm)].map(([, name, type]) => [name, type]),
  );
  const wrong = [];
  for (const [name, selector] of Object.entries(REQUIRED_ELEMENTS)) {
    const tag = tagOf(selector);
    const expected = TAG_INTERFACES[tag] || "HTMLElement";
    const actual = declared[name] || "HTMLElement";
    if (actual !== expected) {
      wrong.push(`${name} (${selector}) is <${tag}>: expected ${expected}, declared ${actual}`);
    }
  }
  const unknown = Object.keys(declared).filter((name) => !(name in REQUIRED_ELEMENTS));
  assert.deepEqual(unknown, [], "UiElementTypes names elements REQUIRED_ELEMENTS does not");
  assert.deepEqual(wrong, [], "update UiElementTypes in web/js/ui/dom.js to the markup");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ELEMENT_COLLECTIONS, REQUIRED_ELEMENTS } from "../web/js/ui/dom.js";

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
  const { queryUiElements } = await import("../web/js/ui/dom.js");
  const previousDocument = globalThis.document;
  globalThis.document = {
    querySelector: (selector) => (selector === "#radio-make" ? {} : null),
    querySelectorAll: () => [],
  };
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
          !error.message.includes("radioMakeEl"),
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

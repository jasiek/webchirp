import test from "node:test";
import assert from "node:assert/strict";

import { createToolbarMenu } from "../../web/js/ui/toolbar-menu.ts";
import { installIndexPage } from "../support/index-page.mjs";
import { dispatch } from "../support/ui-interactions.mjs";

// On a phone the header keeps only Load and Export beside the title; the rest
// folds behind a toggle. jsdom applies no media queries, so what is pinned here
// is the markup the stylesheet relies on and the toggle's own state, not which
// width folds.

// The two members web/js/ui/toolbar-menu.ts reads off ctx.
function makeContext() {
  const { document } = installIndexPage();
  const toggle = document.querySelector("#toolbar-more-toggle");
  const group = document.querySelector("#toolbar-more");
  return {
    document,
    toggle,
    group,
    ctx: { dom: { toolbarMoreToggleEl: toggle, toolbarMoreEl: group } },
  };
}

test("only Load and Export stay outside the fold", () => {
  const { document, group } = makeContext();
  const actions = document.querySelector(".toolbar-actions");
  const unfolded = [...actions.children].filter((el) => el !== group);
  assert.deepEqual(
    unfolded.map((el) => el.id || el.className),
    ["load-codeplug", "toolbar-export", "toolbar-more-toggle"],
  );
  assert.ok(group.querySelector("#install-app"), "Install folds with the rest");
});

test("About is the last button, directly before the GitHub mark", () => {
  const { group } = makeContext();
  const about = group.querySelector('a[href="./about.html"]');
  assert.ok(about);
  assert.equal(about.nextElementSibling.getAttribute("href"), "https://github.com/jasiek/webchirp");
  const buttons = group.querySelectorAll("button, .toolbar-link");
  assert.equal(buttons[buttons.length - 1], about);
});

test("the toggle opens and closes the fold", async () => {
  const { toggle, group, ctx } = makeContext();
  createToolbarMenu(ctx).bindEvents();
  assert.equal(group.classList.contains("is-open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  await dispatch(toggle, "click");
  assert.equal(group.classList.contains("is-open"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  await dispatch(toggle, "click");
  assert.equal(group.classList.contains("is-open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("a tap outside the fold, or on one of its controls, folds it away", async () => {
  const { document, toggle, group, ctx } = makeContext();
  const menu = createToolbarMenu(ctx);
  menu.bindEvents();

  await dispatch(toggle, "click");
  await dispatch(document.querySelector("#radio-search"), "click");
  assert.equal(menu.isOpen(), false);

  await dispatch(toggle, "click");
  // A tap on the group's own padding is not a choice, so it stays open.
  await dispatch(group, "click");
  assert.equal(menu.isOpen(), true);
  // jsdom does not navigate, so the link's click is all that happens here.
  await dispatch(group.querySelector('a[href="./about.html"]'), "click");
  assert.equal(menu.isOpen(), false);
});

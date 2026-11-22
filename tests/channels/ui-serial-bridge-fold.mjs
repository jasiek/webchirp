import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";
import { dispatch } from "../support/ui-interactions.mjs";

// Serial Bridge is a <details> the user folds on a phone so the channel list
// is not pushed down the page. The experimental-software warning and the
// driver-set links belong to it: folding the section hides them with it, and
// unfolding shows them again.
function stubRuntimeApi(ui) {
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
  }));
}

async function bootWith(search) {
  const { document, restore } = installIndexPage({ url: search });
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  stubRuntimeApi(ui);
  await ui.init(true);
  return { document, restore };
}

// Whether a browser would render el: jsdom does no layout, so this applies
// the two rules that hide these elements -- the hidden attribute on el or an
// ancestor, and a closed <details> around anything but its own <summary>.
function isShown(el) {
  for (let node = el; node; node = node.parentElement) {
    if (node.hidden) {
      return false;
    }
    const details = node.parentElement;
    if (details?.localName === "details" && !details.open && node.localName !== "summary") {
      return false;
    }
  }
  return true;
}

async function assertFoldsWith(search, linkSelector) {
  const { document, restore } = await bootWith(search);
  try {
    const section = document.querySelector("details.serial-bridge");
    const summary = section.querySelector("summary");
    const warning = document.querySelector("#sidebar-warning");
    const link = document.querySelector(linkSelector);
    assert.ok(section.open, "Serial Bridge starts unfolded");
    assert.ok(isShown(warning) && isShown(link), "the warning and the link show while unfolded");

    await dispatch(summary, "click");
    assert.equal(section.open, false);
    assert.equal(isShown(warning), false, "folding hides the warning");
    assert.equal(isShown(link), false, `folding hides ${linkSelector}`);
    assert.ok(isShown(summary), "the folded section keeps its heading");

    await dispatch(summary, "click");
    assert.ok(section.open);
    assert.ok(isShown(warning), "unfolding shows the warning again");
    assert.ok(isShown(link), `unfolding shows ${linkSelector} again`);
  } finally {
    restore();
  }
}

test("folding Serial Bridge hides the warning and the Quansheng drivers link", async () => {
  await assertFoldsWith("", "#use-quansheng-drivers");
});

test("with the unofficial drivers, folding hides the link back to CHIRP drivers", async () => {
  await assertFoldsWith("?drivers=quansheng-unofficial", "#use-chirp-drivers");
});

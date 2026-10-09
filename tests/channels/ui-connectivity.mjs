import assert from "node:assert/strict";
import test from "node:test";

import { createConnectivity } from "../../web/js/ui/connectivity.ts";
import { installIndexPage, pageElement } from "../support/index-page.mjs";
import { emit } from "../support/ui-interactions.mjs";

test("browser connectivity events drive the offline badge and repeater availability", async (t) => {
  const { window, restore } = installIndexPage({ navigator: { onLine: false } });
  t.after(restore);
  const indicator = pageElement("offlineIndicatorEl");
  const repeaterStates = [];
  const connectivity = createConnectivity({
    dom: { offlineIndicatorEl: indicator },
    repeaterQuery: { setOnline: (online) => repeaterStates.push(online) },
  });

  connectivity.bindEvents();
  assert.equal(connectivity.isOnline(), false);
  assert.equal(indicator.hidden, false);
  assert.deepEqual(repeaterStates, [false]);

  await emit(window, "online");
  assert.equal(connectivity.isOnline(), true);
  assert.equal(indicator.hidden, true);
  assert.deepEqual(repeaterStates, [false, true]);

  await emit(window, "offline");
  assert.equal(connectivity.isOnline(), false);
  assert.equal(indicator.hidden, false);
  assert.deepEqual(repeaterStates, [false, true, false]);
});

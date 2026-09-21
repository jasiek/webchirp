import assert from "node:assert/strict";
import test from "node:test";

import { createConnectivity } from "../../web/js/ui/connectivity.js";
import { FakeElement, installFakeDom } from "../support/fake-dom.mjs";

test("browser connectivity events drive the offline badge and repeater availability", async (t) => {
  const { window, restore } = installFakeDom({ navigator: { onLine: false } });
  t.after(restore);
  const indicator = Object.assign(new FakeElement("span"), { hidden: true });
  const repeaterStates = [];
  const connectivity = createConnectivity({
    dom: { offlineIndicatorEl: indicator },
    repeaterQuery: { setOnline: (online) => repeaterStates.push(online) },
  });

  connectivity.bindEvents();
  assert.equal(connectivity.isOnline(), false);
  assert.equal(indicator.hidden, false);
  assert.deepEqual(repeaterStates, [false]);

  await window.emit("online");
  assert.equal(connectivity.isOnline(), true);
  assert.equal(indicator.hidden, true);
  assert.deepEqual(repeaterStates, [false, true]);

  await window.emit("offline");
  assert.equal(connectivity.isOnline(), false);
  assert.equal(indicator.hidden, false);
  assert.deepEqual(repeaterStates, [false, true, false]);
});

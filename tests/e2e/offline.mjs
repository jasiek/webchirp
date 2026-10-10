// Offline use in a real browser: once a visit has let the service worker
// (web/sw.ts) cache the build, the app loads and boots a radio's driver with no
// network at all -- the page, the bundles, the catalog, the CHIRP archive and
// Pyodide from jsDelivr all come from its cache. The caching rules themselves
// are covered in tests/build/offline-cache.mjs; this is the proof that the
// list of what to cache is complete.
import { expect, test } from "@playwright/test";

import {
  offlineBuildReady,
  radioCatalogLoaded,
  selectRadioThroughSearch,
  selectedDriverAnswered,
} from "../../scripts/app-driver.ts";

const RADIO_QUERY = "Baofeng UV-17Pro";

// playwright.config.mjs blocks service workers for every other test.
test.use({ serviceWorkers: "allow" });

test("a visited build loads and boots a radio without a network", async ({ context, page }) => {
  await page.goto("./");
  await page.waitForFunction(radioCatalogLoaded);
  // The whole build, Pyodide included, is downloaded in the background.
  await page.waitForFunction(offlineBuildReady, undefined, { timeout: 90_000 });

  await context.setOffline(true);
  // Nothing the worker has not cached is reachable now, worker's own fetches
  // included: a file it never cached fails.
  expect(await page.evaluate(() => fetch("./robots.txt").then(() => "online", () => "offline"))).toBe("offline");

  await page.reload();
  await page.waitForFunction(radioCatalogLoaded);
  expect(await page.evaluate(selectRadioThroughSearch, RADIO_QUERY)).toBe(RADIO_QUERY);
  // Answered by the driver, in Pyodide, booted from the cache.
  await page.waitForFunction(selectedDriverAnswered);
  await expect(page.locator("#radio-selection-name")).toHaveText(RADIO_QUERY);

  // The worker told the page it came from the cache, and the launch is
  // counted for the next online page to report (web/js/offline.ts). Off the
  // production host nothing is ever sent, so the count stays.
  await page.waitForFunction(() => localStorage.getItem("webchirp-offline-launches") !== null);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("webchirp-offline-launches") || "{}")))
    .toEqual({ cache: 1 });
});

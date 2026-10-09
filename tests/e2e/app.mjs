// The app in a real browser: what the headless unit tests cannot see because
// jsdom does no layout and runs no Pyodide. The page is the built site
// (dist/), served the way GitHub Pages serves it; see playwright.config.mjs.
//
// The steps that drive the app come from scripts/app-driver.ts, the same ones
// scripts/update-screenshots.ts uses.
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  radioCatalogLoaded,
  rsgbQueryOutcome,
  selectRadioThroughSearch,
  selectedDriverAnswered,
  submitRsgbQuery,
} from "../../scripts/app-driver.ts";
import { watchConsole, watchThirdPartyRequests } from "../support/browser-page.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

// A radio whose driver holds 1,000 memories (1-1000), so the CSV fixture fits.
const RADIO_QUERY = "Baofeng UV-17Pro";
const CSV_FIXTURE = path.join(repoRoot, "tests", "support", "fixtures", "channels-1000.csv");
const RSGB_FIXTURE = fs.readFileSync(path.join(repoRoot, "tests", "support", "fixtures", "rsgb-locator.json"), "utf8");

// Loads index.html and waits until a radio can be picked.
async function openApp(page) {
  await page.goto("./");
  await page.waitForFunction(radioCatalogLoaded);
}

// Picks RADIO_QUERY through the search box and waits for its driver, which
// runs in Pyodide, to answer.
async function selectRadio(page) {
  expect(await page.evaluate(selectRadioThroughSearch, RADIO_QUERY)).toBe(RADIO_QUERY);
  await page.waitForFunction(selectedDriverAnswered);
}

// The channel rows the grid has in the DOM, as opposed to the rows it holds.
function renderedRows(page) {
  return page.locator("#mem-table tbody tr[data-row-idx]");
}

test("index.html boots to the radio search with a clean console", async ({ page }) => {
  const problems = watchConsole(page);
  await openApp(page);

  await expect(page.locator("#radio-selection-name")).toHaveText("No radio model selected");
  await expect(page.locator("#radio-search")).toBeEnabled();
  await expect(page.locator("#unsupported-browser-overlay")).toBeHidden();
  expect(problems).toEqual([]);
});

test("selecting a radio boots the Python runtime and renders its channel grid", async ({ page }) => {
  const problems = watchConsole(page);
  const pyodideRequests = [];
  page.on("request", (request) => {
    if (/\/pyodide\.asm\.wasm$/.test(request.url())) {
      pyodideRequests.push(request.url());
    }
  });
  await openApp(page);

  // Answered by the driver's own module, imported into Pyodide for this radio.
  await selectRadio(page);

  expect(pyodideRequests, "the Python runtime was loaded").toHaveLength(1);
  await expect(page.locator("#radio-selection-name")).toHaveText(RADIO_QUERY);
  const headers = page.locator("#mem-table thead th");
  await expect(headers.first()).toHaveText("#");
  await expect(headers).toContainText(["Name", "Frequency", "Mode", "Power"]);
  // No channels yet: the grid stands aside for its empty-state notice.
  await expect(page.locator("#channel-empty-state")).toBeVisible();
  expect(problems).toEqual([]);
});

// The windowing jsdom cannot exercise: a codeplug far longer than the viewport
// keeps only the rows in view (plus overscan) in the DOM, and scrolling
// recycles them onto later channels.
test("a 1,000-channel CSV keeps only a window of rows in the DOM, and scrolling brings later rows in", async ({ page }) => {
  const problems = watchConsole(page);
  await openApp(page);
  await selectRadio(page);

  await page.locator("#codeplug-file").setInputFiles(CSV_FIXTURE);
  await page.waitForFunction(() => globalThis.currentRows?.length === 1000);

  const firstWindow = await renderedRows(page).count();
  expect(firstWindow).toBeGreaterThan(0);
  expect(firstWindow, "far fewer rows in the DOM than in the codeplug").toBeLessThan(100);
  await expect(renderedRows(page).first()).toHaveAttribute("data-row-idx", "0");
  await expect(renderedRows(page).first().locator("td").nth(1).locator("input")).toHaveValue("CH0001");

  await page.locator("#mem-table-scroll").evaluate((viewport) => {
    viewport.scrollTop = viewport.scrollHeight;
  });

  await expect(renderedRows(page).last()).toHaveAttribute("data-row-idx", "999");
  await expect(renderedRows(page).last().locator("td").nth(1).locator("input")).toHaveValue("CH1000");
  await expect(page.locator('#mem-table tbody tr[data-row-idx="0"]')).toHaveCount(0);
  expect(await renderedRows(page).count()).toBeLessThan(100);
  expect(problems).toEqual([]);
});

test("the RSGB query imports repeaters from a routed answer, never the real API", async ({ page }) => {
  const problems = watchConsole(page);
  const thirdParty = watchThirdPartyRequests(page);
  const answered = [];
  await page.route("https://api-beta.rsgb.online/**", (route) => {
    answered.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: RSGB_FIXTURE,
    });
  });
  // The query modal previews the position on OpenStreetMap tiles; a test has
  // no business loading them from the real tile servers.
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  }));
  await openApp(page);
  await selectRadio(page);

  await page.locator("#channel-import-rsgb").click();
  await expect(page.locator("#repeater-query-modal")).toBeVisible();
  await expect(page.locator("#repeater-query-title")).toHaveText("Query RSGB ETCC API");

  expect(await page.evaluate(submitRsgbQuery, "IO82MM")).toBe(true);
  await page.waitForFunction(() => {
    const failed = /RSGB ETCC QUERY ERROR/.test(document.querySelector("#debug-output")?.value || "");
    return failed || document.querySelector("#repeater-query-modal")?.classList.contains("hidden");
  });
  const outcome = await page.evaluate(rsgbQueryOutcome);

  expect(outcome.failed).toBe("");
  expect(outcome.done).toBe(true);
  expect(outcome.count).toBeGreaterThan(0);
  await expect(renderedRows(page)).toHaveCount(outcome.count);
  expect(answered.length, "the query asked the routed RSGB API").toBeGreaterThan(0);
  expect(thirdParty.filter((url) => !url.startsWith("https://api-beta.rsgb.online/")
    && !url.startsWith("https://tile.openstreetmap.org/"))).toEqual([]);
  expect(problems).toEqual([]);
});

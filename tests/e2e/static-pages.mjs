// The site's other pages in a real browser: each loads, renders its heading
// and reports nothing in the console. One generated model page and one
// generated licensing page stand for their hundreds of siblings, which share
// a template.
import { expect, test } from "@playwright/test";

import { watchConsole } from "../support/browser-page.mjs";

const PAGES = [
  "about.html",
  "serial-test.html",
  "radios/baofeng-uv-5r.html",
  "licensing/united-kingdom.html",
];

for (const pagePath of PAGES) {
  test(`${pagePath} loads with a clean console`, async ({ page }) => {
    const problems = watchConsole(page);
    const response = await page.goto(`./${pagePath}`);

    expect(response?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
    // Let the page's modules run before judging the console.
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

// Playwright configuration for the browser tests in tests/e2e
// (npm run test:e2e). They run against the built site, dist/, the way GitHub
// Pages serves it, in Chromium only: Web Serial, WebUSB and Web Bluetooth are
// Chromium APIs, so the app's own audience is Chromium.
//
// npm test does not run these. They need a browser download (npx playwright
// install chromium) and the network, because the app loads Pyodide from
// jsDelivr; a CDN outage must not be able to fail the unit suites. CI runs
// them in a job of their own (.github/workflows/e2e.yml).
import { defineConfig } from "@playwright/test";

import { findFreePort } from "./scripts/app-driver.ts";

// One port for the whole run. Playwright loads this file again in every
// worker; the runner loads it first, picks the port and puts it in the
// environment its workers inherit, so they all agree on it.
process.env.WEBCHIRP_E2E_PORT ||= String(await findFreePort());
const port = process.env.WEBCHIRP_E2E_PORT;
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: "tests/e2e",
  // Tests are named for what they cover, like every other suite's.
  testMatch: "*.mjs",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  // Pyodide and the CHIRP archive download on the first radio selection.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // Build first, so the tests see what would deploy, then serve dist/ with
    // the dev server in its Pages mode (no isolation headers).
    command: "npm run build:dist && node scripts/dev-server.ts",
    url: baseURL,
    env: { HOST: "127.0.0.1", PORT: port, WEB_ROOT: "dist", SERVE_AS: "pages" },
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

// Regenerates the repository screenshots from the current version of the app:
//   images/screenshot.png               (README screenshot, 1600x1000)
//   images/screenshot-for-opengraph.png (OpenGraph card, 1200x630)
//   web/images/social-preview.png       (copy of the OpenGraph card served by the site)
//   web/images/screenshot-wide.png      (manifest screenshot, desktop install dialog)
//   web/images/screenshot-narrow.png    (manifest screenshot, Android install dialog)
//
// The last two are what turn Chrome's install dialog from a bare icon-and-origin
// sheet into the rich one carrying the app's description and a screenshot
// carousel. They are captured here rather than drawn by hand so they cannot
// drift from the app the way a checked-in marketing image would.
//
// Usage: npm run screenshots
//
// Drives the app in headless Chrome (scripts/headless-chrome.ts), waits until
// the selected radio schema has loaded, and queries live RSGB channels around
// IO82MM before capturing.

import fs from "node:fs";
import path from "node:path";

import {
  delay,
  inPageCall,
  rsgbQueryOutcome,
  selectRadioThroughSearch,
  submitRsgbQuery,
} from "./app-driver.ts";
import {
  APP_READY_TIMEOUT_MS,
  evaluate,
  repoRootDir,
  startHeadlessApp,
  waitForAppReady,
} from "./headless-chrome.ts";
import type { CdpClient } from "./headless-chrome.ts";

// Each shot names a viewport and the files it is written to. `mobile` switches
// Chrome into device emulation so the app lays itself out the way a phone sees
// it, and `scale` multiplies the captured pixels without changing that layout —
// a manifest screenshot is displayed at phone size but on a phone's display, so
// a 1x capture of it looks soft in the install dialog.
//
// Chrome constrains manifest screenshots: every one of a given form_factor must
// share an aspect ratio, and no side may exceed 2.3x the other or 3840px. The
// narrow shot is deliberately a flat 1:2 rather than a real handset's ratio,
// which sits close enough to that limit to be worth not testing.
//
// The mobile shot goes last so its emulation override cannot follow the desktop
// captures into a layout they were not framed for.
const SHOTS = [
  {
    width: 1600,
    height: 1000,
    outputs: [
      path.join(repoRootDir, "images", "screenshot.png"),
      path.join(repoRootDir, "web", "images", "screenshot-wide.png"),
    ],
  },
  {
    width: 1200,
    height: 630,
    outputs: [
      path.join(repoRootDir, "images", "screenshot-for-opengraph.png"),
      path.join(repoRootDir, "web", "images", "social-preview.png"),
    ],
  },
  {
    width: 412,
    height: 824,
    mobile: true,
    scale: 2,
    // A phone stacks the sidebar above the editor, so an unscrolled capture is
    // a page of buttons and a disclaimer -- the channel grid, which is what the
    // app is, sits entirely below the fold. The install dialog gets one image
    // to make its case, so this one starts at the grid.
    scrollTo: "#channel-editor",
    outputs: [path.join(repoRootDir, "web", "images", "screenshot-narrow.png")],
  },
];

const APP_SETTLE_DELAY_MS = 3000;
const SCREENSHOT_LOCATOR = "IO82MM";
// Radios are chosen by searching, so nothing is selected at startup and the
// screenshot has to pick one. A widely recognised model keeps the sidebar
// readout and the channel schema meaningful in the published images.
const SCREENSHOT_RADIO_QUERY = "Baofeng UV-5R";

// Drive the radio search box the way a user does — type, then take the first
// suggestion — so the shot exercises the real selection path rather than
// reaching into module state.
async function selectScreenshotRadio(cdp: CdpClient, sessionId: string): Promise<string> {
  const selected = await evaluate(cdp, sessionId, inPageCall(selectRadioThroughSearch, SCREENSHOT_RADIO_QUERY));
  if (!selected || selected === "No radio model selected") {
    throw new Error(
      `Could not select "${SCREENSHOT_RADIO_QUERY}" through the radio search box.`
    );
  }
  return selected;
}

// Release screenshots use the same reproducible, real-data starting point as
// manual captures: the default radio's schema populated from the RSGB query at
// IO82MM. Drive the public controls rather than reaching into module state, so
// the screenshot run also exercises the user-visible query path.
async function loadScreenshotChannels(cdp: CdpClient, sessionId: string): Promise<number> {
  const started = await evaluate(cdp, sessionId, inPageCall(submitRsgbQuery, SCREENSHOT_LOCATOR));
  if (!started) {
    throw new Error("Could not open and submit the RSGB screenshot query.");
  }

  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  for (;;) {
    const result = await evaluate(cdp, sessionId, inPageCall(rsgbQueryOutcome));
    if (result?.done) {
      return result.count;
    }
    if (result?.failed) {
      throw new Error(`RSGB screenshot query failed: ${result.failed}`);
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the RSGB screenshot query.");
    }
    await delay(500);
  }
}

async function captureShots(cdp: CdpClient, sessionId: string): Promise<void> {
  for (const shot of SHOTS) {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: shot.scale || 1,
        mobile: Boolean(shot.mobile),
      },
      sessionId
    );
    // A phone viewport crosses two media-query breakpoints and re-stacks the
    // whole layout, which the channel grid then has to re-measure against its
    // new scroll viewport. The wait is per-shot rather than once at the end.
    await delay(1000);
    // Framing is set after the layout has settled, and reset for every shot
    // that does not ask for it, so one capture cannot inherit another's
    // scroll position.
    await evaluate(
      cdp,
      sessionId,
      shot.scrollTo
        ? `document.querySelector(${JSON.stringify(shot.scrollTo)})`
          + `?.scrollIntoView({ block: "start" })`
        : "window.scrollTo(0, 0)"
    );
    await delay(500);
    const { data } = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sessionId
    );
    const pngBuffer = Buffer.from(data, "base64");
    for (const outputPath of shot.outputs) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, pngBuffer);
      const scale = shot.scale || 1;
      console.log(
        `Wrote ${path.relative(repoRootDir, outputPath)} `
        + `(${shot.width * scale}x${shot.height * scale}, ${pngBuffer.length} bytes)`
      );
    }
  }
}

async function main() {
  const app = await startHeadlessApp();
  try {
    const { cdp } = app;
    const { sessionId } = await app.openPage();
    await cdp.send("Page.navigate", { url: app.appUrl }, sessionId);

    console.log("Waiting for the app to finish loading (Pyodide + radio catalog)...");
    await waitForAppReady(cdp, sessionId);
    const selectedRadio = await selectScreenshotRadio(cdp, sessionId);
    console.log(`Selected radio: ${selectedRadio}`);
    // Selecting kicks off a Pyodide schema+settings load that re-renders the
    // grid when it lands. Let it finish before the repeater query fills the
    // grid, so the capture is not racing a second render.
    await delay(2000);
    console.log(`Querying RSGB channels around ${SCREENSHOT_LOCATOR}...`);
    const channelCount = await loadScreenshotChannels(cdp, sessionId);
    console.log(`Loaded ${channelCount} RSGB channel(s) for the screenshots.`);
    await delay(APP_SETTLE_DELAY_MS);

    await captureShots(cdp, sessionId);
    console.log("Screenshots updated.");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

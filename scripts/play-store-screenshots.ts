// Captures the Play Store listing's phone screenshots from the current version
// of the app, into fastlane/metadata/android/en-US/images/phoneScreenshots/,
// where fastlane supply uploads them from (android/README.md):
//   1_start.png     the app as it opens
//   2_channels.png  Serial Bridge folded, the 30 GMRS channels in the grid
//   3_repeaters.png the RepeaterBook query around London, repeaters on its map
//   4_settings.png  a Baofeng UV-5R image from CHIRP's tests, Radio Settings
//
// Usage: TURNSTILE_BYPASS_TOKEN=<token> npm run screenshots (after the site's
// own, scripts/update-screenshots.ts)
//
// Each shot starts from a freshly loaded page, so none inherits another's
// radio, channels or folded section. The RepeaterBook shot queries the real
// directory through api.webchirp.org, which needs the API's Turnstile bypass
// token: the dev server reads TURNSTILE_BYPASS_TOKEN and hands it to the page
// in place of the bot check (scripts/dev-turnstile-bypass.ts).

import fs from "node:fs";
import path from "node:path";

import {
  channelRowCount,
  clickElement,
  delay,
  fillRepeaterQuery,
  inPageCall,
  pickFirstPlaceSuggestion,
  radioSettingsShown,
  repeaterPreviewCount,
  selectedDriverAnswered,
  selectRadioThroughSearch,
} from "./app-driver.ts";
import { readTurnstileBypassToken } from "./dev-turnstile-bypass.ts";
import { evaluate, repoRootDir, startHeadlessApp, waitFor, waitForAppReady } from "./headless-chrome.ts";
import type { CdpClient } from "./headless-chrome.ts";
import { ANDROID_APP_LAUNCH_FLAG } from "../web/js/android-app.ts";

const OUTPUT_DIR = path.join(
  repoRootDir, "fastlane", "metadata", "android", "en-US", "images", "phoneScreenshots",
);

// Play asks for 9:16 phone screenshots of at least 1080px on the short side
// for the listing's larger layouts; a 360x640 phone at 3x is 1080x1920.
const VIEWPORT = { width: 360, height: 640, deviceScaleFactor: 3, mobile: true };

const SCREENSHOT_RADIO_QUERY = "Baofeng UV-5R";
const UV5R_IMAGE = path.join(repoRootDir, "chirp", "tests", "images", "Baofeng_UV-5R.img");

type ShotPage = { cdp: CdpClient; sessionId: string };

// Picks the UV-5R through the search box, as a user does, and waits until its
// driver has answered, so the shot's next step has a radio to work with.
async function selectScreenshotRadio({ cdp, sessionId }: ShotPage): Promise<void> {
  await evaluate(cdp, sessionId, inPageCall(selectRadioThroughSearch, SCREENSHOT_RADIO_QUERY));
  await waitFor(cdp, sessionId, inPageCall(selectedDriverAnswered), `${SCREENSHOT_RADIO_QUERY} to load`);
}

// Each shot drives a freshly loaded page into place; scrollTo, when set, is
// the element whose top the capture starts at.
const SHOTS: Array<{ file: string; scrollTo?: string; prepare: (page: ShotPage) => Promise<void> }> = [
  {
    file: "1_start.png",
    prepare: async () => {},
  },
  {
    file: "2_channels.png",
    // The folded section heads the shot, the grid beneath it.
    scrollTo: ".serial-bridge",
    prepare: async (page) => {
      const { cdp, sessionId } = page;
      await selectScreenshotRadio(page);
      await evaluate(cdp, sessionId, inPageCall(clickElement, ".serial-bridge > summary"));
      await evaluate(cdp, sessionId, inPageCall(clickElement, "#channel-add-gmrs"));
      await waitFor(cdp, sessionId, `${inPageCall(channelRowCount)} >= 30`, "the GMRS channels");
    },
  },
  {
    file: "3_repeaters.png",
    scrollTo: "#repeater-query-field-city",
    prepare: async (page) => {
      const { cdp, sessionId } = page;
      await selectScreenshotRadio(page);
      await evaluate(cdp, sessionId, inPageCall(clickElement, "#channel-import-repeaterbook"));
      await waitFor(
        cdp, sessionId,
        inPageCall(fillRepeaterQuery, { country: "GB", place: "London" }),
        "the RepeaterBook query form",
      );
      await waitFor(cdp, sessionId, inPageCall(pickFirstPlaceSuggestion), "the London suggestion");
      const caption = await waitFor(cdp, sessionId, inPageCall(repeaterPreviewCount), "the map preview");
      console.log(`RepeaterBook preview: ${caption}`);
    },
  },
  {
    file: "4_settings.png",
    scrollTo: ".editor-view-toggle",
    prepare: async ({ cdp, sessionId }) => {
      const { root } = await cdp.send("DOM.getDocument", {}, sessionId);
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#codeplug-file" }, sessionId);
      await cdp.send("DOM.setFileInputFiles", { nodeId, files: [UV5R_IMAGE] }, sessionId);
      await waitFor(
        cdp, sessionId,
        "!document.querySelector('#view-settings')?.disabled",
        "the UV-5R image to load",
      );
      await evaluate(cdp, sessionId, inPageCall(clickElement, "#view-settings"));
      await waitFor(cdp, sessionId, inPageCall(radioSettingsShown), "the radio settings");
    },
  },
];

// Captures every shot in SHOTS, each on a new phone-sized tab opened the way
// the Android app opens the site.
async function main() {
  // The dev server reads the same variable. Checked here too, so a missing
  // token stops the run before any shot instead of as a refused query in the
  // third.
  if (!readTurnstileBypassToken(process.env)) {
    throw new Error(
      "Set TURNSTILE_BYPASS_TOKEN to the API's bypass token: the RepeaterBook shot queries the live directory."
    );
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const app = await startHeadlessApp();
  try {
    const { cdp } = app;
    for (const shot of SHOTS) {
      const { targetId, sessionId } = await app.openPage();
      await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT, sessionId);
      // The listing is en-US: numbers are formatted that way whatever the
      // machine capturing it is set to.
      await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }, sessionId);
      // Opened the way the Android app opens it, so the page lays itself out
      // as it does there (no Install app button, for one).
      const url = new URL(app.appUrl);
      url.searchParams.set(ANDROID_APP_LAUNCH_FLAG, "false");
      await cdp.send("Page.navigate", { url: url.toString() }, sessionId);
      await waitForAppReady(cdp, sessionId);
      await shot.prepare({ cdp, sessionId });
      // Lets the grid re-measure and the map tiles arrive before framing.
      await delay(2000);
      await evaluate(
        cdp,
        sessionId,
        shot.scrollTo
          ? `document.querySelector(${JSON.stringify(shot.scrollTo)})?.scrollIntoView({ block: "start" })`
          : "window.scrollTo(0, 0)",
      );
      await delay(500);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const outputPath = path.join(OUTPUT_DIR, shot.file);
      fs.writeFileSync(outputPath, Buffer.from(data, "base64"));
      console.log(`Wrote ${path.relative(repoRootDir, outputPath)}`);
      await cdp.send("Target.closeTarget", { targetId });
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

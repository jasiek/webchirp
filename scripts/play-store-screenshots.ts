// Captures the Play Store listing's phone screenshots from the current version
// of the app, into fastlane/metadata/android/en-US/images/phoneScreenshots/,
// where fastlane supply uploads them from (android/README.md):
//   1_start.png     the app as it opens
//   2_channels.png  Serial Bridge folded, the 30 GMRS channels in the grid
//   3_repeaters.png the RepeaterBook query around London, repeaters on its map
//   4_settings.png  a Baofeng UV-5R image from CHIRP's tests, Radio Settings
//
// Usage: npm run screenshots (after the site's own, scripts/update-screenshots.ts)
//
// Each shot starts from a freshly loaded page, so none inherits another's
// radio, channels or folded section. api.webchirp.org only answers the
// production origins, and RepeaterBook's query sits behind a bot check, so
// its answers here come from LONDON_SAMPLE_REPEATERS below: invented
// repeaters, not RepeaterBook's data, at real places around London so the map
// reads true.

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

// [callsign, output MHz, input MHz, CTCSS Hz, latitude, longitude, place].
// UK 2 m repeaters listen 600 kHz below their output, 70 cm ones 1.6 MHz
// above. The DEMO callsigns cannot be mistaken for real ones.
const LONDON_SAMPLE_REPEATERS: Array<[string, string, string, string, number, number, string]> = [
  ["DEMO01", "145.66250", "145.06250", "82.5", 51.5155, -0.0922, "City of London"],
  ["DEMO02", "433.12500", "434.72500", "82.5", 51.5462, -0.1033, "Islington"],
  ["DEMO03", "145.73750", "145.13750", "82.5", 51.4613, -0.1156, "Brixton"],
  ["DEMO04", "433.27500", "434.87500", "82.5", 51.5574, -0.2829, "Wembley"],
  ["DEMO05", "145.60000", "145.00000", "77.0", 51.6538, -0.2005, "Barnet"],
  ["DEMO06", "433.05000", "434.65000", "82.5", 51.3762, -0.0982, "Croydon"],
  ["DEMO07", "145.70000", "145.10000", "82.5", 51.5390, 0.0480, "East Ham"],
  ["DEMO08", "433.35000", "434.95000", "94.8", 51.5751, 0.1821, "Romford"],
  ["DEMO09", "145.63750", "145.03750", "77.0", 51.4613, -0.3037, "Richmond"],
  ["DEMO10", "433.17500", "434.77500", "82.5", 51.4054, 0.0158, "Bromley"],
  ["DEMO11", "145.77500", "145.17500", "71.9", 51.6564, -0.3903, "Watford"],
  ["DEMO12", "433.07500", "434.67500", "82.5", 51.4545, 0.1505, "Bexleyheath"],
  ["DEMO13", "145.67500", "145.07500", "94.8", 51.7520, -0.3360, "St Albans"],
  ["DEMO14", "433.22500", "434.82500", "103.5", 51.2362, -0.5704, "Guildford"],
  ["DEMO15", "145.71250", "145.11250", "71.9", 51.6201, 0.3060, "Brentwood"],
];

// The RXF answer the RepeaterBook route gives, in the radio's perspective
// (rx is the repeater's output), as tests/support/fixtures/rxf-repeaterbook.xml
// describes the live feed.
function londonSampleRxf(): string {
  const repeaters = LONDON_SAMPLE_REPEATERS.map(([qra, output, input, tone, latitude, longitude, qth]) => [
    "<repeater>",
    `<qra>${qra}</qra><id>${qra}-fm</id><status>working</status><mode>fm</mode>`,
    `<band>${output.startsWith("145") ? "2m" : "70cm"}</band>`,
    `<qrg type="rx">${output}</qrg><qrg type="tx">${input}</qrg>`,
    `<country>gb</country><qth>${qth}</qth>`,
    `<location><latitude>${latitude}</latitude><longitude>${longitude}</longitude></location>`,
    `<ctcss type="rx">${tone}</ctcss><ctcss type="tx">${tone}</ctcss>`,
    "</repeater>",
  ].join(""));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rxf version="1.0"><perspective>radio</perspective><repeaters>',
    ...repeaters,
    "</repeaters></rxf>",
  ].join("\n");
}

// What each api.webchirp.org route the shots reach answers. The /meta
// dictionary lists only what the form needs to offer the query.
const API_ANSWERS: Array<{ path: RegExp; contentType: string; body: () => string }> = [
  {
    path: /^\/repeaterbook\/meta$/,
    contentType: "application/json",
    body: () => JSON.stringify({
      filters: {
        country: ["GB", "IE", "US"],
        band: ["10m", "6m", "2m", "1.25m", "70cm", "33cm", "23cm"],
        mode: ["fm", "dstar", "dmr", "fusion", "p25", "m17", "tetra"],
      },
    }),
  },
  { path: /^\/repeaterbook$/, contentType: "application/xml", body: londonSampleRxf },
  {
    path: /^\/cities$/,
    contentType: "application/json",
    body: () => JSON.stringify({
      results: [{
        id: "2643743", name: "London", region: "England", country: "United Kingdom",
        cc: "GB", lat: 51.50853, lon: -0.12574,
      }],
    }),
  },
];

// Answers every paused api.webchirp.org request from API_ANSWERS, and any
// other route with a 404, so no shot reaches the real API.
function answerApiRequests(cdp: CdpClient) {
  cdp.on("Fetch.requestPaused", (params, sessionId) => {
    const url = new URL(params.request.url);
    const answer = API_ANSWERS.find((entry) => entry.path.test(url.pathname));
    void cdp.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: answer ? 200 : 404,
      responseHeaders: [
        { name: "Content-Type", value: answer ? answer.contentType : "text/plain" },
        { name: "Access-Control-Allow-Origin", value: "*" },
      ],
      body: Buffer.from(answer ? answer.body() : "").toString("base64"),
    }, sessionId);
  });
}

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
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const app = await startHeadlessApp();
  try {
    const { cdp } = app;
    answerApiRequests(cdp);
    for (const shot of SHOTS) {
      const { targetId, sessionId } = await app.openPage();
      await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT, sessionId);
      // The listing is en-US: numbers are formatted that way whatever the
      // machine capturing it is set to.
      await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }, sessionId);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.webchirp.org/*" }] }, sessionId);
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

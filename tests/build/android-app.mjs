// Holds the Android app (android/, the Gradle project Bubblewrap generates
// from android/twa-manifest.json) to the site it opens. The two are tied by
// values nothing compares at runtime: the host the app opens and the package
// assetlinks.json vouches for (a mismatch shows the app with a URL bar), the
// launch query web/js/android-app.ts recognises (a mismatch shows the Install
// button inside the app), and the name, colours and icons the app shares with
// the web manifest. Each is checked here so a change to one side fails on its
// own pull request rather than on a phone.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ANDROID_APP_LAUNCH_FLAG,
  ANDROID_APP_LAUNCH_PARAMS,
  isAndroidAppLaunch,
} from "../../web/js/android-app.ts";
import { repoRoot, webDir } from "../support/repo-paths.mjs";

const androidDir = path.join(repoRoot, "android");
const TWA_MANIFEST_PATH = path.join(androidDir, "twa-manifest.json");
// The lowest targetSdkVersion Google Play accepts for new apps and updates,
// which Play raises every August: API 36 (Android 16) since 31 August 2026.
const PLAY_MIN_TARGET_SDK = 36;

// Each file this test compares, parsed.
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const twa = readJson(TWA_MANIFEST_PATH);
const webManifest = readJson(path.join(webDir, "manifest.webmanifest"));
const host = readFileSync(path.join(repoRoot, "CNAME"), "utf8").trim();
const appGradle = readFileSync(path.join(androidDir, "app", "build.gradle"), "utf8");

test("the app opens the site's own host", () => {
  assert.equal(twa.host, host);
  assert.equal(twa.fullScopeUrl, `https://${host}/`);
  assert.equal(twa.webManifestUrl, `https://${host}/manifest.webmanifest`);
});

test("the app is the one assetlinks.json vouches for", () => {
  const statements = readJson(path.join(webDir, ".well-known", "assetlinks.json"));
  assert.ok(
    statements.some((statement) => statement.target?.package_name === twa.packageId),
    `web/.well-known/assetlinks.json names no statement for ${twa.packageId}`,
  );
});

test("the app launches the site with the query that marks it as the app", () => {
  const url = new URL(twa.startUrl, `https://${host}/`);
  assert.equal(url.pathname, "/");
  assert.equal(isAndroidAppLaunch(url.search), true);
  // Exactly those parameters: an extra one would split the app's sessions in
  // analytics from the ones the launch query attributes.
  assert.deepEqual(Object.fromEntries(url.searchParams), { ...ANDROID_APP_LAUNCH_PARAMS });
});

// A webchirp.org link the app opens keeps its own query, so the launch query
// above never reaches it; Bubblewrap's firstRunFlag feature makes the
// launcher add ANDROID_APP_LAUNCH_FLAG to every URL it opens instead. Without
// it a page opened from a link would not know it runs in the app.
test("every URL the app opens carries the launcher's flag", () => {
  assert.deepEqual(twa.features?.firstRunFlag, { enabled: true, queryParameterName: ANDROID_APP_LAUNCH_FLAG });
  const launcher = readFileSync(
    path.join(androidDir, "app", "src", "main", "java", ...twa.packageId.split("."), "LauncherActivity.java"),
    "utf8",
  );
  assert.ok(launcher.includes(`PARAM_FIRST_OPEN = "${ANDROID_APP_LAUNCH_FLAG}"`), "LauncherActivity adds another flag");
  assert.match(launcher, /appendQueryParameter\(PARAM_FIRST_OPEN,/, "LauncherActivity does not add the flag");
});

test("the app's name, colours and icons are the site's", () => {
  assert.equal(twa.launcherName, webManifest.short_name);
  assert.equal(twa.display, webManifest.display);
  assert.equal(twa.themeColor.toLowerCase(), webManifest.theme_color.toLowerCase());
  assert.equal(twa.backgroundColor.toLowerCase(), webManifest.background_color.toLowerCase());
  for (const field of ["iconUrl", "maskableIconUrl"]) {
    const url = new URL(twa[field]);
    assert.equal(url.host, host, `${field} is not on ${host}`);
    // Bubblewrap downloads the icon from the live site when it regenerates the
    // project, so it must be a file the site serves.
    assert.ok(existsSync(path.join(webDir, url.pathname)), `${field} names a file web/ lacks: ${url.pathname}`);
  }
});

// Bubblewrap renders the launcher icons, splash screens and store icon from
// the web icons when it regenerates the project, and nothing else records
// which pixels it used: manifest-checksum.txt covers twa-manifest.json alone,
// and a replaced icon keeps its URL. android/icon-sources.json holds the
// SHA-256 of each icon the project was generated from, so new artwork on the
// site fails here until the app is regenerated with it.
test("the app's icons were generated from the site's current icons", () => {
  const recorded = readJson(path.join(androidDir, "icon-sources.json"));
  const urls = ["iconUrl", "maskableIconUrl", "monochromeIconUrl"].map((field) => twa[field]).filter(Boolean);
  assert.deepEqual(Object.keys(recorded).sort(), [...urls].sort(), "android/icon-sources.json lists other icons");
  for (const url of urls) {
    const actual = createHash("sha256").update(readFileSync(path.join(webDir, new URL(url).pathname))).digest("hex");
    assert.equal(
      recorded[url],
      actual,
      `${url} changed: run bubblewrap update in android/, then record ${actual} in android/icon-sources.json`,
    );
  }
});

// Android's WebView has no WebUSB, Web Serial or Web Bluetooth, so a WebView
// fallback would open the app on a phone without Chrome and never reach a
// radio. Custom Tabs use whatever browser is there, with its own APIs.
test("a phone without Trusted Web Activities falls back to Custom Tabs", () => {
  assert.equal(twa.fallbackType, "customtabs");
});

// Chrome hands a TWA page's geolocation request to the app's DelegationService,
// where Bubblewrap registers the location delegation handler, but Bubblewrap's
// template enables and exports that service only when notifications are on.
// Location delegation with notifications off leaves the repeater search's
// "use my location" with no handler to answer it.
test("location delegation has a delegation service to run in", () => {
  if (twa.features?.locationDelegation?.enabled) {
    assert.equal(twa.enableNotifications, true, "location delegation needs enableNotifications: true");
  }
  const manifest = readFileSync(path.join(androidDir, "app", "src", "main", "AndroidManifest.xml"), "utf8");
  const service = manifest.match(/<service\s+android:name="\.DelegationService"[^>]*>/)?.[0] || "";
  assert.match(service, /android:enabled="@bool\/enableNotification"/, "DelegationService is no longer gated as this test assumes");
});

// Bubblewrap regenerates the whole project from twa-manifest.json and writes
// that file's SHA-1 beside it; a mismatch means the manifest was edited and
// the project never regenerated, so the app builds from the old values.
test("the generated project is current with twa-manifest.json", () => {
  const recorded = readFileSync(path.join(androidDir, "manifest-checksum.txt"), "utf8").trim();
  const actual = createHash("sha1").update(readFileSync(TWA_MANIFEST_PATH)).digest("hex");
  assert.equal(actual, recorded, "run bubblewrap update --skipVersionUpgrade in android/");

  // A hand edit to the generated build file would pass the checksum.
  assert.ok(appGradle.includes(`applicationId "${twa.packageId}"`), "build.gradle has another applicationId");
  assert.ok(appGradle.includes(`hostName: '${twa.host}'`), "build.gradle opens another host");
  assert.ok(appGradle.includes(`launchUrl: '${twa.startUrl}'`), "build.gradle launches another URL");
  assert.ok(appGradle.includes(`versionCode ${twa.appVersionCode}\n`), "build.gradle has another versionCode");
});

// Bubblewrap 1.27.0's template still resolves from jcenter(), a retired
// repository code scanning flags as an untrusted artifact source. The
// committed android/build.gradle lists mavenCentral() in its place, and every
// regeneration writes jcenter() back.
test("the build resolves only from Google's Maven and Maven Central", () => {
  const rootGradle = readFileSync(path.join(androidDir, "build.gradle"), "utf8");
  for (const [name, text] of [["android/build.gradle", rootGradle], ["android/app/build.gradle", appGradle]]) {
    assert.doesNotMatch(text, /\bjcenter\(\)/, `${name} lists jcenter(); replace it with mavenCentral()`);
  }
  assert.match(rootGradle, /\bmavenCentral\(\)/);
});

test("the app targets the API level Google Play requires", () => {
  const target = Number(appGradle.match(/targetSdkVersion (\d+)/)?.[1]);
  assert.ok(target >= PLAY_MIN_TARGET_SDK, `targetSdkVersion ${target} is below Play's ${PLAY_MIN_TARGET_SDK}`);
});

// Pure formatting, encoding and environment-detection helpers shared across the
// UI modules. Nothing here touches UI state or the document, so it stays
// directly unit-testable.

function sanitizeFileNamePart(text) {
  return String(text || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "radio";
}

function dateStampForFileName(date) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}${m}${d}`;
}

// Derive an export file name like Baofeng_BF-888_20231218.img
// (<brand>_<model>_<date>.<format>).
export function buildExportFileName(vendor, model, extension, date = new Date()) {
  const vendorPart = sanitizeFileNamePart(vendor);
  const modelPart = sanitizeFileNamePart(model);
  return `${vendorPart}_${modelPart}_${dateStampForFileName(date)}.${extension}`;
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64(bytes) {
  let out = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    out += String.fromCharCode(...chunk);
  }
  return btoa(out);
}

// Normalize unknown error shapes into a detailed string for diagnostics.
export function errorDetails(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error.stack === "string" && error.stack.length > 0) {
    return error.stack;
  }
  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Extract a short first-line summary from a detailed error payload.
export function errorSummary(error) {
  const firstLine = errorDetails(error).split("\n")[0].trim();
  return firstLine || "Unknown error";
}

// The raw user agent, reported verbatim: any classification we do here throws
// away the one detail a triager may need (Android calls itself Linux, iPadOS
// calls itself a Mac), and the string is short enough to just hand over.
export function detectUserAgent() {
  return navigator.userAgent || "Unknown user agent";
}

// `userAgent` is passed explicitly by callers outside the app shell (the
// diagnostics page builds its report where there is no navigator to read in
// tests); everything in the app keeps calling it with no argument.
export function detectBrowserVersion(userAgent) {
  const ua = userAgent ?? navigator.userAgent ?? "";
  const matchers = [
    [/Edg\/([\d.]+)/, "Microsoft Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ];
  for (const [regex, name] of matchers) {
    const match = ua.match(regex);
    if (match?.[1]) {
      return `${name} ${match[1]}`;
    }
  }
  return ua || "Unknown browser";
}

// Browser brands as a bounded vocabulary, for telemetry rather than for a
// human. Deliberately not detectBrowserVersion() above, which exists for the
// issue-report prefill and falls back to returning the **raw user agent** --
// perfect in a GitHub issue a person reads, and exactly what must never become
// a metric attribute, where it would be unbounded cardinality and a
// fingerprint. This one falls back to "other" and never emits a version.
//
// Order is the whole trick: every Chromium browser carries "Chrome" in its user
// agent, so each derivative's own token has to be tested before the Chrome one
// or Edge, Opera, Vivaldi and the rest all report as Chrome. Chromium is listed
// before Chrome for the opposite reason -- Chrome's user agent says "Chrome/"
// and never "Chromium/", so a plain Chromium build is the only thing that
// matches it.
const BROWSER_TOKENS = Object.freeze([
  // Edg/ on desktop, EdgA/ on Android, EdgiOS/ on iOS; Edge/ was the old
  // pre-Chromium EdgeHTML browser, which is worth keeping as its own answer.
  ["edge", /\bEdg(?:e|A|iOS)?\//],
  ["opera", /\bOPR\/|\bOPT\/|\bOpera[\s/]/],
  ["samsung", /\bSamsungBrowser\//],
  ["vivaldi", /\bVivaldi\//],
  ["yandex", /\bYaBrowser\//],
  ["duckduckgo", /\bDuckDuckGo\//],
  ["firefox", /\bFirefox\/|\bFxiOS\//],
  ["chromium", /\bChromium\//],
  ["chrome", /\bChrome\/|\bCriOS\//],
  ["safari", /\bSafari\//],
]);

// The same vocabulary read off User-Agent Client Hints, which Chromium exposes
// as navigator.userAgentData.brands. Preferred over the user agent where it
// exists because it is the API built for this question -- a Chromium derivative
// names itself here honestly instead of hiding behind Chrome's token -- and
// ignored everywhere else, since Safari and Firefox do not implement it and are
// unambiguous in their user agent anyway. The list also carries GREASE entries
// ("Not:A-Brand") designed to break naive parsers, which fall through to no
// match rather than needing to be filtered out.
const BRAND_TOKENS = Object.freeze([
  ["edge", /microsoft edge/i],
  ["opera", /\bopera\b/i],
  ["samsung", /samsung/i],
  ["vivaldi", /vivaldi/i],
  ["yandex", /yandex/i],
  ["brave", /brave/i],
  ["chrome", /google chrome/i],
  ["chromium", /chromium/i],
]);

// Brave is the one brand that cannot be read synchronously. It ships a user
// agent byte-identical to Chrome's on purpose and omits itself from the client
// hint brands, so the only signal is navigator.brave.isBrave(), which is async.
// The probe is fired on first use and cached: calls before it settles report
// "chrome", which is what every other tool would have said anyway, and every
// call afterwards is right. Worth the asymmetry because Brave users are the
// cohort most likely to block analytics outright, so an error report is often
// the only place they appear at all.
let braveProbe = null;
let isBraveBrowser = false;

function probeBrave() {
  if (braveProbe) {
    return;
  }
  const brave = navigator.brave;
  if (typeof brave?.isBrave !== "function") {
    braveProbe = Promise.resolve();
    return;
  }
  braveProbe = Promise.resolve(brave.isBrave()).then(
    (result) => {
      isBraveBrowser = result === true;
    },
    // A probe that throws means the answer is simply unknown.
    () => {},
  );
}

// Test seam: the Brave answer is cached for the life of the page, which is
// right in a browser and wrong across tests, where one fake navigator would
// otherwise decide the answer for every case after it.
export function resetBrowserProbeForTests() {
  braveProbe = null;
  isBraveBrowser = false;
}

function matchToken(table, value) {
  for (const [name, pattern] of table) {
    if (pattern.test(value)) {
      return name;
    }
  }
  return "";
}

// Which browser this is, as one of a fixed set of lowercase tokens. Answers the
// question that matters most for this app's failures: Web Serial is Chromium
// only, WebUSB behaves differently per platform, and every browser on iOS is
// Safari underneath whatever brand it wears -- so a connect failure rate is
// close to meaningless without it.
export function detectBrowserName() {
  probeBrave();
  if (isBraveBrowser) {
    return "brave";
  }
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length > 0) {
    const named = matchToken(BRAND_TOKENS, brands.map((entry) => entry?.brand || "").join(" "));
    if (named) {
      return named;
    }
  }
  return matchToken(BROWSER_TOKENS, navigator.userAgent || "") || "other";
}

// Which platform, as a fixed set of lowercase tokens. The two platforms the app
// already has predicates for are asked through those rather than re-sniffed, so
// there is one definition of each: iOS first because iPadOS reports a desktop
// Macintosh user agent and would otherwise land in macos, and Android before
// the table because its user agent also says Linux.
const PLATFORM_TOKENS = Object.freeze([
  ["chromeos", /\bCrOS\b/],
  ["windows", /\bWindows\b/i],
  ["macos", /\bMac OS X\b|\bMacintosh\b/i],
  ["linux", /\bLinux\b/i],
]);

export function detectPlatformName() {
  if (isIosPlatform()) {
    return "ios";
  }
  if (isAndroidPlatform()) {
    return "android";
  }
  return matchToken(PLATFORM_TOKENS, navigator.userAgent || "") || "other";
}

// Android's native Web Serial only reaches Bluetooth RFCOMM serial ports, so
// the WebUSB connect path must stay available there for wired USB adapters.
export function isAndroidPlatform() {
  return /\bAndroid\b/i.test(navigator.userAgent || "");
}

// Every iOS/iPadOS browser is WebKit under the hood, so neither Web Serial nor
// WebUSB is reachable there whatever browser the user installs — the generic
// "try another browser" advice would be wrong. iPadOS reports a desktop
// Macintosh user agent, so touch points are what separate it from a real Mac.
export function isIosPlatform() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return true;
  }
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

export function flagEmojiFromCountryCode(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  const emojiCode = code === "UK" ? "GB" : code;
  if (!/^[A-Z]{2}$/.test(emojiCode)) {
    return code;
  }
  return Array.from(emojiCode)
    .map((char) => String.fromCodePoint(char.charCodeAt(0) + 127397))
    .join("");
}

export function countryDisplayName(countryCode) {
  if (countryCode === "UK" || countryCode === "GB") {
    return "United Kingdom";
  }
  try {
    const displayNames = new Intl.DisplayNames([navigator.language || "en-US"], { type: "region" });
    return String(displayNames.of(countryCode) || countryCode);
  } catch {
    return countryCode;
  }
}

// Build a short user-facing label for a selected radio catalog entry.
export function makeModelLabel(radio) {
  return `${radio.vendor} ${radio.model}`;
}

// Summarise channels the driver could not decode during a download or image
// load. Those slots are absent from the grid through no action of the user, so
// the status line has to say so; the tracebacks stay in Debug Output.
export function undecodedChannelsNote(unreadableChannels) {
  const count = Array.isArray(unreadableChannels) ? unreadableChannels.length : 0;
  if (!count) {
    return "";
  }
  return ` ${count} channel${count === 1 ? "" : "s"} could not be decoded and ${count === 1 ? "is" : "are"} not shown; see Debug Output.`;
}

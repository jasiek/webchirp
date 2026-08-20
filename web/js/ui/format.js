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

export function detectOperatingSystem() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) {
    return "Windows";
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return "macOS";
  }
  if (/Linux|X11/i.test(ua)) {
    return "Linux";
  }
  return "Other";
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

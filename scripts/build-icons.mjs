// Regenerates the PWA/home-screen icon set from a single emoji glyph:
//   web/images/icon-192.png            (manifest, purpose "any")
//   web/images/icon-512.png            (manifest, purpose "any")
//   web/images/icon-maskable-512.png   (manifest, purpose "maskable")
//   web/images/apple-touch-icon.png    (iOS "Add to Home Screen", 180x180)
//
// Usage: npm run build:icons
//
// No extra dependencies: drives a locally installed Chrome in headless mode
// over the DevTools protocol using Node's built-in WebSocket client, the same
// approach as scripts/update-screenshots.mjs.
//
// These are placeholder icons. The emoji is drawn from the system emoji font,
// so the exact glyph shape depends on the machine that runs this script —
// regenerate on one host and commit the PNGs rather than building them in CI.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRootDir, "web", "images");

// Radio emoji, matching the app's subject. U+1F4FB.
const GLYPH = "\u{1F4FB}";
// --accent / --accent-strong from web/styles.css, so the icon matches the app.
const BACKGROUND_TOP = "#0d5ea8";
const BACKGROUND_BOTTOM = "#20598d";

const ICONS = [
  // Android draws "any" icons without masking them, so these carry their own
  // rounded-square shape and leave the corners transparent.
  { file: "icon-192.png", size: 192, shape: "rounded", glyphScale: 0.62 },
  { file: "icon-512.png", size: 512, shape: "rounded", glyphScale: 0.62 },
  // Maskable icons are cropped to a platform shape, so the background runs
  // full-bleed and the glyph stays inside the 80% safe zone.
  { file: "icon-maskable-512.png", size: 512, shape: "square", glyphScale: 0.5 },
  // iOS applies its own mask and does not composite transparency, so this one
  // is square and opaque.
  { file: "apple-touch-icon.png", size: 180, shape: "square", glyphScale: 0.62 },
];

const RENDER_SETTLE_DELAY_MS = 250;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/pw-browsers/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No Chrome/Chromium binary found. Set CHROME_BIN to the browser executable path."
  );
}

async function launchChrome(chromeBinary, profileDir) {
  // Chrome's zygote sandbox refuses to start as root, which is the normal case
  // inside a container. Only drop it when we are actually root, so a developer
  // running this on a workstation keeps the sandbox.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const child = spawn(
    chromeBinary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      ...(isRoot ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let stderrText = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chrome DevTools endpoint.\n${stderrText}`));
    }, 20000);
    child.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
      const match = stderrText.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early with code ${code}.\n${stderrText}`));
    });
  });
  return { child, wsUrl };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`CDP ${message.error.message || JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)));
      socket.addEventListener("error", () => reject(new Error(`Failed to connect to ${wsUrl}`)));
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

// A single icon as a standalone document: the page IS the icon, so the
// screenshot needs no cropping.
function iconDocument({ size, shape, glyphScale }) {
  const radius = shape === "rounded" ? `${Math.round(size * 0.22)}px` : "0";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: ${size}px;
        height: ${size}px;
        background: transparent;
      }
      .icon {
        width: ${size}px;
        height: ${size}px;
        border-radius: ${radius};
        background: linear-gradient(160deg, ${BACKGROUND_TOP} 0%, ${BACKGROUND_BOTTOM} 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .glyph {
        font-family: "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
        font-size: ${Math.round(size * glyphScale)}px;
        line-height: 1;
      }
    </style>
  </head>
  <body><div class="icon"><span class="glyph">${GLYPH}</span></div></body>
</html>`;
}

async function captureIcon(cdp, sessionId, icon) {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: icon.size, height: icon.size, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  // Screenshots composite onto an opaque white page background by default,
  // which would fill the rounded icons' corners.
  await cdp.send(
    "Emulation.setDefaultBackgroundColorOverride",
    { color: { r: 0, g: 0, b: 0, a: 0 } },
    sessionId
  );

  const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
  await cdp.send(
    "Page.setDocumentContent",
    { frameId: frameTree.frame.id, html: iconDocument(icon) },
    sessionId
  );
  // The emoji font is loaded from disk, but layout still needs a frame to
  // settle before the glyph is painted at its final size.
  await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true }, sessionId);
  await delay(RENDER_SETTLE_DELAY_MS);

  const { data } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    sessionId
  );
  return Buffer.from(data, "base64");
}

async function main() {
  const chromeBinary = findChromeBinary();
  const profileDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "webchirp-icons-"));
  let chrome;
  let cdp;
  try {
    chrome = await launchChrome(chromeBinary, profileDir);
    cdp = await CdpClient.connect(chrome.wsUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);

    fs.mkdirSync(outputDir, { recursive: true });
    for (const icon of ICONS) {
      const pngBuffer = await captureIcon(cdp, sessionId, icon);
      const outputPath = path.join(outputDir, icon.file);
      fs.writeFileSync(outputPath, pngBuffer);
      console.log(
        `Wrote ${path.relative(repoRootDir, outputPath)} `
        + `(${icon.size}x${icon.size}, ${pngBuffer.length} bytes)`
      );
    }
  } finally {
    cdp?.close();
    chrome?.child.kill();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

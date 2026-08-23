// Regenerates the repository screenshots from the current version of the app:
//   images/screenshot.png               (README screenshot, 1600x1000)
//   images/screenshot-for-opengraph.png (OpenGraph card, 1200x630)
//   web/images/social-preview.png       (copy of the OpenGraph card served by the site)
//
// Usage: npm run screenshots
//
// No extra dependencies: serves web/ with scripts/dev-server.mjs, drives a
// locally installed Chrome in headless mode over the DevTools protocol using
// Node's built-in WebSocket client, waits until the selected radio schema has
// loaded, and queries live RSGB channels around IO82MM before capturing.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHOTS = [
  {
    width: 1600,
    height: 1000,
    outputs: [path.join(repoRootDir, "images", "screenshot.png")],
  },
  {
    width: 1200,
    height: 630,
    outputs: [
      path.join(repoRootDir, "images", "screenshot-for-opengraph.png"),
      path.join(repoRootDir, "web", "images", "social-preview.png"),
    ],
  },
];

const APP_READY_TIMEOUT_MS = 120000;
const APP_SETTLE_DELAY_MS = 3000;
const SCREENSHOT_LOCATOR = "IO82MM";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
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

async function startDevServer(port) {
  const child = spawn(process.execPath, [path.join(repoRootDir, "scripts", "dev-server.mjs")], {
    cwd: repoRootDir,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Dev server exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) {
        return child;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the dev server to start.");
    }
    await delay(200);
  }
}

async function launchChrome(chromeBinary, profileDir) {
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

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      || result.exceptionDetails.exception?.value
      || result.exceptionDetails.text;
    throw new Error(`Page evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

async function waitForAppReady(cdp, sessionId) {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  for (;;) {
    const ready = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const makeEl = document.querySelector("#radio-make");
        const debugOutput = document.querySelector("#debug-output");
        return Boolean(
          makeEl
          && !makeEl.disabled
          && makeEl.options.length > 0
          && /STATUS Loaded \\d+ radio definitions/.test(debugOutput?.value || "")
        );
      })()`
    );
    if (ready) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the radio catalog to load.");
    }
    await delay(500);
  }
}

// Release screenshots use the same reproducible, real-data starting point as
// manual captures: the default radio's schema populated from the RSGB query at
// IO82MM. Drive the public controls rather than reaching into module state, so
// the screenshot run also exercises the user-visible query path.
async function loadScreenshotChannels(cdp, sessionId) {
  const started = await evaluate(
    cdp,
    sessionId,
    `(() => {
      document.querySelector("#channel-import-rsgb")?.click();
      const locator = document.querySelector("#repeater-query-field-position-locator");
      const form = document.querySelector("#repeater-query-form");
      if (!locator || !form) {
        return false;
      }
      locator.value = ${JSON.stringify(SCREENSHOT_LOCATOR)};
      locator.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit();
      return true;
    })()`
  );
  if (!started) {
    throw new Error("Could not open and submit the RSGB screenshot query.");
  }

  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  for (;;) {
    const result = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const debugText = document.querySelector("#debug-output")?.value || "";
        const modalClosed = document.querySelector("#repeater-query-modal")?.classList.contains("hidden");
        if (modalClosed && /RSGB RESULTS /.test(debugText)) {
          return { done: true, count: globalThis.currentRows?.length || 0 };
        }
        const failed = debugText.match(/RSGB ETCC QUERY ERROR[^\\n]*/)?.[0] || "";
        return { done: false, failed };
      })()`
    );
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

async function captureShots(cdp, sessionId) {
  for (const shot of SHOTS) {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: shot.width, height: shot.height, deviceScaleFactor: 1, mobile: false },
      sessionId
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
      console.log(
        `Wrote ${path.relative(repoRootDir, outputPath)} (${shot.width}x${shot.height}, ${pngBuffer.length} bytes)`
      );
    }
  }
}

async function main() {
  const chromeBinary = findChromeBinary();
  const port = await findFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchirp-screenshot-"));
  let serverProcess;
  let chromeProcess;
  let cdp;
  try {
    console.log(`Starting dev server on port ${port}...`);
    serverProcess = await startDevServer(port);

    console.log(`Launching headless Chrome (${chromeBinary})...`);
    const chrome = await launchChrome(chromeBinary, profileDir);
    chromeProcess = chrome.child;
    cdp = await CdpClient.connect(chrome.wsUrl);

    const { targetId } = await cdp.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/`,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    console.log("Waiting for the app to finish loading (Pyodide + radio catalog)...");
    await waitForAppReady(cdp, sessionId);
    console.log(`Querying RSGB channels around ${SCREENSHOT_LOCATOR}...`);
    const channelCount = await loadScreenshotChannels(cdp, sessionId);
    console.log(`Loaded ${channelCount} RSGB channel(s) for the screenshots.`);
    await delay(APP_SETTLE_DELAY_MS);

    await captureShots(cdp, sessionId);
    console.log("Screenshots updated.");
  } finally {
    if (cdp) {
      cdp.close();
    }
    if (chromeProcess) {
      const chromeExited = new Promise((resolve) => {
        chromeProcess.once("exit", resolve);
        setTimeout(resolve, 5000);
      });
      chromeProcess.kill();
      await chromeExited;
    }
    if (serverProcess) {
      serverProcess.kill();
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await delay(500);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

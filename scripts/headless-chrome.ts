// The app served by scripts/dev-server.ts and driven in a locally installed
// headless Chrome over the DevTools protocol, with Node's built-in WebSocket
// client and no extra dependencies. Shared by the two screenshot scripts,
// scripts/update-screenshots.ts (the site's own images) and
// scripts/play-store-screenshots.ts (the Play Store listing).
//
// Both npm scripts that run them build the CHIRP archive (npm run build:chirp)
// first: the app's runtime fetches web/chirp/chirp-<pin>.zip at boot, which is
// generated and not checked in, so on a clean checkout the catalog would never
// load and a capture would time out waiting for it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { delay, findFreePort, inPageCall, radioCatalogLoaded } from "./app-driver.ts";

export const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const APP_READY_TIMEOUT_MS = 120000;

// The Chrome to drive: CHROME_BIN when set, else the first usual install
// location that exists.
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
    // filter(Boolean) dropped an unset CHROME_BIN, but does not narrow the type.
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No Chrome/Chromium binary found. Set CHROME_BIN to the browser executable path."
  );
}

// Starts scripts/dev-server.ts on port and resolves once it answers, so the
// first page load cannot race its startup.
async function startDevServer(port: number): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const child = spawn(process.execPath, [path.join(repoRootDir, "scripts", "dev-server.ts")], {
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

// Launches headless Chrome on a throwaway profile and resolves with the
// DevTools WebSocket address it prints once it listens.
async function launchChrome(
  chromeBinary: string,
  profileDir: string,
): Promise<{ child: ChildProcessByStdio<null, null, Readable>; wsUrl: string }> {
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
  const wsUrl = await new Promise<string>((resolve, reject) => {
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

// What a DevTools Protocol command resolves to: the protocol's own JSON, whose
// shape depends on the method, so each caller reads the fields it asked for.
export type CdpResult = any;

export class CdpClient {
  socket: WebSocket;
  nextId: number;
  pending: Map<number, { resolve: (result: CdpResult) => void; reject: (error: Error) => void }>;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      const waiter = message.id ? this.pending.get(message.id) : undefined;
      if (waiter) {
        const { resolve, reject } = waiter;
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`CDP ${message.error.message || JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  static connect(wsUrl: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)));
      socket.addEventListener("error", () => reject(new Error(`Failed to connect to ${wsUrl}`)));
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<CdpResult> {
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

// Evaluates expression in the page and returns its value, throwing the page's
// own exception text when it fails.
export async function evaluate(cdp: CdpClient, sessionId: string, expression: string): Promise<CdpResult> {
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

// Evaluates expression every half second until it returns something truthy,
// and returns that; what names the wait in the timeout's message.
export async function waitFor(
  cdp: CdpClient,
  sessionId: string,
  expression: string,
  what: string,
): Promise<CdpResult> {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  for (;;) {
    const value = await evaluate(cdp, sessionId, expression);
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await delay(500);
  }
}

// Resolves once the radio catalog has loaded, the point from which a user can
// pick a radio.
export function waitForAppReady(cdp: CdpClient, sessionId: string): Promise<void> {
  return waitFor(cdp, sessionId, inPageCall(radioCatalogLoaded), "the radio catalog to load");
}

export type HeadlessApp = {
  cdp: CdpClient;
  // The dev server's root, which serves web/index.html.
  appUrl: string;
  // A new tab, attached and still on about:blank, so the caller can set up
  // emulation and request interception before the app loads.
  openPage(): Promise<{ targetId: string; sessionId: string }>;
  close(): Promise<void>;
};

// Starts the dev server and headless Chrome, and returns what a screenshot
// script drives them with. close() stops both and removes the profile, and
// runs on a failed start too, so nothing is left running either way.
export async function startHeadlessApp(): Promise<HeadlessApp> {
  const chromeBinary = findChromeBinary();
  const port = await findFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "webchirp-screenshot-"));
  let serverProcess: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let chromeProcess: Awaited<ReturnType<typeof launchChrome>>["child"] | undefined;
  let cdp: CdpClient | undefined;

  async function close() {
    if (cdp) {
      cdp.close();
    }
    const chrome = chromeProcess;
    if (chrome) {
      const chromeExited = new Promise((resolve) => {
        chrome.once("exit", resolve);
        setTimeout(resolve, 5000);
      });
      chrome.kill();
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

  try {
    console.log(`Starting dev server on port ${port}...`);
    serverProcess = await startDevServer(port);
    console.log(`Launching headless Chrome (${chromeBinary})...`);
    const chrome = await launchChrome(chromeBinary, profileDir);
    chromeProcess = chrome.child;
    cdp = await CdpClient.connect(chrome.wsUrl);
  } catch (error) {
    await close();
    throw error;
  }

  const client = cdp;
  return {
    cdp: client,
    appUrl: `http://127.0.0.1:${port}/`,
    async openPage() {
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
      await client.send("Page.enable", {}, sessionId);
      await client.send("Runtime.enable", {}, sessionId);
      return { targetId, sessionId };
    },
    close,
  };
}

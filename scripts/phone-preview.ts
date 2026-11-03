// Opens the dev server in Chrome on an Android phone connected over adb, so a
// layout or touch change can be tried on a real phone. npm run phone checks
// that adb sees exactly one authorized phone, starts npm run dev when nothing
// answers on the dev server's port, maps that port onto the phone's own
// localhost with adb reverse and opens the page there. localhost keeps the
// page a secure context on the phone, so the service worker, WebUSB and Web
// Serial behave as they do on webchirp.org; a LAN address would not.
//
//   npm run phone                        the app
//   npm run phone -- serial-test.html    any page under web/, query included
//
// PORT picks the port as it does for scripts/dev-server.ts. With several
// phones attached, ANDROID_SERIAL (adb's own variable) names the one to use.
// When this script started the dev server it keeps running with it; Ctrl-C
// stops both. Inspect the phone's tab from desktop Chrome at
// chrome://inspect/#devices.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { defaultDevServerPort } from "./dev-server-port.ts";

const execFileAsync = promisify(execFile);

const CHROME_PACKAGE = "com.android.chrome";
// The first npm run dev builds the CHIRP bundle before it listens.
const DEV_SERVER_START_TIMEOUT_MS = 180_000;

export interface AdbDevice {
  serial: string;
  /** "device" once authorized; "unauthorized", "offline" and so on before. */
  state: string;
}

// The devices `adb devices` lists, from its output.
export function parseAdbDevices(output: string): AdbDevice[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state]) => ({ serial, state }));
}

// The phone to open the page on, or why there is none: the message says what
// to do about it on the phone.
export function choosePhone(devices: readonly AdbDevice[], wanted: string | undefined): AdbDevice | string {
  const candidates = wanted ? devices.filter((device) => device.serial === wanted) : devices;
  if (candidates.length === 0) {
    return wanted
      ? `adb does not list ${wanted} (ANDROID_SERIAL).`
      : "adb lists no phone. Turn on USB debugging in Developer options, then plug the phone in unlocked.";
  }
  if (candidates.length > 1) {
    return `adb lists ${candidates.map((device) => device.serial).join(", ")}: set ANDROID_SERIAL to the one to use.`;
  }
  const [phone] = candidates;
  if (phone.state === "unauthorized") {
    return `${phone.serial} has not trusted this computer: unlock it and tap Allow on "Allow USB debugging?".`;
  }
  if (phone.state !== "device") {
    return `${phone.serial} is ${phone.state}: unplug it and plug it back in.`;
  }
  return phone;
}

// The page's URL on the phone, from a path under web/ ("" for the app).
export function phoneUrl(port: number, page: string): string {
  return `http://localhost:${port}/${page.replace(/^\/+/, "")}`;
}

// Runs adb with args and returns what it printed; a failure rejects.
async function adb(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("adb", args);
  return stdout;
}

// Whether something answers HTTP on port, so a running dev server is reused
// rather than started twice.
async function devServerAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// Starts npm run dev on port and resolves once it answers. The server stays
// tied to this process: its output goes to this terminal and Ctrl-C stops it.
async function startDevServer(port: number): Promise<void> {
  console.log(`Nothing answers on port ${port}: starting npm run dev.`);
  const server = spawn("npm", ["run", "dev"], { env: { ...process.env, PORT: String(port) }, stdio: "inherit" });
  let exited = false;
  server.on("exit", (code) => {
    exited = true;
    process.exitCode = code ?? 1;
  });
  const deadline = Date.now() + DEV_SERVER_START_TIMEOUT_MS;
  while (!(await devServerAnswers(port))) {
    if (exited) {
      throw new Error("npm run dev exited before it answered.");
    }
    if (Date.now() > deadline) {
      server.kill();
      throw new Error(`npm run dev did not answer on port ${port} within ${DEV_SERVER_START_TIMEOUT_MS / 1000}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Checks the phone first, so a missing or untrusted phone fails before any
// dev server is started, then serves and opens the page.
async function main() {
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : defaultDevServerPort(process.cwd());
  const page = process.argv[2] ?? "";

  let devices: AdbDevice[];
  try {
    devices = parseAdbDevices(await adb("devices"));
  } catch {
    throw new Error("adb is not installed or not on PATH (brew install android-platform-tools).");
  }
  const phone = choosePhone(devices, process.env.ANDROID_SERIAL);
  if (typeof phone === "string") {
    throw new Error(phone);
  }

  if (!(await devServerAnswers(port))) {
    await startDevServer(port);
  }

  // -s names the phone even when ANDROID_SERIAL is unset and only one is listed.
  await adb("-s", phone.serial, "reverse", `tcp:${port}`, `tcp:${port}`);
  const url = phoneUrl(port, page);
  await adb("-s", phone.serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, CHROME_PACKAGE);
  console.log(`Opened ${url} in Chrome on ${phone.serial}. Inspect it at chrome://inspect/#devices.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

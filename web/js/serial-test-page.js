// Controller for serial-test.html: choose an adapter, run the loopback suite
// against whichever driver ends up behind it, and show the result.
//
// The page owns no test logic — every case lives in loopback-suite.js, which is
// also what the Node tests drive against fake hardware. This file is the
// hardware harness for the same suite: port selection, progress and reporting.

import { buildLoopbackIssueUrl } from "./loopback-issue.js";
import { formatLoopbackReport, runLoopbackSuite } from "./loopback-suite.js";
import { createWebUsbSerial } from "./webusb-serial.js";

// Which driver a port object represents. Nothing in the build minifies, so the
// constructor name is stable; the CDC polyfill and native Web Serial both call
// theirs SerialPort, so the chosen transport disambiguates them.
const DRIVER_LABELS = {
  FtdiSerialPort: "FTDI (WebUSB driver)",
  Pl2303SerialPort: "Prolific PL2303 (WebUSB driver)",
  Ch340SerialPort: "WCH CH340/CH341 (WebUSB driver)",
  Cp2102SerialPort: "Silicon Labs CP2102/CP210x (WebUSB driver)",
};

// Every element id this page owns, resolved in init() rather than at import so
// the module can be imported (and its pure helpers tested) outside a browser.
export const ELEMENT_IDS = {
  unsupported: "loopback-unsupported",
  transport: "loopback-transport",
  controlLines: "loopback-control-lines",
  choose: "loopback-choose",
  run: "loopback-run",
  adapter: "loopback-adapter",
  status: "loopback-status",
  results: "loopback-results",
  resultsBody: "loopback-results-body",
  reportWrap: "loopback-report-wrap",
  report: "loopback-report",
  copy: "loopback-copy",
  issue: "loopback-issue",
};

export const BAUD_CHECKBOX_SELECTOR = ".loopback-bauds input[type=checkbox]";

// version.json is written by `npm run build:version` and is not in the repo, so
// a tree served straight out of a checkout has none. Say so rather than leaving
// the field blank, which reads as "nobody bothered".
const UNKNOWN_VERSION = "unknown (version.json not served)";

let dom = null;
let chosenPort = null;
let chosenDescription = "";
let running = false;
// The run currently on screen: its totals, so the issue title can say how many
// cases failed without re-parsing the report, and the adapter it ran against,
// because choosing a different adapter afterwards must not relabel it.
let lastRun = null;
// Which commit of WebCHIRP is serving this page, from the build-time
// version.json. A report that does not name the code it came from cannot be
// checked against a fix, and the site updates under the tester's feet.
let webchirpVersion = UNKNOWN_VERSION;

function hex4(value) {
  return `0x${Number(value).toString(16).padStart(4, "0")}`;
}

function hasNativeSerial() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

function hasWebUsb() {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

function setStatus(text) {
  dom.status.textContent = text;
  dom.status.hidden = !text;
}

// Lock the whole form for the duration of a run, not just the buttons: the run
// reads its settings once at the start, so leaving the checkboxes live invites
// a change that silently does not apply.
function setControlsDisabled(disabled) {
  dom.run.disabled = disabled;
  dom.choose.disabled = disabled;
  dom.transport.disabled = disabled;
  dom.controlLines.disabled = disabled;
  for (const input of dom.bauds) {
    input.disabled = disabled;
  }
}

function selectedBaudRates() {
  return Array.from(dom.bauds)
    .filter((input) => input.checked)
    .map((input) => Number(input.value))
    .sort((a, b) => a - b);
}

// Name the driver actually in play — the whole point of the page is that you
// can see which one your cable resolved to before trusting the result.
export function describePort(port, transport) {
  const driver = DRIVER_LABELS[port.constructor?.name]
    || (transport === "webusb" ? "USB CDC-ACM (web-serial-polyfill)" : "Native Web Serial (OS driver)");
  let ids = "";
  try {
    const info = typeof port.getInfo === "function" ? port.getInfo() : {};
    if (info && info.usbVendorId !== undefined && info.usbVendorId !== null) {
      ids = ` — USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`;
    }
  } catch {
    // getInfo is optional on a port that has never been opened.
  }
  return `${driver}${ids}`;
}

async function requestPort(transport) {
  if (transport === "webusb") {
    if (!hasWebUsb()) {
      throw new Error("This browser does not support WebUSB.");
    }
    return { port: await createWebUsbSerial().requestPort(), transport: "webusb" };
  }
  if (transport === "webserial") {
    if (!hasNativeSerial()) {
      throw new Error("This browser does not support native Web Serial.");
    }
    return { port: await navigator.serial.requestPort(), transport: "webserial" };
  }
  if (hasNativeSerial()) {
    return { port: await navigator.serial.requestPort(), transport: "webserial" };
  }
  if (!hasWebUsb()) {
    throw new Error("This browser supports neither Web Serial nor WebUSB.");
  }
  return { port: await createWebUsbSerial().requestPort(), transport: "webusb" };
}

function appendResultRow(result) {
  const row = document.createElement("tr");
  row.className = `loopback-row is-${result.status}`;

  const mark = document.createElement("td");
  mark.className = "loopback-mark";
  mark.textContent = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";

  const title = document.createElement("td");
  title.textContent = result.title;

  const baud = document.createElement("td");
  baud.className = "loopback-baud";
  baud.textContent = result.baudRate ? String(result.baudRate) : "";

  const detail = document.createElement("td");
  detail.className = "loopback-detail";
  detail.textContent = result.detail || "";

  row.append(mark, title, baud, detail);
  dom.resultsBody.append(row);
}

// A header the report can be read out of context with: what was tested, on
// what, in which browser.
// `settings` is snapshotted when the run starts, never re-read from the DOM:
// a run takes tens of seconds, and a report pasted into an issue must describe
// the run that happened rather than whatever the controls say afterwards.
function buildReport(summary, settings) {
  return [
    `WebCHIRP: ${webchirpVersion}`,
    `Adapter: ${chosenDescription}`,
    `Browser: ${navigator.userAgent}`,
    `Baud rates: ${settings.baudRates.join(", ")}`,
    `Control lines bridged: ${settings.controlLines ? "yes" : "no"}`,
    "",
    formatLoopbackReport(summary),
  ].join("\n");
}

// Fetched once at load, not when a report is built: by then the tester may have
// walked away from the wifi with a phone and a radio, and a fetch that fails at
// that moment would quietly strip the version out of the report.
async function loadVersion() {
  try {
    const response = await fetch("./version.json", { cache: "no-cache" });
    if (!response.ok) {
      return;
    }
    const version = await response.json();
    if (version?.webchirpShaShort) {
      webchirpVersion = version.lastUpdated
        ? `${version.webchirpShaShort} (updated ${version.lastUpdated})`
        : version.webchirpShaShort;
    }
  } catch {
    // Non-essential; the report says the version is unknown.
  }
}

async function onChoose() {
  const transport = dom.transport.value;
  try {
    setStatus("");
    const chosen = await requestPort(transport);
    chosenPort = chosen.port;
    chosenDescription = describePort(chosen.port, chosen.transport);
    dom.adapter.textContent = `Adapter: ${chosenDescription}`;
    dom.run.disabled = false;
  } catch (error) {
    // A user dismissing the chooser is not an error worth shouting about.
    if (error?.name === "NotFoundError") {
      setStatus("No adapter selected.");
      return;
    }
    chosenPort = null;
    dom.run.disabled = true;
    dom.adapter.textContent = "No adapter chosen.";
    setStatus(`Could not open the device chooser: ${error?.message || error}`);
  }
}

async function onRun() {
  if (!chosenPort || running) {
    return;
  }
  const settings = { baudRates: selectedBaudRates(), controlLines: dom.controlLines.checked };
  if (settings.baudRates.length === 0) {
    setStatus("Select at least one baud rate.");
    return;
  }

  running = true;
  setControlsDisabled(true);
  dom.resultsBody.replaceChildren();
  dom.results.hidden = false;
  dom.reportWrap.hidden = true;
  lastRun = null;
  setStatus("Starting…");

  try {
    const summary = await runLoopbackSuite(chosenPort, {
      baudRates: settings.baudRates,
      controlLines: settings.controlLines,
      // Reported by the chip drivers; native ports do not expose it, and 64 is
      // the right assumption for a CDC endpoint.
      packetSize: Number(chosenPort.packetSize) || 64,
      onCase: (event) => {
        if (event.phase === "start") {
          setStatus(`Running: ${event.title}${event.baudRate ? ` @ ${event.baudRate} baud` : ""}`);
          return;
        }
        appendResultRow(event);
      },
    });
    dom.report.textContent = buildReport(summary, settings);
    lastRun = { summary, adapter: chosenDescription };
    dom.reportWrap.hidden = false;
    setStatus(
      `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`
      + (summary.failed === 0 ? " Adapter looks healthy." : " Check the TX-RX bridge before suspecting the driver."),
    );
  } catch (error) {
    // The suite turns case failures into results; reaching here means something
    // outside a case broke, so surface it rather than showing a partial pass.
    setStatus(`The run stopped: ${error?.message || error}`);
  } finally {
    running = false;
    setControlsDisabled(false);
  }
}

async function onCopy() {
  try {
    await navigator.clipboard.writeText(dom.report.textContent);
    setStatus("Report copied.");
  } catch {
    // Clipboard permission is commonly denied; selecting the text still works.
    setStatus("Could not copy — select the report text and copy it manually.");
  }
}

// The point of the button: on a phone, selecting the report out of a <pre>,
// switching to GitHub and pasting it is what stops a failure being reported at
// all. Opening the pre-filled form is done straight from the click so the tap
// still counts as a user gesture and the tab is not blocked as a pop-up.
function onReportIssue() {
  const url = buildLoopbackIssueUrl({
    report: dom.report.textContent,
    adapter: lastRun?.adapter || chosenDescription,
    summary: lastRun?.summary,
    version: webchirpVersion,
    userAgent: navigator.userAgent,
  });
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    setStatus("The browser blocked the new tab — use Copy report and paste it into an issue.");
    return;
  }
  setStatus("Opened a pre-filled GitHub issue — add what you were doing and submit it.");
}

function init() {
  dom = { bauds: document.querySelectorAll(BAUD_CHECKBOX_SELECTOR) };
  const missing = [];
  for (const [key, id] of Object.entries(ELEMENT_IDS)) {
    dom[key] = document.getElementById(id);
    if (!dom[key]) {
      missing.push(id);
    }
  }
  // Same contract index.html has with dom.js: name everything missing at once
  // rather than failing later at the control that no longer works.
  if (missing.length > 0) {
    throw new Error(`serial-test.html is missing elements: ${missing.join(", ")}`);
  }

  if (!hasNativeSerial() && !hasWebUsb()) {
    dom.unsupported.hidden = false;
    dom.choose.disabled = true;
    dom.run.disabled = true;
    return;
  }
  dom.choose.addEventListener("click", onChoose);
  dom.run.addEventListener("click", onRun);
  dom.copy.addEventListener("click", onCopy);
  dom.issue.addEventListener("click", onReportIssue);
  loadVersion();
}

if (typeof document !== "undefined") {
  init();
}

import { detectBrowserVersion, detectOperatingSystem } from "./format.js";

const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";
// GitHub answers over-long prefill URLs with HTTP 414 instead of the form, and
// a long debug session can produce a query string many times that size. There
// is no POST prefill to fall back on — the issue form only reads query params —
// so the whole URL is budgeted and the debug excerpt is trimmed to fit.
const ISSUE_URL_LIMIT = 6000;
// Ask the panel for more lines than will usually fit: the URL budget above is
// the real governor, so short lines buy more context instead of wasting room.
const DEBUG_TAIL_LINES = 120;
const NO_DEBUG_PLACEHOLDER = "<no debug logs captured>";
const TRUNCATION_NOTE =
  "<earlier debug lines trimmed - use Copy in Debug Output for the full log>";

// Drop the date and sub-second precision from log stamps: within one report the
// date never varies and the wall clock only matters for ordering, so this buys
// ~30 encoded characters a line of excerpt budget for free.
function compactDebugLines(tail) {
  return String(tail || "")
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line.replace(/^\[\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})[.\d]*Z?\]\s*/, "[$1] "),
    );
}

// Keep the newest lines — the failure is at the tail — and add older ones while
// the built URL still fits. `measure` builds the real URL rather than estimating
// the encoded size, because the estimate and URLSearchParams disagree on every
// space, and a debug tail is mostly spaces.
function fitDebugExcerpt(lines, measure, limit) {
  if (!lines.length) {
    return NO_DEBUG_PLACEHOLDER;
  }
  const whole = lines.join("\n");
  if (measure(whole) <= limit) {
    return whole;
  }

  let kept = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = [TRUNCATION_NOTE, lines[index], ...kept];
    if (measure(candidate.join("\n")) > limit) {
      break;
    }
    kept = candidate.slice(1);
  }
  return [TRUNCATION_NOTE, ...kept].join("\n");
}

// Pre-fills the GitHub bug-report template with the selected radio, the USB ids
// seen on the last connect, the browser/OS, the CHIRP revision, and a tail of
// the debug panel — so a report arrives with the diagnostics already attached.
export function createIssueReporter({ state, log }) {
  function buildIssueUrl() {
    // Read the selection from state, never from the make/model dropdowns: every
    // path that sets those also sets state.selectedRadio, so the dropdowns are
    // a copy that can only drift, never a better answer.
    const radioMake = state.selectedRadio?.vendor || "Not selected";
    const radioModel = state.selectedRadio?.model || "Not selected";
    const lastErrorSummary = log.getLastErrorSummary();
    const bugSummary = lastErrorSummary || "manual report";
    const issueTitle = `Bug report: ${radioMake} ${radioModel} - ${bugSummary}`;
    const steps = [
      "1. Open WebCHIRP",
      "2. Select a radio make/model if relevant",
      "3. Perform the action that shows the bug",
      "4. Describe what happened",
    ].join("\n");

    const buildUrl = (debugExcerpt) => {
      const actualBehavior = [
        lastErrorSummary || "Manual report with no captured runtime error yet.",
        "",
        "Debug output excerpt:",
        "```",
        debugExcerpt,
        "```",
      ].join("\n");
      const params = new URLSearchParams({
        template: ISSUE_TEMPLATE_NAME,
        title: issueTitle.slice(0, 240),
        radio_make: radioMake,
        radio_model: radioModel,
        usb_vendor_id: state.lastUsbVendorId || "Unknown / not connected",
        usb_product_id: state.lastUsbProductId || "Unknown / not connected",
        operating_system: detectOperatingSystem(),
        browser_and_version: detectBrowserVersion(),
        chirp_revision: state.runtimeInfo.chirpRevision || "unknown",
        steps_to_reproduce: steps,
        expected_behavior: "The reported action should work without the observed bug.",
        actual_behavior: actualBehavior,
      });
      return `${ISSUE_NEW_URL}?${params.toString()}`;
    };

    // The fixed fields alone can overrun the limit on a pathological error
    // summary, in which case no debug line fits and only the truncation note
    // survives — the report is still worth filing without the excerpt.
    const excerpt = fitDebugExcerpt(
      compactDebugLines(log.latestDebugTail(DEBUG_TAIL_LINES)),
      (debugExcerpt) => buildUrl(debugExcerpt).length,
      ISSUE_URL_LIMIT,
    );
    return buildUrl(excerpt);
  }

  function openPrefilledIssue() {
    const url = buildIssueUrl();
    window.open(url, "_blank", "noopener,noreferrer");
    log.logDebug("Opened pre-filled GitHub issue form.");
  }

  return { buildIssueUrl, openPrefilledIssue };
}

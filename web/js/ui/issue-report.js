import { detectBrowserVersion, detectOperatingSystem } from "./format.js";

const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";
// How much of the debug panel rides along. This is the knob that decides the
// URL length in practice: 40 lines holds a full CHIRP traceback plus the serial
// traffic leading up to it, for roughly a 3k-character URL.
const DEBUG_TAIL_LINES = 40;
// Backstop only. GitHub answers over-long prefill URLs with HTTP 414 instead of
// the form, and there is no POST prefill to fall back on — the issue form only
// reads query params. Normal lines never reach this; one pathological line (a
// hex dump, a single-line traceback) would, so the built URL is measured and
// trimmed rather than trusted to the line count alone.
const ISSUE_URL_LIMIT = 6000;
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
function fitDebugExcerpt(lines, { measure, limit, alreadyTrimmed }) {
  if (!lines.length) {
    return NO_DEBUG_PLACEHOLDER;
  }
  const head = alreadyTrimmed ? [TRUNCATION_NOTE] : [];
  const whole = [...head, ...lines].join("\n");
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
    // Read the selection from state, never from the sidebar readout: every
    // path that names a radio there also sets state.selectedRadio, so the
    // rendered text is a copy that can only drift, never a better answer.
    const radioMake = state.selectedRadio?.vendor || "Not selected";
    const radioModel = state.selectedRadio?.model || "Not selected";
    const lastErrorSummary = log.getLastErrorSummary();
    const bugSummary = lastErrorSummary || "manual report";
    const issueTitle = `Bug report: ${radioMake} ${radioModel} - ${bugSummary}`;
    const steps = [
      "1. Open WebCHIRP",
      "2. Select a radio if relevant",
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

    // Ask for one line more than is kept: getting it back is how we learn the
    // panel held more than the excerpt shows, so the report can say the log was
    // cut rather than looking like the session started at the first line here.
    const available = compactDebugLines(log.latestDebugTail(DEBUG_TAIL_LINES + 1));
    const cutByLineCount = available.length > DEBUG_TAIL_LINES;

    // The fixed fields alone can overrun the limit on a pathological error
    // summary, in which case no debug line fits and only the truncation note
    // survives — the report is still worth filing without the excerpt.
    const excerpt = fitDebugExcerpt(available.slice(cutByLineCount ? 1 : 0), {
      measure: (debugExcerpt) => buildUrl(debugExcerpt).length,
      limit: ISSUE_URL_LIMIT,
      alreadyTrimmed: cutByLineCount,
    });
    return buildUrl(excerpt);
  }

  function openPrefilledIssue() {
    const url = buildIssueUrl();
    window.open(url, "_blank", "noopener,noreferrer");
    log.logDebug("Opened pre-filled GitHub issue form.");
  }

  return { buildIssueUrl, openPrefilledIssue };
}

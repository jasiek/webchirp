import { detectBrowserVersion, detectOperatingSystem } from "./format.js";

const ISSUE_TEMPLATE_NAME = "radio_bug_report.yml";
const ISSUE_NEW_URL = "https://github.com/jasiek/webchirp/issues/new";

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
    const debugTail = log.latestDebugTail(120);
    const steps = [
      "1. Open WebCHIRP",
      "2. Select a radio make/model if relevant",
      "3. Perform the action that shows the bug",
      "4. Describe what happened",
    ].join("\n");
    const actualBehavior = [
      lastErrorSummary || "Manual report with no captured runtime error yet.",
      "",
      "Debug output excerpt:",
      "```",
      debugTail || "<no debug logs captured>",
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
  }

  function openPrefilledIssue() {
    const url = buildIssueUrl();
    window.open(url, "_blank", "noopener,noreferrer");
    log.logDebug("Opened pre-filled GitHub issue form.");
  }

  return { buildIssueUrl, openPrefilledIssue };
}

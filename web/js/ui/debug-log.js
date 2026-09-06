import { errorDetails } from "./format.js";
import { trackEvent } from "./analytics.js";

// The bottom debug panel is the single sink for status text, serial traffic and
// full error detail. Keeping every write in one module preserves the rule that
// full errors and tracebacks always reach the panel.
export function createDebugLog({ dom }) {
  let lastErrorSummary = "";

  function isExpanded() {
    return dom.debugToggleEl.getAttribute("aria-expanded") === "true";
  }

  function setExpanded(expanded) {
    const nextExpanded = Boolean(expanded);
    dom.debugToggleEl.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    dom.debugActionsEl.hidden = !nextExpanded;
    dom.debugOutputContentEl.hidden = !nextExpanded;
  }

  // Establish the default before any runtime work can log. bindEvents() must
  // not reset it later, because an error may arrive before listeners bind.
  setExpanded(false);

  function captureErrorSummary(line) {
    const text = String(line || "");
    lastErrorSummary = text.replace(/\s+/g, " ").trim().slice(0, 180);
    // Routine diagnostics stay out of the way, but errors should never be
    // hidden behind a disclosure the user does not yet know to open.
    setExpanded(true);
  }

  // Append a timestamped line to the bottom debug console panel.
  //
  // `isError` does two things at once: it reveals the panel and it captures the
  // line as the Report Bug prefill. `reveal` asks for only the first, for a
  // line the user must see that is not a defect -- an action they cancelled
  // themselves. Filing that as the latest error would title their next bug
  // report after something they chose to do.
  function logDebug(line, { isError = false, reveal = false } = {}) {
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${String(line || "")}`;
    const current = dom.debugOutputEl.value ? `${dom.debugOutputEl.value}\n` : "";
    dom.debugOutputEl.value = `${current}${text}`;
    if (isError) {
      captureErrorSummary(line);
    } else if (reveal) {
      setExpanded(true);
    }
    // Error capture may have made the textarea measurable by expanding it;
    // scroll afterwards so the triggering line is the one the user sees.
    dom.debugOutputEl.scrollTop = dom.debugOutputEl.scrollHeight;
  }

  function logError(line) {
    logDebug(line, { isError: true });
  }

  // Emit status updates into the debug output stream.
  function setStatus(text) {
    logDebug(`STATUS ${text}`);
  }

  // Record serial-related events in the central debug output stream.
  function logSerial(line) {
    logDebug(`SERIAL ${String(line || "")}`);
  }

  // Centralized UI + debug handling for action-level failures.
  function reportActionError(action, error) {
    const details = errorDetails(error);
    logError(`${action.toUpperCase()} ERROR\n${details}`);
    setStatus(`${action} failed (see Debug Output).`);
  }

  // Report an action the user called off themselves, such as dismissing the
  // browser's serial port chooser. It reveals the panel because this app has no
  // other visible surface for a message -- silence made a dismissed chooser
  // indistinguishable from a Connect click that never registered -- but it is
  // not a failure: it carries the plain sentence rather than a traceback, and
  // stays out of the Report Bug prefill.
  function reportActionCancelled(action, message) {
    logDebug(`${action.toUpperCase()} CANCELLED ${message}`, { reveal: true });
    setStatus(`${action} cancelled.`);
  }

  function latestDebugTail(lineCount) {
    const lines = String(dom.debugOutputEl.value || "")
      .split("\n")
      .filter(Boolean);
    if (lines.length <= lineCount) {
      return lines.join("\n");
    }
    return lines.slice(lines.length - lineCount).join("\n");
  }

  function clear() {
    dom.debugOutputEl.value = "";
    lastErrorSummary = "";
  }

  // Hand the whole log to the clipboard. Falls back to selecting the text when
  // the async clipboard API is unavailable or blocked, so the user can always
  // get the diagnostics out of the panel by hand.
  async function copyToClipboard() {
    const text = dom.debugOutputEl.value || "";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        dom.debugOutputEl.focus();
        dom.debugOutputEl.select();
        document.execCommand("copy");
      }
      setStatus("Debug log copied to clipboard.");
    } catch (error) {
      logError(`DEBUG COPY ERROR\n${errorDetails(error)}`);
      dom.debugOutputEl.focus();
      dom.debugOutputEl.select();
      setStatus("Could not copy automatically; log text is selected — copy it manually.");
    }
  }

  function bindEvents() {
    dom.debugToggleEl.addEventListener("click", () => {
      setExpanded(!isExpanded());
    });
    dom.debugClearEl.addEventListener("click", () => {
      clear();
    });
    dom.debugCopyEl.addEventListener("click", () => {
      // Copying the log almost always means something went wrong and the user
      // is taking the evidence somewhere. The log contents are not reported —
      // only that this happened.
      trackEvent("debug_log_copied");
      copyToClipboard();
    });
  }

  return {
    bindEvents,
    logDebug,
    logError,
    logSerial,
    setStatus,
    reportActionError,
    reportActionCancelled,
    latestDebugTail,
    clear,
    copyToClipboard,
    getLastErrorSummary: () => lastErrorSummary,
  };
}

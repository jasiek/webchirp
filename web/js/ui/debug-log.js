import { errorDetails } from "./format.js";
import { classifyErrorKind, errorTypeName, trackEvent } from "./analytics.js";
import { captureError } from "../sentry.js";
import { isBootstrapFailure } from "../runtime-bootstrap.mjs";
import { isUserPreconditionFailure, runtimeErrorSentence } from "../runtime-errors.mjs";

// The bottom debug panel is the single sink for status text, serial traffic and
// full error detail. Keeping every write in one module preserves the rule that
// full errors and tracebacks always reach the panel.
export function createDebugLog({ dom, notice } = {}) {
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
  //
  // Every action-level failure in the app already funnels through here, which
  // makes it the one place error reporting has to be wired in: a clone that
  // died on a checksum, a driver import that never resolved and a CSV that
  // would not parse all arrive with the CHIRP traceback still attached. The
  // same classification analytics uses is sent as tags, so a kind that is
  // routine rather than a defect -- a dismissed dialog, an offline lookup --
  // can be filtered out in Sentry instead of being reported twice under two
  // different vocabularies.
  //
  // Cancellations deliberately do not come through here: reportActionCancelled
  // below is what a user calling something off reaches, and that is not a bug.
  function reportActionError(action, error) {
    const details = errorDetails(error);
    if (isUserPreconditionFailure(error)) {
      reportActionBlocked(action, error, details);
      return;
    }
    logError(`${action.toUpperCase()} ERROR\n${details}`);
    setStatus(`${action} failed (see Debug Output).`);
    // A failed runtime bootstrap has already been captured as a runtime crash,
    // under a tag this funnel cannot produce. It still reaches here because it
    // returns through whichever action was in flight, so capturing again would
    // file one failure as two Sentry events. The log line and the status stay:
    // the user still needs to see which action died.
    if (isBootstrapFailure(error)) {
      return;
    }
    captureError(error, {
      action,
      tags: { error_kind: classifyErrorKind(error), error_type: errorTypeName(error) },
    });
  }

  // Report an action the runtime refused because the user has not done a step
  // it depends on -- pressing Upload before anything has been downloaded. The
  // message such a failure carries is already the instruction that clears it,
  // so it gets the modal (web/js/ui/notice-modal.js) rather than the treatment
  // a defect gets, for the same reasons a cancellation does: it does not open
  // the debug panel in the user's face, it does not become the title of their
  // next bug report, and it is not reported to Sentry (IGNORE_ERRORS,
  // web/js/sentry.js drops it by exception class).
  //
  // The full traceback still goes to the panel, unconditionally: whatever the
  // UI makes of a failure, the panel is where all of it lands.
  function reportActionBlocked(action, error, details) {
    const sentence = runtimeErrorSentence(error);
    logDebug(`${action.toUpperCase()} BLOCKED\n${details}`);
    setStatus(`${action} blocked: ${sentence}`);
    notice?.show({ title: `${action} not possible yet`, message: sentence });
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

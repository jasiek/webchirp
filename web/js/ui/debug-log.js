import { errorDetails } from "./format.js";

// The bottom debug panel is the single sink for status text, serial traffic and
// full error detail. Keeping every write in one module preserves the rule that
// full errors and tracebacks always reach the panel.
export function createDebugLog({ dom }) {
  let lastErrorSummary = "";

  function captureErrorSummary(line) {
    const text = String(line || "");
    if (!/\b(error|traceback|exception)\b/i.test(text)) {
      return;
    }
    lastErrorSummary = text.replace(/\s+/g, " ").trim().slice(0, 180);
  }

  // Append a timestamped line to the bottom debug console panel.
  function logDebug(line) {
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${String(line || "")}`;
    const current = dom.debugOutputEl.value ? `${dom.debugOutputEl.value}\n` : "";
    dom.debugOutputEl.value = `${current}${text}`;
    dom.debugOutputEl.scrollTop = dom.debugOutputEl.scrollHeight;
    captureErrorSummary(line);
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
    logDebug(`${action.toUpperCase()} ERROR\n${details}`);
    setStatus(`${action} failed (see Debug Output).`);
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

  return {
    logDebug,
    logSerial,
    setStatus,
    reportActionError,
    latestDebugTail,
    clear,
    getLastErrorSummary: () => lastErrorSummary,
  };
}

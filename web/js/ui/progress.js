// The app-wide progress strip above Debug Output. Any long runtime operation
// that is not owned by one panel reports here; the matching narration goes to
// the debug log, so the strip stays a single concise line.
//
// Deliberately not #clone-progress: that one lives inside a collapsible sidebar
// <details>, so it is invisible whenever the user has that section closed.
export function createProgress({ dom }) {
  // Only the operation that began the strip may update or end it. Without this
  // a slow operation finishing late would tear down the bar a newer one is
  // using, or repaint it with stale text.
  let activeToken = null;
  let nextToken = 0;

  function render(label, cur, max) {
    dom.appProgressLabelEl.textContent = String(label || "Working...");
    // A count is only meaningful once we know the total; drivers report one,
    // clone-style byte loops may not.
    if (Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur >= 0) {
      const bounded = Math.min(cur, max);
      dom.appProgressBarEl.value = Math.round((bounded / max) * 100);
      dom.appProgressCountEl.textContent = `${bounded} / ${max}`;
    } else {
      // Removing value is what makes <progress> indeterminate again; leaving a
      // stale percentage on screen would misreport an unbounded operation.
      dom.appProgressBarEl.removeAttribute("value");
      dom.appProgressCountEl.textContent = "";
    }
  }

  // Show the strip and return the handle used to drive it.
  function begin(label, max) {
    nextToken += 1;
    activeToken = nextToken;
    const token = activeToken;
    render(label, 0, max);
    dom.appProgressEl.hidden = false;

    return {
      update(cur, nextLabel) {
        if (activeToken !== token) {
          return;
        }
        render(nextLabel || dom.appProgressLabelEl.textContent, cur, max);
      },
      end() {
        if (activeToken !== token) {
          return;
        }
        activeToken = null;
        dom.appProgressEl.hidden = true;
        dom.appProgressBarEl.removeAttribute("value");
        dom.appProgressLabelEl.textContent = "";
        dom.appProgressCountEl.textContent = "";
      },
    };
  }

  function isVisible() {
    return !dom.appProgressEl.hidden;
  }

  return { begin, isVisible };
}

// Custom tooltip layer. Browsers show native `title` tooltips after their own
// fixed delay (~1s in Chrome) which cannot be configured, so this replaces
// them with a styled bubble (.app-tooltip in styles.css) that consistently
// appears 400ms after hover. Titles are stashed in data-tooltip while hovered
// so the native tooltip never appears alongside ours; pointer events are used
// because (unlike mouse events) they also fire on disabled form controls.
const TOOLTIP_DELAY_MS = 400;

export function installTooltips({ delayMs = TOOLTIP_DELAY_MS } = {}) {
  const bubble = document.createElement("div");
  bubble.className = "app-tooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  document.body.appendChild(bubble);

  let activeEl: HTMLElement | SVGElement | null = null;
  let showTimer = 0;
  let pointerX = 0;
  let pointerY = 0;

  // Move the title into data-tooltip so the browser's own tooltip is
  // suppressed while we own the hover. Returns the tooltip text.
  function stashTitle(el) {
    const title = el.getAttribute("title");
    if (title) {
      el.dataset.tooltip = title;
      el.removeAttribute("title");
    }
    return el.dataset.tooltip || "";
  }

  function restoreTitle(el) {
    // Skip the restore if code set a fresh title while we were hovering
    // (e.g. connect toggles rewriting their state tooltips).
    if (el.dataset.tooltip && !el.hasAttribute("title")) {
      el.setAttribute("title", el.dataset.tooltip);
    }
    delete el.dataset.tooltip;
  }

  function hide() {
    clearTimeout(showTimer);
    showTimer = 0;
    if (activeEl) {
      restoreTitle(activeEl);
    }
    activeEl = null;
    bubble.hidden = true;
  }

  function show() {
    if (!activeEl || !activeEl.isConnected || !activeEl.dataset.tooltip) {
      hide();
      return;
    }
    bubble.textContent = activeEl.dataset.tooltip;
    bubble.hidden = false;
    // Position near the pointer like a native tooltip, clamped to the viewport.
    const margin = 8;
    const rect = bubble.getBoundingClientRect();
    let x = pointerX + 12;
    let y = pointerY + 20;
    if (x + rect.width + margin > window.innerWidth) {
      x = window.innerWidth - rect.width - margin;
    }
    if (y + rect.height + margin > window.innerHeight) {
      y = pointerY - rect.height - 10;
    }
    bubble.style.left = `${Math.max(margin, x)}px`;
    bubble.style.top = `${Math.max(margin, y)}px`;
  }

  document.addEventListener("pointerover", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    // Titled elements in this app are HTML or SVG, both of which have dataset.
    const el = event.target instanceof Element
      ? (event.target.closest("[title], [data-tooltip]") as HTMLElement | SVGElement | null)
      : null;
    if (el === activeEl) {
      return;
    }
    hide();
    if (!el) {
      return;
    }
    activeEl = el;
    if (!stashTitle(el)) {
      activeEl = null;
      return;
    }
    showTimer = setTimeout(show, delayMs);
  }, true);

  document.addEventListener("pointermove", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  }, true);

  document.addEventListener("pointerout", (event) => {
    if (!activeEl) {
      return;
    }
    const to = event.relatedTarget;
    if (to instanceof Node && activeEl.contains(to)) {
      return;
    }
    hide();
  }, true);

  // Clicking, scrolling, or leaving the window dismisses the tooltip, same as
  // the native behavior it replaces.
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}

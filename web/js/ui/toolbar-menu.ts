import type { UiContext } from "../types/ui-context.js";

// The phone toolbar's fold. On a narrow screen only Load and Export share the
// row with the title; Install, the site links and the community marks sit in
// #toolbar-more behind a toggle. Wider than that the stylesheet hides the toggle
// and dissolves the group into the row, so the open state below only ever
// shows on a phone and is harmless anywhere else.
export function createToolbarMenu(ctx: UiContext): {
  bindEvents(): void;
  isOpen(): boolean;
  close(): void;
} {
  const { dom } = ctx;

  // Keep the group's visibility and the toggle's expanded state in step.
  function setOpen(open: boolean): void {
    dom.toolbarMoreEl.classList.toggle("is-open", open);
    dom.toolbarMoreToggleEl.setAttribute("aria-expanded", String(open));
  }

  // Report whether the fold is showing, for the global Escape handler.
  function isOpen(): boolean {
    return dom.toolbarMoreEl.classList.contains("is-open");
  }

  // Fold the group away again.
  function close(): void {
    setOpen(false);
  }

  // The toggle opens and closes the group; a tap anywhere outside it, or on
  // one of its controls, folds it away, the same as the export menu.
  function bindEvents(): void {
    dom.toolbarMoreToggleEl.addEventListener("click", () => {
      setOpen(!isOpen());
    });

    dom.toolbarMoreEl.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a, button")) {
        close();
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target as Node;
      if (isOpen()
        && !dom.toolbarMoreToggleEl.contains(target)
        && !dom.toolbarMoreEl.contains(target)) {
        close();
      }
    });
  }

  return { bindEvents, isOpen, close };
}

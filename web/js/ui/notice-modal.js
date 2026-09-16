// One modal for the messages the user has to read and act on, as opposed to the
// failures a developer has to read.
//
// The app has exactly one visible surface for anything that goes wrong -- the
// Debug Output panel at the bottom -- and it is the right surface for a
// traceback and the wrong one for an instruction: it is folded away until
// something opens it, and what it shows is a Python stack. So "Download from
// radio first, then upload." was being delivered as a crash report, to the one
// class of user who had done nothing wrong.
//
// Nothing here knows about uploads or radios. It is handed a title and a
// sentence, which is all a notice ever is; web/js/ui/debug-log.js decides which
// failures get one (RuntimePreconditionError, recognised by
// web/js/runtime-errors.mjs).
export function createNoticeModal(ctx) {
  const { dom } = ctx;
  // What had focus when the notice opened, so dismissing it puts the user back
  // where they were rather than at the top of the document.
  let previousFocus = null;

  function isModalOpen() {
    return !dom.noticeModalEl.classList.contains("hidden");
  }

  function closeModal() {
    if (!isModalOpen()) {
      return;
    }
    dom.noticeModalEl.classList.add("hidden");
    const restoreTo = previousFocus;
    previousFocus = null;
    restoreTo?.focus?.();
  }

  // Show one notice. A second one arriving while the first is open replaces it:
  // a queue would make the user dismiss a message about something they have
  // since moved on from, and these are not events to be accounted for -- each
  // one describes the state the app is in right now.
  function show({ title, message }) {
    if (!isModalOpen()) {
      previousFocus = document.activeElement;
    }
    dom.noticeTitleEl.textContent = String(title || "");
    dom.noticeMessageEl.textContent = String(message || "");
    dom.noticeModalEl.classList.remove("hidden");
    // The dismiss button, so Enter and Space close the notice without the user
    // having to find the mouse. Escape is handled globally in web/js/ui.js.
    dom.noticeDismissEl.focus?.();
  }

  function bindEvents() {
    dom.noticeDismissEl.addEventListener("click", () => {
      closeModal();
    });
    // Clicking the backdrop dismisses, matching the import prompt. The target
    // check is what separates the backdrop from the card sitting on it.
    dom.noticeModalEl.addEventListener("click", (event) => {
      if (event.target === dom.noticeModalEl) {
        closeModal();
      }
    });
  }

  return { bindEvents, show, closeModal, isModalOpen };
}

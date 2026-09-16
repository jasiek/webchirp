// The modal that carries a message the user has to act on, rather than a
// traceback for a developer. What matters about it is small and easy to lose:
// it has to open with the text it was handed, close by every route a user will
// try, and hand the keyboard back to whatever it interrupted.

import assert from "node:assert/strict";
import test from "node:test";

import { createNoticeModal } from "../../web/js/ui/notice-modal.js";
import { closeVivifiedModals, installFakeDom, keydownEvent } from "../support/fake-dom.mjs";

// The four elements dom.js resolves for this modal, in the state index.html
// ships them in.
function bootNotice() {
  const { document, restore } = installFakeDom();
  const dom = {
    noticeModalEl: document.querySelector("#notice-modal"),
    noticeTitleEl: document.querySelector("#notice-title"),
    noticeMessageEl: document.querySelector("#notice-message"),
    noticeDismissEl: document.querySelector("#notice-dismiss"),
  };
  dom.noticeModalEl.classList.add("hidden");
  const notice = createNoticeModal({ dom });
  notice.bindEvents();
  return { document, dom, notice, restore };
}

test("a notice opens with the text it was given and closes on the button", () => {
  const { dom, notice, restore } = bootNotice();
  try {
    assert.equal(notice.isModalOpen(), false);

    notice.show({ title: "Upload not possible yet", message: "Download from radio first." });

    assert.equal(notice.isModalOpen(), true);
    assert.equal(dom.noticeTitleEl.textContent, "Upload not possible yet");
    assert.equal(dom.noticeMessageEl.textContent, "Download from radio first.");
    // Focus is on the button so Enter dismisses without reaching for a mouse.
    assert.equal(dom.noticeDismissEl.focused, true);

    dom.noticeDismissEl.click();
    assert.equal(notice.isModalOpen(), false);
  } finally {
    restore();
  }
});

test("clicking the backdrop dismisses, clicking the card does not", () => {
  const { dom, notice, restore } = bootNotice();
  try {
    notice.show({ title: "Title", message: "Message" });

    // A click that started inside the card bubbles to the overlay with the card
    // as its target; only the overlay itself is the backdrop.
    dom.noticeModalEl.dispatchEvent({ type: "click", target: dom.noticeMessageEl });
    assert.equal(notice.isModalOpen(), true);

    dom.noticeModalEl.dispatchEvent({ type: "click", target: dom.noticeModalEl });
    assert.equal(notice.isModalOpen(), false);
  } finally {
    restore();
  }
});

test("dismissing hands the keyboard back to what the notice interrupted", () => {
  const { document, dom, notice, restore } = bootNotice();
  try {
    const uploadButton = document.querySelector("#radio-upload");
    document.activeElement = uploadButton;

    notice.show({ title: "Title", message: "Message" });
    dom.noticeDismissEl.click();

    assert.equal(uploadButton.focused, true);
  } finally {
    restore();
  }
});

test("a second notice replaces the first rather than queueing behind it", () => {
  const { dom, notice, restore } = bootNotice();
  try {
    notice.show({ title: "First", message: "One" });
    notice.show({ title: "Second", message: "Two" });

    assert.equal(dom.noticeTitleEl.textContent, "Second");
    assert.equal(dom.noticeMessageEl.textContent, "Two");
    // One dismissal, not two: the first notice was replaced, not stacked.
    dom.noticeDismissEl.click();
    assert.equal(notice.isModalOpen(), false);
  } finally {
    restore();
  }
});

// Escape is bound once in web/js/ui.js rather than per module, and the notice
// is checked before every other surface, so a notice raised over an open modal
// is what Escape closes first -- and the modal underneath it stays open, which
// is the half that would break if the notice were appended to the chain rather
// than put at its head.
test("Escape closes the notice first, leaving the modal underneath it open", async () => {
  const { document, restore } = installFakeDom();
  try {
    const { createUiController } = await import("../../web/js/ui.js");
    const ui = createUiController();
    ui.setRuntimeApi({
      listRadios: async () => ({ radios: [] }),
      getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
      getDefaultSchema: async () => ({ headers: ["Location", "Name"] }),
    });
    await ui.init(true);
    closeVivifiedModals(document);

    // Opened by hand rather than through a failure: what is under test is the
    // order Escape walks the surfaces in, not what raises a notice.
    const notice = document.querySelector("#notice-modal");
    const underneath = document.querySelector("#channel-extra-modal");
    underneath.classList.remove("hidden");
    notice.classList.remove("hidden");

    document.dispatchEvent(keydownEvent("Escape"));
    assert.equal(notice.classList.contains("hidden"), true);
    assert.equal(underneath.classList.contains("hidden"), false, "Escape closes one surface");

    document.dispatchEvent(keydownEvent("Escape"));
    assert.equal(underneath.classList.contains("hidden"), true);
  } finally {
    restore();
  }
});

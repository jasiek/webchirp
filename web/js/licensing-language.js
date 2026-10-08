// Switch between the two complete static licensing views without changing the
// default native-language page that visitors and crawlers receive.
// The generated pages (scripts/build-licensing-pages.mjs) put these attributes
// on HTML elements only, so each match has dataset, hidden, lang and dir.
const buttons = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-licensing-language]"))];
const panels = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-licensing-panel]"))];

// Keep the visible panel, button state, document language, and title together.
function showLanguage(language) {
  const selected = panels.find((panel) => panel.dataset.licensingPanel === language);
  if (!selected) return;
  for (const panel of panels) panel.hidden = panel !== selected;
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.licensingLanguage === language));
  }
  document.documentElement.lang = selected.lang;
  document.documentElement.dir = selected.dir;
  document.title = selected.dataset.pageTitle;
}

for (const button of buttons) {
  button.addEventListener("click", () => showLanguage(button.dataset.licensingLanguage));
}

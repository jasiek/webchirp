// Switch between the two complete static licensing views without changing the
// default native-language page that visitors and crawlers receive.
// The generated pages (scripts/build-licensing-pages.ts) put these attributes
// on HTML elements only, so each match has dataset, hidden, lang and dir.
const buttons = [...document.querySelectorAll("[data-licensing-language]") as NodeListOf<HTMLElement>];
const panels = [...document.querySelectorAll("[data-licensing-panel]") as NodeListOf<HTMLElement>];

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
  // scripts/build-licensing-pages.ts gives every panel one; a panel without
  // it keeps the current title rather than retitling the tab "undefined".
  const title = selected.dataset.pageTitle;
  if (title) {
    document.title = title;
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => showLanguage(button.dataset.licensingLanguage));
}

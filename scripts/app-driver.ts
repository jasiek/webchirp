// Driving the running app the way a user does, shared by the two things that
// do it from outside the page: scripts/update-screenshots.ts (headless Chrome
// over the DevTools protocol) and the browser tests in tests/e2e (Playwright).
//
// The page-side steps below run inside the page, not in Node. Each is a
// self-contained function -- it reads nothing from this module's scope -- so
// either driver can hand it over as source: Playwright with
// page.evaluate(step, arg), the screenshot script with inPageCall(step, arg)
// and Runtime.evaluate. Keeping them here is what stops the two drivers from
// drifting into two ideas of what "the catalog has loaded" or "pick a radio"
// means.
import net from "node:net";
import type { AddressInfo } from "node:net";

// Resolves after ms milliseconds.
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A TCP port nothing is listening on right now, for a throwaway server.
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      // A TCP listener's address() is an AddressInfo; only pipes give a string.
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// A page-side step as a JavaScript expression that calls it with arg, for a
// driver that can only evaluate source text (the DevTools protocol's
// Runtime.evaluate).
export function inPageCall<A>(step: (arg: A) => unknown, arg?: A): string {
  return `(${step.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

// --- page-side steps ---------------------------------------------------------

// Whether the radio catalog has loaded and the search box is live: the point
// from which a user can pick a radio. The catalog is static JSON, so this
// comes well before the Python runtime, which boots on the first selection.
export function radioCatalogLoaded(): boolean {
  const searchEl = document.querySelector("#radio-search") as HTMLInputElement | null;
  const debugOutput = document.querySelector("#debug-output") as HTMLTextAreaElement | null;
  return Boolean(
    searchEl
    && !searchEl.disabled
    && /STATUS Loaded \d+ radio definitions/.test(debugOutput?.value || ""),
  );
}

// Picks a radio through the search box -- type the query, take the first
// suggestion with Enter -- and returns what the sidebar readout then names.
// Selecting is also what boots the Python runtime.
export function selectRadioThroughSearch(query: string): string {
  const searchEl = document.querySelector("#radio-search") as HTMLInputElement | null;
  if (!searchEl) {
    return "";
  }
  searchEl.value = query;
  searchEl.dispatchEvent(new Event("input", { bubbles: true }));
  searchEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return document.querySelector("#radio-selection-name")?.textContent || "";
}

// Whether the selected radio's own driver has answered: once the runtime has
// asked it about radio-wide settings, the Settings view's placeholder says
// what the driver needs (an image to read them from, or that it has none)
// instead of what it says before any radio is loaded.
export function selectedDriverAnswered(): boolean {
  const text = document.querySelector("#settings-empty")?.textContent || "";
  return /Download from radio or load a codeplug image|does not expose radio-wide settings/.test(text);
}

// Whether the service worker has cached a complete build, so the app can load
// without a network: web/js/offline.ts says so in Debug Output.
export function offlineBuildReady(): boolean {
  const debugText = (document.querySelector("#debug-output") as HTMLTextAreaElement | null)?.value || "";
  return /OFFLINE READY build [0-9a-f]{10}/.test(debugText);
}

// Opens the RSGB query, fills in a Maidenhead locator and submits the form, as
// a user would. Returns false when the controls are not there to drive.
export function submitRsgbQuery(locator: string): boolean {
  (document.querySelector("#channel-import-rsgb") as HTMLButtonElement | null)?.click();
  const locatorEl = document.querySelector("#repeater-query-field-position-locator") as HTMLInputElement | null;
  const form = document.querySelector("#repeater-query-form") as HTMLFormElement | null;
  if (!locatorEl || !form) {
    return false;
  }
  locatorEl.value = locator;
  locatorEl.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
  return true;
}

// Where an RSGB query submitted with submitRsgbQuery() has got to: done once
// the modal has closed on a result, with the grid's channel count, or the
// error line Debug Output shows when it failed.
export function rsgbQueryOutcome(): { done: boolean; count: number; failed: string } {
  const debugText = (document.querySelector("#debug-output") as HTMLTextAreaElement | null)?.value || "";
  const modalClosed = document.querySelector("#repeater-query-modal")?.classList.contains("hidden");
  // The grid's rows, which web/js/ui/state.ts exposes as currentRows for
  // reading from outside the modules (exposeCurrentRowsForDebugging).
  const rows = (globalThis as { currentRows?: unknown[] }).currentRows;
  if (modalClosed && /RSGB RESULTS /.test(debugText)) {
    return { done: true, count: rows?.length || 0, failed: "" };
  }
  return { done: false, count: 0, failed: debugText.match(/RSGB ETCC QUERY ERROR[^\n]*/)?.[0] || "" };
}

// Clicks the element selector names, as a tap on it would. Returns false when
// the page has no such element.
export function clickElement(selector: string): boolean {
  const element = document.querySelector(selector) as HTMLElement | null;
  element?.click();
  return Boolean(element);
}

// How many channels the grid holds, read from the rows web/js/ui/state.ts
// exposes as currentRows (exposeCurrentRowsForDebugging).
export function channelRowCount(): number {
  return (globalThis as { currentRows?: unknown[] }).currentRows?.length || 0;
}

// Picks a country in the open repeater query and types a place name, which
// starts the Place name field's lookup. Returns false until the form has
// built those fields: a directory's opens once its dictionary has loaded.
export function fillRepeaterQuery({ country, place }: { country: string; place: string }): boolean {
  const countryEl = document.querySelector("#repeater-query-field-country") as HTMLSelectElement | null;
  const placeEl = document.querySelector("#repeater-query-field-city") as HTMLInputElement | null;
  if (!countryEl || !placeEl) {
    return false;
  }
  countryEl.value = country;
  countryEl.dispatchEvent(new Event("change", { bubbles: true }));
  placeEl.focus();
  placeEl.value = place;
  placeEl.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

// Takes the Place name field's top suggestion with a tap, once the lookup has
// listed any. Returns false while the list is still closed.
export function pickFirstPlaceSuggestion(): boolean {
  const list = document.querySelector("#repeater-query-field-city-listbox") as HTMLElement | null;
  const option = list?.querySelector("[role=option]") as HTMLElement | null;
  if (!list || list.hidden || !option) {
    return false;
  }
  option.click();
  return true;
}

// The query modal's map preview caption once it has found repeaters, such as
// "12 in range, 3 just outside"; empty until then. A preview answered before
// the position settled can caption "0 in range" on its way there.
export function repeaterPreviewCount(): string {
  const text = document.querySelector(".modal-map-preview-count")?.textContent || "";
  return /\b[1-9]\d* in range/.test(text) ? text : "";
}

// Whether the Radio Settings view shows the radio's settings rather than its
// placeholder.
export function radioSettingsShown(): boolean {
  const content = document.querySelector("#settings-content") as HTMLElement | null;
  return Boolean(content && !content.hidden && content.childElementCount > 0);
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  UI_STUBBED_SELECTORS,
  createDeferred,
  flushMicrotasks,
  installFakeDom,
  keydownEvent,
  selectRadioBySearch,
  typeRadioSearch,
} from "../support/fake-dom.mjs";

// Installs the shared fake DOM and picks out the radio-search elements these
// tests read and drive.
function installUiDom() {
  const { document } = installFakeDom();
  return {
    document,
    radioSearchEl: document.querySelector("#radio-search"),
    radioSearchResultsEl: document.querySelector("#radio-search-results"),
    radioSelectionEl: document.querySelector("#radio-selection"),
    radioSelectionNameEl: document.querySelector("#radio-selection-name"),
  };
}

// Each suggestion renders as a name element plus, when the query hit an alias,
// a second line naming it. Read them apart rather than as one blob of text.
function suggestionLines(radioSearchResultsEl) {
  return radioSearchResultsEl.children.map((li) =>
    li.children.map((span) => span.textContent),
  );
}

test("the selected-radio readout shows Loading... while CHIRP drivers are loading", async () => {
  const { radioSelectionNameEl, radioSelectionEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const radioListDeferred = createDeferred();
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: () => radioListDeferred.promise,
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({
      headers: ["Location", "Name"],
      columns: {},
    }),
    getRadioSettings: async () => ({
      supported: false,
      available: false,
      requiresImage: false,
      message: "No settings",
      groups: [],
    }),
    parseCsv: async () => ({
      headers: ["Location", "Name"],
      rows: [],
      errors: [],
    }),
  });

  const initPromise = ui.init(true);

  assert.equal(radioSelectionNameEl.textContent, "Loading...");

  radioListDeferred.resolve({
    radios: [
      {
        vendor: "Acme",
        model: "Alpha",
        module: "alpha",
        className: "AlphaRadio",
        key: "alpha:AlphaRadio",
        isLiveRadio: false,
      },
      {
        vendor: "Acme",
        model: "Beta",
        module: "beta",
        className: "BetaRadio",
        key: "beta:BetaRadio",
        isLiveRadio: false,
      },
    ],
  });

  await initPromise;

  // A loaded catalog does not choose for the user: the readout asks for a
  // search instead of naming an arbitrary first-vendor radio.
  assert.equal(radioSelectionNameEl.textContent, "No radio model selected");
  assert.ok(radioSelectionEl.classList.contains("is-empty"));
});

test("search box shows narrowing make+model suggestions", async () => {
  const { document, radioSearchEl, radioSearchResultsEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "Alpha", module: "alpha", className: "AlphaRadio", key: "alpha:AlphaRadio", isLiveRadio: false },
        { vendor: "Acme", model: "Beta", module: "beta", className: "BetaRadio", key: "beta:BetaRadio", isLiveRadio: false },
        { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5R", key: "uv5r:BaofengUV5R", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // A vendor query lists all of that vendor's models as "<Make> <Model>".
  typeRadioSearch(document, "acme");
  assert.equal(radioSearchResultsEl.hidden, false);
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["Acme Alpha", "Acme Beta"],
  );

  // A model query narrows the list to the matching radio.
  typeRadioSearch(document, "uv-5r");
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["Baofeng UV-5R"],
  );

  // No matches shows an inert placeholder row.
  typeRadioSearch(document, "nonesuch");
  assert.deepEqual(radioSearchResultsEl.children.map((li) => li.textContent), ["No matching radios"]);
  assert.ok(radioSearchResultsEl.children[0].classList.contains("radio-search-empty"));

  // The combobox points a screen reader at the highlighted suggestion, since
  // there is no dropdown left to announce the selection instead.
  typeRadioSearch(document, "acme");
  assert.equal(radioSearchEl.getAttribute("aria-activedescendant"), "radio-search-option-0");
  assert.equal(radioSearchResultsEl.children[0].getAttribute("aria-selected"), "true");
  radioSearchEl.dispatchEvent(keydownEvent("ArrowDown"));
  assert.equal(radioSearchEl.getAttribute("aria-activedescendant"), "radio-search-option-1");
  assert.equal(radioSearchResultsEl.children[0].getAttribute("aria-selected"), "false");
  assert.equal(radioSearchResultsEl.children[1].getAttribute("aria-selected"), "true");

  // Clearing the box closes the suggestion list.
  typeRadioSearch(document, "");
  assert.equal(radioSearchResultsEl.hidden, true);
  assert.equal(radioSearchResultsEl.children.length, 0);
  assert.equal(radioSearchEl.getAttribute("aria-activedescendant"), null);
});

test("search suggestions disambiguate duplicates, cap results, and close on Escape", async () => {
  const { document, radioSearchEl, radioSearchResultsEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  // Two drivers sharing "Acme Twin" plus enough filler to exceed the 50-result cap.
  const radios = [
    { vendor: "Acme", model: "Twin", module: "twin_a", className: "TwinA", key: "twin_a:TwinA", isLiveRadio: false },
    { vendor: "Acme", model: "Twin", module: "twin_b", className: "TwinB", key: "twin_b:TwinB", isLiveRadio: false },
  ];
  for (let i = 0; i < 60; i += 1) {
    radios.push({
      vendor: "Bulk",
      model: `Filler${i}`,
      module: `filler${i}`,
      className: `Filler${i}Radio`,
      key: `filler${i}:Filler${i}Radio`,
      isLiveRadio: false,
    });
  }

  ui.setRuntimeApi({
    listRadios: async () => ({ radios }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // Duplicate "<Make> <Model>" labels are disambiguated by driver class.
  radioSearchEl.value = "twin";
  radioSearchEl.dispatchEvent({ type: "input" });
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["Acme Twin (TwinA)", "Acme Twin (TwinB)"],
  );

  // More than 50 matches: list is capped and a footer reports the overflow.
  radioSearchEl.value = "filler";
  radioSearchEl.dispatchEvent({ type: "input" });
  const optionItems = radioSearchResultsEl.querySelectorAll("li[role='option']");
  assert.equal(optionItems.length, 50);
  const footer = radioSearchResultsEl.children.at(-1);
  assert.ok(footer.classList.contains("radio-search-more"));
  assert.equal(footer.textContent, "10 more — keep typing to narrow down");

  // Escape closes the list without changing the input text.
  radioSearchEl.dispatchEvent(keydownEvent("Escape"));
  assert.equal(radioSearchResultsEl.hidden, true);
  assert.equal(radioSearchEl.value, "filler");
});

function tableHeaderTexts(document) {
  const headerRow = document.querySelector("#mem-table thead").children[0];
  return (headerRow?.children || []).map((th) => th.textContent);
}


const STALE_TEST_CATALOG = [
  { vendor: "Acme", model: "Alpha", module: "alpha", className: "AlphaRadio", key: "alpha:AlphaRadio", isLiveRadio: false },
  { vendor: "SlowCo", model: "Slow", module: "slow", className: "SlowRadio", key: "slow:SlowRadio", isLiveRadio: false },
  { vendor: "FastCo", model: "Fast", module: "fast", className: "FastRadio", key: "fast:FastRadio", isLiveRadio: false },
];

const EMPTY_SETTINGS = { supported: false, available: false, requiresImage: false, message: "", groups: [] };

test("stale metadata response does not overwrite a newer radio selection", async () => {
  const { document, radioSearchEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const slowMetadata = createDeferred();

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async ({ module }) => {
      if (module === "slow") {
        return slowMetadata.promise;
      }
      const header = module === "fast" ? "FastHeader" : "AlphaHeader";
      return { headers: ["Location", header], columns: {} };
    },
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // Select the slow radio; its metadata response stays in flight.
  selectRadioBySearch(document, "SlowCo Slow");

  // Move on to the fast radio, whose metadata resolves immediately.
  selectRadioBySearch(document, "FastCo Fast");
  await flushMicrotasks();
  assert.ok(tableHeaderTexts(globalThis.document).includes("FastHeader"));

  // The slow radio's response arrives last; it must be discarded.
  slowMetadata.resolve({ headers: ["Location", "SlowHeader"], columns: {} });
  await flushMicrotasks();

  const headers = tableHeaderTexts(globalThis.document);
  assert.ok(headers.includes("FastHeader"));
  assert.ok(!headers.includes("SlowHeader"));
});

test("reselecting the loaded radio rejects partial loads in either completion order", async () => {
  const { createUiController } = await import("../../web/js/ui.js");
  const settingsFor = (name) => ({
    supported: true,
    available: true,
    requiresImage: false,
    message: "",
    groups: [{ id: name, label: `${name} settings`, children: [] }],
  });

  for (const deferredPart of ["metadata", "settings"]) {
    const { document, radioSearchEl, radioSelectionNameEl } = installUiDom();
    const ui = createUiController();
    const pending = createDeferred();
    const metadataCalls = [];
    const settingsCalls = [];
    const metadataFor = (name) => ({
      headers: ["Location", `${name}Header`],
      columns: {},
    });

    ui.setRuntimeApi({
      listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
      getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
      getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
      getRadioMetadata: async ({ module }) => {
        metadataCalls.push(module);
        return module === "slow" && deferredPart === "metadata"
          ? pending.promise
          : metadataFor(module);
      },
      getRadioSettings: async ({ module }) => {
        settingsCalls.push(module);
        return module === "slow" && deferredPart === "settings"
          ? pending.promise
          : settingsFor(module);
      },
      parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
    });

    await ui.init(true);
    // Complete Fast -> Alpha first so the final return to Alpha below must
    // take reloadForSelectedRadio()'s no-new-request path from issue #111.
    selectRadioBySearch(document, "FastCo Fast");
    await flushMicrotasks();
    selectRadioBySearch(document, "Acme Alpha");
    await flushMicrotasks();

    assert.ok(tableHeaderTexts(globalThis.document).includes("alphaHeader"));
    assert.equal(globalThis.document.querySelector("#settings-tabs").textContent, "alpha settings");
    const alphaMetadataCalls = metadataCalls.filter((module) => module === "alpha").length;
    const alphaSettingsCalls = settingsCalls.filter((module) => module === "alpha").length;

    // One half of Slow's load resolves before the other. Returning to Alpha
    // must invalidate that work even though Alpha is already the last fully
    // loaded radio, regardless of which half arrived first.
    selectRadioBySearch(document, "SlowCo Slow");
    await flushMicrotasks();
    selectRadioBySearch(document, "Acme Alpha");
    await flushMicrotasks();

    pending.resolve(
      deferredPart === "metadata" ? metadataFor("slow") : settingsFor("slow"),
    );
    await flushMicrotasks();

    const headers = tableHeaderTexts(globalThis.document);
    assert.equal(radioSelectionNameEl.textContent, "Acme Alpha");
    assert.equal(metadataCalls.filter((module) => module === "alpha").length, alphaMetadataCalls);
    assert.equal(settingsCalls.filter((module) => module === "alpha").length, alphaSettingsCalls);
    assert.ok(headers.includes("alphaHeader"));
    assert.ok(!headers.includes("slowHeader"));
    assert.equal(globalThis.document.querySelector("#settings-tabs").textContent, "alpha settings");
  }
});

test("picking a search suggestion names the radio in the readout and loads it once", async () => {
  const { document, radioSearchEl, radioSearchResultsEl, radioSelectionNameEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const metadataCalls = [];

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async ({ module }) => {
      metadataCalls.push(module);
      return { headers: ["Location", "Name"], columns: {} };
    },
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);
  const callsAfterInit = metadataCalls.length;

  // Typing only opens suggestions; no radio load happens yet.
  typeRadioSearch(document, "slow");
  typeRadioSearch(document, "co");
  assert.equal(metadataCalls.length, callsAfterInit);
  assert.deepEqual(
    radioSearchResultsEl.children.map((li) => li.textContent),
    ["SlowCo Slow", "FastCo Fast"],
  );

  // Arrow down highlights the second suggestion; Enter selects it.
  radioSearchEl.dispatchEvent(keydownEvent("ArrowDown"));
  radioSearchEl.dispatchEvent(keydownEvent("Enter"));
  await flushMicrotasks();

  assert.equal(radioSelectionNameEl.textContent, "FastCo Fast");
  // The box is a way to change the selection, not a display of it: it empties
  // once the readout has the answer.
  assert.equal(radioSearchEl.value, "");
  assert.equal(radioSearchResultsEl.hidden, true);
  assert.equal(metadataCalls.length, callsAfterInit + 1);
  assert.equal(metadataCalls.at(-1), "fast");

  // Clicking a suggestion with the mouse selects it as well.
  typeRadioSearch(document, "slow");
  const slowItem = radioSearchResultsEl.children[0];
  radioSearchResultsEl.dispatchEvent({ type: "mousedown", target: slowItem, preventDefault() {} });
  await flushMicrotasks();

  assert.equal(radioSelectionNameEl.textContent, "SlowCo Slow");
  assert.equal(radioSearchEl.value, "");
  assert.equal(metadataCalls.at(-1), "slow");
});

// CHIRP drivers carry ALIASES: the other vendor/model badges the same radio
// ships under. With the make dropdown gone, searching those aliases is the only
// way an owner of a rebadged radio can find the driver at all, since the
// catalog lists the entry under its primary vendor only.
test("search finds radios by their alias identities and names the matching alias", async () => {
  const { document, radioSearchEl, radioSearchResultsEl, radioSelectionNameEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        {
          vendor: "Baofeng",
          model: "UV-5R",
          module: "uv5r",
          className: "BaofengUV5RGeneric",
          key: "uv5r:BaofengUV5RGeneric",
          isLiveRadio: false,
          aliases: [
            { vendor: "Retevis", model: "RT5R", variant: "" },
            { vendor: "Baofeng", model: "UV-5R", variant: "" },
          ],
        },
        {
          vendor: "Acme",
          model: "Alpha",
          module: "alpha",
          className: "AlphaRadio",
          key: "alpha:AlphaRadio",
          isLiveRadio: false,
        },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // The alias vendor matches, and the suggestion explains why a Baofeng came
  // back for a Retevis query.
  typeRadioSearch(document, "retevis");
  assert.deepEqual(suggestionLines(radioSearchResultsEl), [
    ["Baofeng UV-5R", "also sold as Retevis RT5R"],
  ]);

  // Tokens may straddle the primary identity and the alias.
  typeRadioSearch(document, "rt5r uv-5r");
  assert.deepEqual(suggestionLines(radioSearchResultsEl), [
    ["Baofeng UV-5R", "also sold as Retevis RT5R"],
  ]);

  // A query the radio's own vendor/model answers is not labelled with an alias.
  typeRadioSearch(document, "baofeng");
  assert.deepEqual(suggestionLines(radioSearchResultsEl), [["Baofeng UV-5R"]]);

  // Selecting through an alias still commits the driver's own identity.
  selectRadioBySearch(document, "retevis");
  await flushMicrotasks();
  assert.equal(radioSelectionNameEl.textContent, "Baofeng UV-5R");
});

// The live-mode marker trails the name in both places that show a radio, so the
// vendor stays first and the list still aligns down its left edge.
test("live-mode radios carry their marker after the name, in list and readout", async () => {
  const { document, radioSearchEl, radioSearchResultsEl, radioSelectionNameEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "Live", module: "live", className: "LiveRadio", key: "live:LiveRadio", isLiveRadio: true },
        { vendor: "Acme", model: "Clone", module: "clone", className: "CloneRadio", key: "clone:CloneRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  typeRadioSearch(document, "acme");
  assert.deepEqual(suggestionLines(radioSearchResultsEl), [
    ["Acme Live ⚡"],
    ["Acme Clone"],
  ]);

  selectRadioBySearch(document, "acme live");
  await flushMicrotasks();
  assert.equal(radioSelectionNameEl.textContent, "Acme Live ⚡");
});

// Several catalog entries can share one "<Make> <Model>" name, and the search
// box empties after a selection — so the readout is the only place left that
// can say which of them Connect / Load / Save will act on.
test("the readout names the driver only when two entries share a name", async () => {
  const { document, radioSearchEl, radioSelectionNameEl } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({
      radios: [
        { vendor: "Acme", model: "Twin", module: "twin_a", className: "TwinARadio", key: "twin_a:TwinARadio", isLiveRadio: false },
        { vendor: "Acme", model: "Twin", module: "twin_b", className: "TwinBRadio", key: "twin_b:TwinBRadio", isLiveRadio: false },
        { vendor: "Acme", model: "Only", module: "only", className: "OnlyRadio", key: "only:OnlyRadio", isLiveRadio: false },
      ],
    }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  // A shared name keeps the class that tells the two entries apart.
  selectRadioBySearch(document, "twin");
  await flushMicrotasks();
  assert.equal(radioSelectionNameEl.textContent, "Acme Twin (TwinARadio)");

  // A name only one entry wears does not need it.
  selectRadioBySearch(document, "only");
  await flushMicrotasks();
  assert.equal(radioSelectionNameEl.textContent, "Acme Only");
});

// Nothing is selected at startup now, so the serial path has to say "pick a
// radio" rather than offer buttons that would clone against no driver.
test("serial and clone actions stay disabled until a radio is selected", async () => {
  const { radioSearchEl, document } = installUiDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();

  ui.setRuntimeApi({
    listRadios: async () => ({ radios: STALE_TEST_CATALOG }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name"], columns: {} }),
    getRadioSettings: async () => EMPTY_SETTINGS,
    parseCsv: async () => ({ headers: ["Location", "Name"], rows: [], errors: [] }),
  });

  await ui.init(true);

  const connectEl = document.querySelector("#serial-connect-toggle");
  const downloadEl = document.querySelector("#radio-download");
  assert.equal(connectEl.disabled, true);
  assert.equal(connectEl.title, "Search for and select a radio first");
  assert.equal(downloadEl.disabled, true);
  assert.equal(downloadEl.title, "Search for and select a radio first");

  selectRadioBySearch(document, "Acme Alpha");
  await flushMicrotasks();

  assert.equal(connectEl.disabled, false);
  // Clone still waits on an open port, but the radio is no longer the blocker.
  assert.equal(downloadEl.title, "Connect to a serial port first");
});

// The shared fake DOM (tests/support/fake-dom.mjs) stubs a page for the
// UI to run against, so it can drift from the real page in a way index.html
// cannot: a stub for a deleted element keeps every UI test green while
// production has nothing there. It happened — the four #serial-transaction /
// #tx-hex / #rx-bytes / #rx-timeout stubs outlived the debug panel ff5607a
// removed, and nothing noticed. Pin the stub list to the element contract
// instead, so a removed id fails here as well as in test-dom-selectors.mjs.
test("every stubbed element is one dom.js actually declares", async () => {
  const { REQUIRED_ELEMENTS, ELEMENT_COLLECTIONS } = await import("../../web/js/ui/dom.js");
  const declared = new Set([
    ...Object.values(REQUIRED_ELEMENTS),
    ...Object.values(ELEMENT_COLLECTIONS),
  ]);

  const orphaned = [...UI_STUBBED_SELECTORS.keys()].filter((selector) => !declared.has(selector));
  assert.deepEqual(
    orphaned,
    [],
    "these selectors are stubbed but no longer required by the UI; the test is "
      + "asserting against a page shape production cannot have",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";
import { withRadioSessions } from "../support/fake-runtime-api.mjs";
import { dispatch, keydownEvent, tableNames } from "../support/ui-interactions.mjs";

// A ?csv_url= link boots the app with a channel list downloaded from another
// site. The list can come from anyone, so nothing reaches the grid until the
// user has seen where it is from and accepted it.
const CATALOG = {
  radios: [
    { vendor: "Baofeng", model: "UV-5R", module: "uv5r", className: "BaofengUV5RGeneric", key: "uv5r:BaofengUV5RGeneric", isLiveRadio: false },
  ],
};
const LIST_URL = "https://gist.githubusercontent.com/someone/abc/raw/def/club.csv";
const CSV = "Location,Name,Frequency\n0,CLUB,145.500000\n1,RPT,145.600000\n";

function linkSearch(url = LIST_URL) {
  return `?radio=uv5r%3ABaofengUV5RGeneric&csv_url=${encodeURIComponent(url)}`;
}

// Boot the real page with a link, a stubbed runtime and a recording fetch.
// init() does not wait for the link's list, so the test waits for what the
// user would see instead.
async function bootWithLink(search, { onLine = true, body = CSV } = {}) {
  const fetches = [];
  const parsed = [];
  const fakeFetch = async (url, init) => {
    fetches.push({ url, init });
    return new Response(body, { status: 200 });
  };
  const page = installIndexPage({ url: search, globals: { fetch: fakeFetch }, navigator: { onLine } });
  const { createUiController } = await import("../../web/js/ui.ts");
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => CATALOG,
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: ["Location", "Name", "Frequency"] }),
    getRadioMetadata: async () => ({ headers: ["Location", "Name", "Frequency"], columns: {} }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async ({ csvText }) => {
      parsed.push(csvText);
      return {
        headers: ["Location", "Name", "Frequency"],
        rows: [
          { Location: "0", Name: "CLUB", Frequency: "145.500000" },
          { Location: "1", Name: "RPT", Frequency: "145.600000" },
        ],
        errors: [],
      };
    },
  }));
  await ui.init(true);
  const { document } = page;
  return {
    ...page,
    fetches,
    parsed,
    modal: document.querySelector("#csv-link-modal"),
    notice: document.querySelector("#notice-modal"),
    debug: document.querySelector("#debug-output"),
  };
}

// Let the link's download and parse settle: a few turns of the event loop.
async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a linked list is shown for confirmation and loaded once accepted", async () => {
  const page = await bootWithLink(linkSearch());
  try {
    await settle();
    assert.equal(page.fetches.length, 1);
    assert.equal(page.fetches[0].url, LIST_URL);
    assert.deepEqual(page.parsed, [CSV]);
    // Downloaded and parsed, but not applied: the grid waits for the user.
    assert.ok(!page.modal.classList.contains("hidden"), "the confirmation is open");
    assert.deepEqual(tableNames(page.document), []);
    const message = page.document.querySelector("#csv-link-message").textContent;
    assert.match(message, /2 channel\(s\)/);
    assert.match(message, /gist\.githubusercontent\.com/);

    await dispatch(page.document.querySelector("#csv-link-accept"), "click");
    await settle();
    assert.ok(page.modal.classList.contains("hidden"));
    assert.deepEqual(tableNames(page.document), ["CLUB", "RPT"]);
    // Into the radio the same link selected.
    assert.match(page.document.querySelector("#radio-selection-name").textContent, /UV-5R/);
  } finally {
    page.restore();
  }
});

test("cancelling the confirmation leaves the editor empty", async () => {
  const page = await bootWithLink(linkSearch());
  try {
    await settle();
    await dispatch(page.document.querySelector("#csv-link-cancel"), "click");
    await settle();
    assert.ok(page.modal.classList.contains("hidden"));
    assert.deepEqual(tableNames(page.document), []);
  } finally {
    page.restore();
  }
});

test("Escape cancels the confirmation", async () => {
  const page = await bootWithLink(linkSearch());
  try {
    await settle();
    page.document.dispatchEvent(keydownEvent("Escape"));
    await settle();
    assert.ok(page.modal.classList.contains("hidden"));
    assert.deepEqual(tableNames(page.document), []);
  } finally {
    page.restore();
  }
});

test("a non-https link is refused with a notice and never fetched", async () => {
  const page = await bootWithLink(linkSearch("http://example.com/club.csv"));
  try {
    await settle();
    assert.equal(page.fetches.length, 0);
    assert.ok(page.modal.classList.contains("hidden"));
    assert.ok(!page.notice.classList.contains("hidden"), "the refusal is shown");
    assert.match(page.document.querySelector("#notice-message").textContent, /https/);
  } finally {
    page.restore();
  }
});

test("offline, the list is not requested and the user is told why", async () => {
  const page = await bootWithLink(linkSearch(), { onLine: false });
  try {
    await settle();
    assert.equal(page.fetches.length, 0);
    assert.match(page.document.querySelector("#notice-message").textContent, /offline/);
  } finally {
    page.restore();
  }
});

test("a page without csv_url fetches nothing", async () => {
  const page = await bootWithLink("?radio=uv5r%3ABaofengUV5RGeneric");
  try {
    await settle();
    assert.equal(page.fetches.length, 0);
    assert.ok(page.modal.classList.contains("hidden"));
    assert.ok(page.notice.classList.contains("hidden"));
  } finally {
    page.restore();
  }
});

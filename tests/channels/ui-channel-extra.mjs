import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../support/repo-paths.mjs";
import {
  channelRows,
  flushMicrotasks,
  installFakeDom,
  keydownEvent,
} from "../support/fake-dom.mjs";

// The grid's Extra column and the modal behind it (web/js/ui/channel-extra.js).
// Driven through createUiController rather than the module alone, because the
// column only exists when the loaded rows carry driver extras, and that is the
// grid's decision, not the modal's.
//
// The rows arrive through the binary import path on purpose: extras come off a
// radio or an image, never out of a CSV, so that is the only load that produces
// the state this feature applies to.
const HEADERS = ["Location", "Name", "Frequency", "Comment"];

const RADIO = {
  vendor: "Baofeng",
  model: "BF-888",
  module: "h777",
  className: "H777Radio",
  key: "h777:H777Radio",
  isLiveRadio: false,
};

// One field of each shape the modal has to render, including an immutable one:
// CHIRP reports those for values a driver will not let anyone write.
const EXTRA_FIELDS = [
  {
    name: "bcl",
    label: "Busy Channel Lockout",
    doc: "Prevents transmitting on a channel that is already in use",
    type: "boolean",
    mutable: true,
    current: true,
  },
  {
    name: "scode",
    label: "S-CODE",
    type: "enum",
    options: ["1", "2", "3"],
    mutable: true,
    current: "1",
  },
  {
    name: "voxlevel",
    label: "VOX level",
    type: "integer",
    min: 0,
    max: 5,
    mutable: false,
    current: 3,
  },
];

const IMAGE_ROWS = [
  {
    Location: "1",
    Name: "Alpha",
    Frequency: "446.006250",
    Comment: "",
    // The channel's own values, which differ from what the driver reports for
    // the slot: the modal has to open on these.
    __extra: { bcl: false, scode: "3" },
  },
  { Location: "2", Name: "Bravo", Frequency: "446.093750", Comment: "" },
];

async function boot({ rows = IMAGE_ROWS, getChannelExtra } = {}) {
  const { document } = installFakeDom();
  const { createUiController } = await import("../../web/js/ui.js");
  const ui = createUiController();
  const calls = [];
  ui.setRuntimeApi({
    listRadios: async () => ({ radios: [RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: {} }),
    getRadioSettings: async () => ({
      supported: false, available: false, requiresImage: false, message: "", groups: [],
    }),
    loadImage: async () => ({
      module: RADIO.module,
      className: RADIO.className,
      vendor: RADIO.vendor,
      model: RADIO.model,
      headers: HEADERS,
      rows: rows.map((row) => ({ ...row })),
      settings: [],
    }),
    getChannelExtra: async (payload) => {
      calls.push(payload);
      return getChannelExtra
        ? getChannelExtra(payload)
        : { available: true, message: "", fields: EXTRA_FIELDS };
    },
  });
  await ui.init(true);
  // index.html ships every modal with the hidden class; the DOM stub vivifies
  // elements with no classes at all, so without this the Escape handler finds
  // the import prompt "open" and never reaches the extras editor.
  for (const selector of ["#channel-extra-modal", "#import-choice-modal"]) {
    document.querySelector(selector).classList.add("hidden");
  }

  const imgInput = document.querySelector("#img-file");
  imgInput.files = [{
    name: "codeplug.img",
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  }];
  imgInput.dispatchEvent({ type: "change" });
  await flushMicrotasks();
  // The grid's rows, read back through the controller: globalThis.currentRows
  // is bound to whichever controller was built first in this process.
  return { document, calls, rows: () => ui.selectedRowsForOperations() };
}

function headerLabels(document) {
  return document.querySelector("#mem-table thead").children[0].children.map((th) => th.textContent);
}

// Clicks a row's Extra button. Cell events are delegated to the tbody, so
// dispatch there with the button as the target, as bubbling would.
async function openExtraModal(document, rowIdx) {
  const tbody = document.querySelector("#mem-table tbody");
  const row = channelRows(document)[rowIdx];
  const button = row.querySelector(".channel-extra-button");
  assert.ok(button, `row ${rowIdx} has no Extra button`);
  tbody.dispatchEvent({
    type: "click",
    target: button,
    preventDefault() {},
    stopPropagation() {},
  });
  await flushMicrotasks();
  return button;
}

function modalIsOpen(document) {
  return !document.querySelector("#channel-extra-modal").classList.contains("hidden");
}

function controlFor(document, name) {
  return document.querySelector("#channel-extra-grid").querySelector(`[name="${name}"]`);
}

async function submitModal(document) {
  await document.querySelector("#channel-extra-form").dispatch("submit");
  await flushMicrotasks();
}

test("the Extra column appears once loaded channels carry driver extras", async () => {
  const { document } = await boot();
  assert.deepEqual(
    headerLabels(document),
    ["#", "Name", "Frequency", "Comment", "Extra"],
    "Extra is appended after Comment, and only there",
  );
  // Every row gets the button, including the one with no extras of its own:
  // the driver still has settings for that channel, they are just at defaults.
  for (const row of channelRows(document)) {
    assert.ok(row.querySelector(".channel-extra-button"), "a row is missing its Extra button");
  }
  // Both halves of the column are addressed by data-column, which is what the
  // stylesheet pins them to the right edge with (see the last test here).
  const headerCells = document.querySelector("#mem-table thead").children[0].children;
  assert.equal(headerCells[headerCells.length - 1].dataset.column, "Extra");
  assert.equal(
    channelRows(document)[0].children[headerCells.length - 1].dataset.column,
    "Extra",
  );
});

test("a codeplug without driver extras has no Extra column", async () => {
  const { document } = await boot({
    rows: IMAGE_ROWS.map(({ __extra, ...columns }) => columns),
  });
  assert.deepEqual(headerLabels(document), ["#", "Name", "Frequency", "Comment"]);
  assert.equal(
    channelRows(document)[0].querySelector(".channel-extra-button"),
    null,
    "the column should not exist when nothing carries extras",
  );
});

test("the modal opens on the channel's own values, not the slot's", async () => {
  const { document, calls } = await boot();
  await openExtraModal(document, 0);

  assert.ok(modalIsOpen(document));
  assert.deepEqual(calls, [{ module: "h777", className: "H777Radio", location: "1" }]);
  assert.match(
    document.querySelector("#channel-extra-title").textContent,
    /channel 1/,
    "the title should name the channel being edited",
  );
  // The row says bcl is off and scode is 3; the driver reported on and 1.
  assert.equal(controlFor(document, "bcl").checked, false);
  assert.equal(controlFor(document, "scode").value, "3");
  // A field the row has never carried opens on what the driver reported.
  assert.equal(controlFor(document, "voxlevel").value, "3");
  assert.equal(
    controlFor(document, "voxlevel").disabled,
    true,
    "an immutable extra must not be editable",
  );
});

test("saving writes the edited values onto the row", async () => {
  const { document, rows } = await boot();
  await openExtraModal(document, 0);

  controlFor(document, "bcl").checked = true;
  controlFor(document, "scode").value = "2";
  await submitModal(document);

  assert.equal(modalIsOpen(document), false, "a successful save closes the modal");
  assert.deepEqual(
    rows()[0].__extra,
    { bcl: true, scode: "2" },
    "the sidecar should hold the edited values, and not the immutable field",
  );
});

test("a channel with no extras of its own takes them on when saved", async () => {
  const { document, rows } = await boot();
  await openExtraModal(document, 1);
  controlFor(document, "scode").value = "2";
  await submitModal(document);

  assert.deepEqual(rows()[1].__extra, { bcl: true, scode: "2" });
});

test("an out-of-range value is reported and blocks the save", async () => {
  const { document, rows } = await boot({
    getChannelExtra: async () => ({
      available: true,
      message: "",
      fields: [{ name: "voxlevel", label: "VOX level", type: "integer", min: 0, max: 5, mutable: true, current: 3 }],
    }),
  });
  await openExtraModal(document, 0);
  controlFor(document, "voxlevel").value = "9";
  await submitModal(document);

  assert.equal(modalIsOpen(document), true, "an invalid value must keep the modal open");
  assert.match(
    document.querySelector("#channel-extra-grid").textContent,
    /at most 5/,
    "the offending field should say what is wrong with it",
  );
  assert.equal(
    rows()[0].__extra.voxlevel,
    undefined,
    "nothing should have been written",
  );
});

test("a driver with nothing to offer says so instead of showing an empty form", async () => {
  const { document } = await boot({
    getChannelExtra: async () => ({
      available: false,
      message: "This radio has no extra settings for its channels.",
      fields: [],
    }),
  });
  await openExtraModal(document, 0);

  assert.equal(modalIsOpen(document), true);
  assert.equal(document.querySelector("#channel-extra-message").hidden, false);
  assert.match(
    document.querySelector("#channel-extra-message").textContent,
    /no extra settings/,
  );
  assert.equal(
    document.querySelector("#channel-extra-save").disabled,
    true,
    "there is nothing to save",
  );
});

test("Escape closes the editor without touching the row", async () => {
  const { document, rows } = await boot();
  await openExtraModal(document, 0);
  controlFor(document, "scode").value = "2";

  document.dispatchEvent(keydownEvent("Escape"));
  assert.equal(modalIsOpen(document), false);
  assert.deepEqual(rows()[0].__extra, { bcl: false, scode: "3" });
});

test("a response for a channel the user has left behind is discarded", async () => {
  let release = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let firstCall = true;
  const { document } = await boot({
    getChannelExtra: async ({ location }) => {
      if (firstCall) {
        firstCall = false;
        await pending;
        return { available: true, message: "", fields: [{ ...EXTRA_FIELDS[1], current: "1" }] };
      }
      return { available: true, message: "", fields: [{ ...EXTRA_FIELDS[1], current: location }] };
    },
  });

  await openExtraModal(document, 0);
  // The first read is still in flight; the user opens another channel.
  await openExtraModal(document, 1);
  release();
  await flushMicrotasks();

  assert.match(
    document.querySelector("#channel-extra-title").textContent,
    /channel 2/,
    "the modal should still be showing the second channel",
  );
  assert.equal(
    controlFor(document, "scode").value,
    "2",
    "the superseded response rendered over the current one",
  );
});

// Layout is the browser's own and cannot be checked headlessly -- the fake DOM
// has no layout at all -- so what is asserted here is the stylesheet rule that
// produces it, in the same spirit as the sticky-header test in
// tests/channels/ui-column-widths.mjs. This one earns its keep: Extra is the
// eighteenth of eighteen columns, so without the pin it sits past the right
// edge at any ordinary window width and the whole feature is invisible until
// someone thinks to scroll for it, which is exactly how it was first reported.
test("the Extra column stays pinned to the right edge of the grid", () => {
  const styles = fs.readFileSync(path.join(repoRoot, "web", "styles.css"), "utf8");
  const cells = styles.match(/#mem-table td\[data-column="Extra"\] \{([^}]*)\}/);
  assert.ok(cells, "the Extra column's cells must carry their own rule");
  assert.match(cells[1], /position:\s*sticky/);
  assert.match(cells[1], /right:\s*0/);
  // Opaque, or the cells it travels over show through it; above them in the
  // stacking order, or it travels under them instead.
  assert.match(cells[1], /background:/);
  assert.match(cells[1], /z-index:/);
  // border-collapse gives the borders to the table, so a sticky cell's left
  // edge scrolls away with it and the shadow is what stands in.
  assert.match(cells[1], /box-shadow:[^;]*inset 1px 0/);

  const header = styles.match(/#mem-table th\[data-column="Extra"\] \{([^}]*)\}/);
  assert.ok(header, "the Extra header must be pinned on both axes");
  // position and top come from the shared #mem-table th rule; right is what
  // makes this one sticky horizontally as well.
  assert.match(header[1], /right:\s*0/);
  assert.match(header[1], /z-index:/);
});

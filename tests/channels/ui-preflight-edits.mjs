import assert from "node:assert/strict";
import test from "node:test";

// Upload and binary export both run the upload preflight
// (runUploadPreflight, web/js/ui/serial-actions.ts) and then write the grid.
// Issue #321: the write read the grid again after the preflight answered, so
// a cell committed while the preflight was in flight reached the write
// unchecked -- a frequency the driver refuses failed at the write stage
// instead of being highlighted. The write now carries exactly the rows the
// preflight checked, and an edit made while it ran has it run again.
import { installIndexPage, pageElement } from "../support/index-page.mjs";
import {
  channelRows,
  createDeferred,
  dispatch,
  flushMicrotasks,
  importSampleCsv,
  selectRadioBySearch,
} from "../support/ui-interactions.mjs";
import { fakeRowCheck, withRadioSessions } from "../support/fake-runtime-api.mjs";

const HEADERS = ["Location", "Name", "Frequency"];
const ROWS = [
  { Location: "0", Name: "ALPHA", Frequency: "146.520000" },
  { Location: "1", Name: "BRAVO", Frequency: "146.940000" },
];
const COLUMNS = {
  Location: { kind: "int", editable: false, min: 0, max: 127 },
  Name: { kind: "text", editable: true, maxLength: 7 },
  Frequency: { kind: "freq", editable: true },
};
const RADIO = { vendor: "Acme", model: "One", module: "one", className: "OneRadio", key: "one:OneRadio", isLiveRadio: false };
// The value the stand-in driver refuses, as the UV-5R's refuses 220 MHz
// (tests/channels/row-edit-check.mjs).
const REFUSED = "220.000000";

// What the stand-in driver says about a set of rows: every refused frequency
// is an issue on its cell.
function findingsFor(rows) {
  const issues = rows
    .map((row, rowIndex) => (row.Frequency === REFUSED
      ? { rowIndex, column: "Frequency", message: `Frequency ${REFUSED} is out of supported range` }
      : null))
    .filter(Boolean);
  return { valid: issues.length === 0, issues, warnings: [] };
}

// The two ways to start a write, each with the button a user presses and the
// runtime call that does the write.
const WRITES = [
  { name: "binary export", button: () => pageElement("exportBinaryEl"), blocked: /STATUS Export blocked: 1 invalid value\(s\) highlighted in red in channels\./ },
  { name: "upload", button: () => pageElement("radioUploadEl"), blocked: /STATUS Upload blocked: 1 invalid value\(s\) highlighted in red in channels\./ },
];

// Boots the page with two channels loaded and a port connected. Every
// preflight row check is held until the test releases it; rowCheck is the
// grid's per-edit check.
async function bootUi(t, rowCheckOptions = {}) {
  const { window } = installIndexPage();
  const { createUiController } = await import("../../web/js/ui.ts");
  const preflights = [];
  const writes = [];
  const rowCheck = fakeRowCheck({
    findings: (row) => findingsFor([row]),
    ...rowCheckOptions,
  });
  const ui = createUiController();
  ui.setRuntimeApi(withRadioSessions({
    listRadios: async () => ({ radios: [RADIO] }),
    getRuntimeInfo: async () => ({ chirpRevision: "test-revision" }),
    getDefaultSchema: async () => ({ headers: HEADERS }),
    getRadioMetadata: async () => ({ headers: HEADERS, columns: COLUMNS }),
    getRadioSettings: async () => ({ supported: false, available: false, requiresImage: false, message: "", groups: [] }),
    parseCsv: async () => ({ headers: HEADERS, rows: ROWS.map((row) => ({ ...row })), errors: [] }),
    normalizeAndValidateRows: rowCheck.normalizeAndValidateRows,
    validateRowsForUpload: (payload) => {
      const answer = createDeferred();
      preflights.push({ rows: payload.rows, release: () => answer.resolve(findingsFor(payload.rows)) });
      return answer.promise;
    },
    validateRadioSettings: async () => ({ valid: true, issues: [], settings: [], available: true }),
    exportImage: async (payload) => {
      writes.push(payload);
      return { imageBase64: "AQID", settings: [], vendor: RADIO.vendor, model: RADIO.model };
    },
    uploadSelectedRadio: async (payload) => {
      writes.push(payload);
      return { settings: [] };
    },
    serialConnect: async () => ({ connected: true, transport: "webserial", message: "ok" }),
    serialDisconnect: async () => ({ connected: false, message: "bye" }),
  }));
  ui.setSerialController({ capability: { supported: true, native: true }, async choosePort() {} });
  await ui.init(true);
  // A successful export saves through an object URL and revokes it a minute
  // later; neither exists in jsdom, and the timer would hold the process open.
  const { createObjectURL, revokeObjectURL } = URL;
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:test/0";
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  t.after(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    window.HTMLAnchorElement.prototype.click = anchorClick;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = window.document;
  selectRadioBySearch(document, "Acme One");
  await flushMicrotasks();
  await importSampleCsv(document);
  await dispatch(pageElement("serialConnectToggleEl"), "click");
  return { document, preflights, writes, rowCheck };
}

function cell(document, rowIdx, column) {
  return channelRows(document)[rowIdx].children[HEADERS.indexOf(column)];
}

// Type into a cell and leave it, as a user does.
function commit(document, rowIdx, column, text) {
  const editor = cell(document, rowIdx, column).children[0];
  editor.value = text;
  editor.focus();
  editor.blur();
}

const frequencies = (rows) => rows.map((row) => row.Frequency);

for (const write of WRITES) {
  test(`a refused value committed while the ${write.name}'s preflight runs blocks it as a highlighted cell`, async (t) => {
    const { document, preflights, writes } = await bootUi(t);

    const click = dispatch(write.button(), "click");
    await flushMicrotasks();
    assert.equal(preflights.length, 1);
    assert.deepEqual(frequencies(preflights[0].rows), ["146.520000", "146.940000"]);

    commit(document, 0, "Frequency", REFUSED);
    await flushMicrotasks();
    preflights[0].release();
    await flushMicrotasks();

    // The answer was about rows the grid no longer holds: the preflight runs
    // again, on the rows as they now stand.
    assert.equal(preflights.length, 2, "the edit has the preflight run again");
    assert.deepEqual(frequencies(preflights[1].rows), [REFUSED, "146.940000"]);
    preflights[1].release();
    await click;
    // Upload's click listener does not await the transfer it starts.
    await flushMicrotasks();

    assert.equal(writes.length, 0, "a value the driver refuses is never written");
    assert.equal(cell(document, 0, "Frequency").classList.contains("is-invalid"), true);
    const debug = document.querySelector("#debug-output").value;
    assert.match(debug, write.blocked);
    assert.match(debug, /PREFLIGHT repeated: the channels or settings changed while it ran\./);
  });

  test(`the ${write.name} writes exactly the rows its preflight checked`, async (t) => {
    const { document, preflights, writes } = await bootUi(t);

    const click = dispatch(write.button(), "click");
    await flushMicrotasks();
    commit(document, 1, "Name", "CHARLIE");
    await flushMicrotasks();
    preflights[0].release();
    await flushMicrotasks();
    assert.equal(preflights.length, 2);
    preflights[1].release();
    await click;
    // Upload's click listener does not await the transfer it starts.
    await flushMicrotasks();

    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].rows, preflights[1].rows);
    assert.equal(writes[0].rows[1].Name, "CHARLIE");
  });

  test(`a cell still pending when the ${write.name} starts is checked as the runtime stored it`, async (t) => {
    // The grid's check stores "146.55" as "146.550000"; until it answers, the
    // grid holds the typed text, which is not what the radio would be given.
    const { document, preflights, writes, rowCheck } = await bootUi(t, {
      held: true,
      verdict: (column, value) => (column === "Frequency" && value === "146.55"
        ? { value: "146.550000", accepted: true }
        : { value, accepted: true }),
    });
    commit(document, 0, "Frequency", "146.55");
    await flushMicrotasks();
    assert.equal(cell(document, 0, "Frequency").classList.contains("is-pending"), true);

    const click = dispatch(write.button(), "click");
    await flushMicrotasks();
    assert.equal(preflights.length, 0, "the preflight waits for the pending cell's answer");

    rowCheck.release();
    await flushMicrotasks();
    assert.equal(preflights.length, 1);
    assert.deepEqual(frequencies(preflights[0].rows), ["146.550000", "146.940000"]);
    preflights[0].release();
    await click;
    // Upload's click listener does not await the transfer it starts.
    await flushMicrotasks();

    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].rows, preflights[0].rows);
  });
}

test("a grid that keeps changing under every preflight cancels the write", async (t) => {
  const { document, preflights, writes } = await bootUi(t);

  const click = dispatch(pageElement("exportBinaryEl"), "click");
  for (const name of ["ONE", "TWO", "THREE"]) {
    await flushMicrotasks();
    commit(document, 1, "Name", name);
    await flushMicrotasks();
    preflights.at(-1).release();
  }
  await click;

  assert.equal(preflights.length, 3, "the check is not repeated without end");
  assert.equal(writes.length, 0);
  assert.match(
    document.querySelector("#debug-output").value,
    /STATUS Export cancelled: the channels kept changing while they were checked\./,
  );
});

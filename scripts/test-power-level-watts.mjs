import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function powerColumnFor(harness, module, className) {
  await harness.runPythonJson("ensure_radio_module(_m) or json.dumps({})", { _m: module });
  const metadata = await harness.runPythonJson(
    "json.dumps(get_radio_column_metadata(_m, _c))",
    { _m: module, _c: className },
  );
  return metadata.columns.Power;
}

test("power labels are published with the wattage CHIRP would export", async () => {
  const harness = await createTestRadioHarness({ repoRoot });

  // A 50W level is 46.99 dBm. int() truncates it to 46, which converts back to
  // 39.8W and renders "39W"; the labels have to come out of float().
  const anytone = await powerColumnFor(harness, "anytone", "AnyTone5888UVRadio");
  assert.deepEqual(anytone.options, ["High", "Mid1", "Mid2", "Low"]);
  assert.deepEqual(anytone.optionWatts, {
    High: "50W",
    Mid1: "25W",
    Mid2: "10W",
    Low: "5.0W",
  });

  // Opaque labels are the ones this exists for.
  const vx6 = await powerColumnFor(harness, "vx6", "VX6Radio");
  assert.deepEqual(vx6.optionWatts, {
    Hi: "5.0W",
    L3: "2.5W",
    L2: "1.0W",
    L1: "0.3W",
  });
});

test("a driver whose labels are already wattages publishes no duplicates", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const result = await harness.runPythonJson(
    `json.dumps({
         "numeric": _power_level_watts([chirp_common.AutoNamedPowerLevel(5),
                                        chirp_common.AutoNamedPowerLevel(50)]),
         "none": _power_level_watts(None),
         "empty": _power_level_watts([]),
     })`,
  );
  // "5.0W = 5.0W" would be noise, so labels that already state their wattage
  // are left out and the UI shows no legend at all.
  assert.deepEqual(result.numeric, {});
  assert.deepEqual(result.none, {});
  assert.deepEqual(result.empty, {});
});

// Minimal element stub: enough for renderHeader() and one row of cell editors.
// The grid renders every row when clientHeight is not a number, which is the
// path headless callers take.
class StubElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.title = "";
    this.textContent = "";
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.readOnly = false;
    this.hidden = false;
  }

  set innerHTML(_value) {
    this.children = [];
  }

  get innerHTML() {
    return "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((each) => each !== child);
    return child;
  }

  insertBefore(child) {
    return this.appendChild(child);
  }

  remove() {}

  setAttribute(name, value) {
    this[name] = value;
  }

  addEventListener() {}

  getBoundingClientRect() {
    return { height: 0 };
  }
}

// Spacer rows stand in for the channels outside the window, so a rendered row is
// found by data-row-idx rather than by position in the tbody.
function renderedRows(dom) {
  return dom.tableBody.children.filter((tr) => tr.dataset.rowIdx !== undefined);
}

function renderGridWithPowerColumn(columns) {
  globalThis.document = { createElement: (tag) => new StubElement(tag) };
  const dom = {
    tableHead: new StubElement("thead"),
    tableBody: new StubElement("tbody"),
    tableScrollEl: new StubElement("div"),
  };
  const state = {
    currentHeaders: ["Location", "Power"],
    currentRows: [{ Location: "1", Power: "L3" }],
    radioMetadata: { headers: ["Location", "Power"], columns },
  };
  return { dom, state };
}

test("the grid spells out the driver's power table on hover", async () => {
  const { createChannelTable } = await import("../web/js/ui/channel-table.js");
  const { dom, state } = renderGridWithPowerColumn({
    Power: {
      kind: "enum",
      editable: true,
      options: ["Hi", "L3", "L2", "L1"],
      optionWatts: { Hi: "5.0W", L3: "2.5W", L2: "1.0W", L1: "0.3W" },
    },
  });
  const table = createChannelTable({
    dom,
    state,
    log: { setStatus() {}, logDebug() {} },
    actions: {},
  });
  table.render();

  const legend = "Driver power levels: Hi = 5.0W, L3 = 2.5W, L2 = 1.0W, L1 = 0.3W";
  const headerCells = dom.tableHead.children[0].children;
  assert.equal(headerCells[1].title, legend, "Power header should carry the legend");
  assert.equal(headerCells[0].title, "", "other headers should be untouched");

  const powerCell = renderedRows(dom)[0].children[1];
  assert.equal(powerCell.children[0].title, legend, "Power cell should carry the legend");
});

test("no legend without wattages to show", async () => {
  const { createChannelTable } = await import("../web/js/ui/channel-table.js");
  // 99 driver classes advertise no power levels at all; several more label them
  // in watts already, and _power_level_watts() omits those.
  const { dom, state } = renderGridWithPowerColumn({
    Power: { kind: "enum", editable: true, options: ["Hi", "Low"], optionWatts: {} },
  });
  const table = createChannelTable({
    dom,
    state,
    log: { setStatus() {}, logDebug() {} },
    actions: {},
  });
  table.render();

  assert.equal(dom.tableHead.children[0].children[1].title, "");
  assert.equal(renderedRows(dom)[0].children[1].children[0].title, "");
});

test("two levels with the same wattage are both reported", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  // radtel_t18.RB619Radio advertises High and Low, and dBm_to_watts() rounds
  // both to 0.5W. The legend says so rather than hiding one of them.
  const rb619 = await powerColumnFor(harness, "radtel_t18", "RB619Radio");
  assert.deepEqual(rb619.optionWatts, { High: "0.5W", Low: "0.5W" });
});

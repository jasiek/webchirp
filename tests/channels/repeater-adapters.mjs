// Every registered repeater directory adapter (createRepeaterAdapters in
// web/js/ui/repeater-sources.ts) answers with records that keep the
// RepeaterRecord invariants (repeaterRecordProblem in
// web/js/repeater-record.ts): integer hertz, an input that is null or a
// different frequency, modes from the closed list, well-formed tones, and a
// position in range or absent. Each adapter runs against its fixture through
// a fake fetch, for both the preview and the import. A new adapter joins
// FIXTURES; one missing from it fails the first test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildRepeaterEndpoints } from "../../web/js/datasources.ts";
import { REPEATER_MODES, repeaterRecordProblem } from "../../web/js/repeater-record.ts";
import { createRepeaterAdapters } from "../../web/js/ui/repeater-sources.ts";
import { installFakeDom } from "../support/fake-dom.mjs";
import { fakeXmlGlobals } from "../support/fake-xml.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

function fixture(name) {
  return readFileSync(path.join(repoRoot, "tests", "support", "fixtures", name), "utf8");
}

// Per adapter id: the fixture its directory answers with, and the form it is
// queried with. The RSGB fixture is one locator square's answer; every other
// square in the plan answers the way the API reports a miss.
const FIXTURES = {
  przemienniki: { body: fixture("rxf-przemienniki.xml"), modes: ["fm"] },
  repeaterbook: { body: fixture("rxf-repeaterbook.xml"), modes: ["fm"] },
  irts: { body: fixture("rxf-irts.xml"), modes: ["fm"] },
  rsgb: { body: fixture("rsgb-locator.json"), square: "IO82", modes: ["A", "D"] },
};

// Shrewsbury: inside the RSGB fixture's squares, and as good a centre as any
// for the RXF directories, which filter upstream (the fake ignores it).
const POSITION = { latitude: 52.708, longitude: -2.754 };

function adapters() {
  installFakeDom({ globals: fakeXmlGlobals() });
  const ctx = { log: { setStatus() {}, logDebug() {} } };
  return createRepeaterAdapters(ctx, { endpoints: buildRepeaterEndpoints("https://api.example.test") });
}

// Answer every request with the fixture its URL names.
function installFetch(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url) => {
      const text = String(url);
      const rsgbSquare = /\/locator\/([A-Z0-9]+)$/.exec(text)?.[1];
      if (rsgbSquare) {
        const payload = rsgbSquare === FIXTURES.rsgb.square ? JSON.parse(FIXTURES.rsgb.body) : { data: null };
        return { ok: true, status: 200, json: async () => payload };
      }
      const id = Object.keys(FIXTURES).find((key) => text.includes(`/${key}?`));
      if (!id) {
        throw new Error(`Unrouted fetch: ${text}`);
      }
      return { ok: true, status: 200, text: async () => FIXTURES[id].body };
    },
  });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "fetch", previous);
    } else {
      delete globalThis.fetch;
    }
  });
}

function values(id) {
  return {
    country: "",
    bands: [],
    modes: FIXTURES[id].modes,
    only: false,
    radius: 150,
    position: POSITION,
  };
}

test("every registered adapter has a fixture", () => {
  const ids = adapters().map((adapter) => adapter.id);
  assert.deepEqual(ids.filter((id) => !(id in FIXTURES)), [], "add the new adapter to FIXTURES");
  assert.deepEqual(new Set(ids).size, ids.length, "adapter ids are unique");
});

for (const purpose of ["import", "preview"]) {
  test(`every adapter's ${purpose} answers with well-formed RepeaterRecords`, async (t) => {
    installFetch(t);
    for (const adapter of adapters()) {
      const answer = await adapter.query(values(adapter.id), purpose);
      assert.ok(answer, `${adapter.id} had nothing to ask its directory`);
      assert.ok(answer.records.length > 0, `${adapter.id} found no records in its fixture`);
      for (const record of answer.records) {
        assert.equal(repeaterRecordProblem(record), "", `${adapter.id} ${record.name}`);
        assert.equal(record.source, adapter.id, `${adapter.id} ${record.name} is stamped with its source`);
        assert.ok(record.raw, `${adapter.id} ${record.name} keeps its raw record`);
      }
      for (const entry of answer.unusable) {
        assert.equal(entry.reason, "frequency", `${adapter.id} ${entry.repeater}`);
      }
    }
  });
}

test("the fixtures reach every mode the record can name", async (t) => {
  // So the invariant above is checked against each spelling the directories
  // use, not only against FM. RSGB's narrow analogue is the only source of
  // NFM, and "other" is RSGB's station flags (X, B, T).
  installFetch(t);
  const seen = new Set();
  for (const adapter of adapters()) {
    const answer = await adapter.query(values(adapter.id), "import");
    for (const record of answer.records) {
      record.modes.forEach((mode) => seen.add(mode));
    }
  }
  // RSGB's import filters to the asked modes, so its X/B/T records stay out.
  assert.deepEqual(REPEATER_MODES.filter((mode) => !seen.has(mode) && mode !== "other"), []);
});

test("repeaterRecordProblem names each broken invariant", () => {
  const good = {
    name: "GB3XX",
    outputHz: 145600000,
    inputHz: 145000000,
    modes: ["FM"],
    modeLabel: "FM",
    inputTone: { kind: "ctcss", hz: 88.5 },
    outputTone: { kind: "none" },
    locationName: "",
    latitude: 51.5,
    longitude: -0.1,
    positionApproximate: false,
    positionLocator: "",
    distanceKm: null,
    remarks: "",
    link: "",
    source: "test",
    sourceId: "",
    raw: {},
  };
  assert.equal(repeaterRecordProblem(good), "");
  for (const [change, pattern] of [
    [{ outputHz: 145.6 }, /outputHz/],
    [{ outputHz: 0 }, /outputHz/],
    [{ inputHz: 145600000 }, /inputHz/],
    [{ inputHz: 145000000.5 }, /inputHz/],
    [{ modes: [] }, /modes is empty/],
    [{ modes: ["C4FM"] }, /not a RepeaterMode/],
    [{ inputTone: { kind: "ctcss", hz: 0 } }, /inputTone/],
    [{ outputTone: { kind: "dcs", code: "D23" } }, /outputTone/],
    [{ outputTone: { kind: "tone" } }, /outputTone/],
    [{ latitude: 95 }, /out of range/],
    [{ longitude: null }, /null together/],
    [{ distanceKm: -1 }, /distanceKm/],
  ]) {
    assert.match(repeaterRecordProblem({ ...good, ...change }), pattern, JSON.stringify(change));
  }
  assert.equal(repeaterRecordProblem({ ...good, inputHz: null }), "", "simplex is a null input");
  assert.equal(repeaterRecordProblem({ ...good, latitude: null, longitude: null }), "", "no position");
});

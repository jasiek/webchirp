import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { QUANSHENG_UNOFFICIAL_DRIVERS } from "../../web/js/python-sources.ts";
import { sortRadioCatalog } from "../../web/js/radio-catalog-order.ts";
import { webDir } from "../support/repo-paths.mjs";

async function readCatalog(fileName) {
  return JSON.parse(await fs.readFile(path.join(webDir, fileName), "utf8"));
}

function entry(vendor, model, releaseLabel) {
  return releaseLabel === undefined ? { vendor, model } : { vendor, model, releaseLabel };
}

// One firmware line renames its model between releases, so the release, not
// the model, has to decide the order; v6.10.0 must not land before v6.2.0.
test("releases of one vendor list oldest first, whatever their model", () => {
  const sorted = sortRadioCatalog([
    entry("Quansheng", "UV-K1 & UV-K5 V3 (F4HWN)", "v6.10.0"),
    entry("Quansheng", "UV-K1 & UV-K5 V3 (F4HWN Fusion)", "v5.9.0"),
    entry("Quansheng", "UV-K1 & UV-K5 V3 (F4HWN)", "v6.2.0"),
    entry("Quansheng", "UV-K5 (egzumer + f4hwn)", "v4.3.2"),
  ]);
  assert.deepEqual(
    sorted.map((radio) => radio.releaseLabel),
    ["v4.3.2", "v5.9.0", "v6.2.0", "v6.10.0"],
  );
});

// A vendor whose name starts another's sorts first, which a single
// "vendor\u0000model" string got wrong: collation ignores U+0000.
test("entries without a release list by vendor, then model", () => {
  const sorted = sortRadioCatalog([
    entry("TIDRADIO", "TD-H3"),
    entry("TID", "TD-UV68"),
    entry("TID", "TD-M8"),
    entry("Baofeng", "UV-5R"),
  ]);
  assert.deepEqual(
    sorted.map((radio) => `${radio.vendor} ${radio.model}`),
    ["Baofeng UV-5R", "TID TD-M8", "TID TD-UV68", "TIDRADIO TD-H3"],
  );
});

test("the committed catalogs are written in picker order", async () => {
  for (const fileName of ["radio-catalog.json", "radio-catalog-quansheng-unofficial.json"]) {
    const { radios } = await readCatalog(fileName);
    assert.deepEqual(
      radios.map((radio) => radio.key),
      sortRadioCatalog(radios).map((radio) => radio.key),
      `${fileName} is out of order: run npm run build:catalog`,
    );
  }
});

test("the unofficial catalog lists every bundled F4HWN release in version order", async () => {
  const { radios } = await readCatalog("radio-catalog-quansheng-unofficial.json");
  assert.deepEqual(
    radios.map((radio) => radio.releaseLabel),
    QUANSHENG_UNOFFICIAL_DRIVERS.map((driver) => driver.releases.join(" / ")),
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createBrowserCdnPythonSource,
  DEFAULT_DRIVER_SET,
  driverSetFromSearch,
  EXTRA_DRIVER_RELATIVE_FILES,
  listDriverModules,
  QUANSHENG_UNOFFICIAL_DRIVERS,
  QUANSHENG_UNOFFICIAL_DRIVER_MODULES,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
  RUNTIME_PYTHON_FILES,
} from "../../web/js/python-sources.mjs";
import { listRegisteredRadios, sharedHarness } from "../support/chirp.mjs";
import { webDir } from "../support/repo-paths.mjs";

const MODULE = "f4hwn_v6";
const CLASS_NAME = "UVK5RadioEgzumer";

// Pin every byte-distinct published asset: a silent local edit would otherwise
// look like the named upstream release while no longer being it. v4.3.0,
// v4.3.1 and v4.3.2 deliberately share one entry because all three assets are
// byte-for-byte identical and identify themselves as driver v4.3.0.
test("the bundled F4HWN drivers are the exact published releases", async () => {
  assert.equal(QUANSHENG_UNOFFICIAL_DRIVERS.length, 13);
  assert.equal(QUANSHENG_UNOFFICIAL_DRIVERS.flatMap((driver) => driver.releases).length, 15);
  for (const driver of QUANSHENG_UNOFFICIAL_DRIVERS) {
    const source = await fs.readFile(path.join(webDir, "python", driver.relPath));
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      driver.sha256,
      driver.releases.join(", "),
    );
  }
});

// Bundling the source is only half of making it selectable: every source
// provider must enumerate the module so catalog builds and runtime fallback
// discovery import it alongside the pinned upstream modules.
test("the drivers query selects one driver collection", () => {
  assert.equal(driverSetFromSearch(""), DEFAULT_DRIVER_SET);
  assert.equal(driverSetFromSearch("?drivers=chirp"), DEFAULT_DRIVER_SET);
  assert.equal(
    driverSetFromSearch("?drivers=quansheng-unofficial"),
    QUANSHENG_UNOFFICIAL_DRIVER_SET,
  );
  assert.equal(driverSetFromSearch("?drivers=unknown"), DEFAULT_DRIVER_SET);
});

test("browser sources fetch only the selected driver collection", async () => {
  const runtimeFileUrls = Object.fromEntries(
    [...RUNTIME_PYTHON_FILES, ...EXTRA_DRIVER_RELATIVE_FILES].map((relPath) => [
      relPath,
      `/runtime/${relPath}`,
    ]),
  );
  const fetchedText = [];
  let fetchedIndexes = 0;
  const sourceOptions = {
    runtimeFileUrls,
    fetchTextImpl: async (url) => {
      fetchedText.push(url);
      return url;
    },
    fetchJsonImpl: async () => {
      fetchedIndexes += 1;
      return { files: [{ name: "/chirp/drivers/uv5r.py" }] };
    },
  };

  const unofficial = createBrowserCdnPythonSource({
    ...sourceOptions,
    driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET,
  });
  assert.deepEqual(await unofficial.listDriverModules(), QUANSHENG_UNOFFICIAL_DRIVER_MODULES);
  assert.equal(fetchedIndexes, 0, "unofficial discovery should not fetch the CHIRP driver index");
  await unofficial.fetchChirpSource("/chirp/drivers/f4hwn_v6.py");
  assert.equal(
    fetchedText.at(-1),
    "/runtime/extra_drivers/quansheng/f4hwn_v6.py",
  );

  const chirp = createBrowserCdnPythonSource(sourceOptions);
  assert.deepEqual(await chirp.listDriverModules(), ["uv5r"]);
  assert.equal(fetchedIndexes, 1);
  await chirp.fetchChirpSource("/chirp/drivers/f4hwn_v6.py");
  assert.match(fetchedText.at(-1), /\/chirp\/drivers\/f4hwn_v6\.py$/);
  assert.notEqual(fetchedText.at(-1), "/runtime/extra_drivers/quansheng/f4hwn_v6.py");
});

test("unofficial mode discovers only bundled F4HWN drivers", async () => {
  const harness = await sharedHarness({ driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET });
  assert.deepEqual(
    QUANSHENG_UNOFFICIAL_DRIVER_MODULES,
    QUANSHENG_UNOFFICIAL_DRIVERS.map((driver) => driver.module),
  );
  const discovered = await listDriverModules(harness.pythonSource);
  assert.deepEqual(discovered, QUANSHENG_UNOFFICIAL_DRIVER_MODULES);
});

test("CHIRP mode excludes bundled F4HWN drivers", async () => {
  const harness = await sharedHarness();
  const discovered = await listDriverModules(harness.pythonSource);
  assert.equal(discovered.length, 193);
  assert.deepEqual(
    discovered.filter((moduleName) => QUANSHENG_UNOFFICIAL_DRIVER_MODULES.includes(moduleName)),
    [],
  );
});

test("each driver mode has a matching static catalog", async () => {
  const chirpCatalog = JSON.parse(
    await fs.readFile(path.join(webDir, "radio-catalog.json"), "utf8"),
  );
  const unofficialCatalog = JSON.parse(
    await fs.readFile(
      path.join(webDir, "radio-catalog-quansheng-unofficial.json"),
      "utf8",
    ),
  );
  assert.equal(chirpCatalog.driverSet, DEFAULT_DRIVER_SET);
  assert.equal(unofficialCatalog.driverSet, QUANSHENG_UNOFFICIAL_DRIVER_SET);
  assert.equal(chirpCatalog.count, chirpCatalog.radios.length);
  assert.equal(unofficialCatalog.count, unofficialCatalog.radios.length);
  assert.deepEqual(
    chirpCatalog.radios.filter((radio) =>
      QUANSHENG_UNOFFICIAL_DRIVER_MODULES.includes(radio.module)),
    [],
  );
  assert.deepEqual(
    unofficialCatalog.radios.map((radio) => radio.module).sort(),
    [...QUANSHENG_UNOFFICIAL_DRIVER_MODULES].sort(),
  );
  for (const driver of QUANSHENG_UNOFFICIAL_DRIVERS) {
    const radio = unofficialCatalog.radios.find((entry) => entry.module === driver.module);
    assert.equal(radio.variant ?? "", "");
    assert.equal(radio.releaseLabel, driver.releases.join(" / "));
  }
});

// Releases share native CHIRP identities, so selecting a release must import
// it in its own runtime rather than alter the identity saved in desktop images.
test("every F4HWN release registers with its native identity in an isolated runtime", async () => {
  for (const driver of QUANSHENG_UNOFFICIAL_DRIVERS) {
    const harness = await sharedHarness({
      driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET,
      isolated: true,
    });
    const radios = await listRegisteredRadios(harness, [driver.module]);
    assert.equal(radios.length, 1);
    const [radio] = radios;
    assert.ok(radio, driver.module);
    assert.equal(radio.key, `${driver.module}:${CLASS_NAME}`);
    assert.equal(radio.className, CLASS_NAME);
    assert.equal(radio.vendor, "Quansheng");
    assert.equal(radio.baudRate, 38400);
    assert.equal(radio.isLiveRadio, false);
    assert.equal(radio.variant ?? "", "");
    const metadata = await harness.runPythonJson(
      "json.dumps(get_radio_column_metadata(_module, _class_name))",
      { _module: driver.module, _class_name: CLASS_NAME },
    );
    const columns = metadata.columns;
    assert.equal(columns.Location.min, 1);
    assert.ok(columns.Location.max >= 200);
    assert.ok(columns.Mode.options.includes("USB"));

    const wxResult = await harness.runPythonJson(
      `
import json
import wx
json.dumps({
    "answer": wx.MessageBox("Proceed?", "Warning", wx.OK | wx.CANCEL),
    "cancel": wx.CANCEL,
})
      `,
    );
    assert.equal(wxResult.answer, wxResult.cancel, "desktop-only confirmations must fail safe");
  }
});

// Exercise the same bridge surfaces the browser reaches after a radio read:
// codeplug parsing, row editing, settings serialization/validation and image
// caching. An erased map avoids inventing a hardware fixture while still
// making the driver's entire bitwise layout parse.
test("the F4HWN v6 driver loads channels and settings through WebCHIRP", async () => {
  const harness = await sharedHarness({ driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET, isolated: true });
  const result = await harness.runPythonJson(
    `
import copy
import importlib
import json
import warnings
from chirp import chirp_common, memmap

warnings.simplefilter("ignore", FutureWarning)
driver = importlib.import_module("chirp.drivers." + _module)
radio = getattr(driver, _class_name)(None)
radio._mmap = memmap.MemoryMapBytes(bytes([0xFF]) * driver.MEM_SIZE)
radio.process_mmap()

memory = chirp_common.Memory()
memory.number = 1
memory.empty = False
memory.freq = 145500000
memory.name = "TEST"
memory.mode = "FM"
memory.tuning_step = 12.5
memory.power = driver.UVK5_POWER_LEVELS[-1]
row = _row_from_memory(memory)
_apply_rows_to_radio_instance(radio, [row], _module, _class_name)
loaded = radio.get_memory(1)

payload = _read_radio_payload(_module, _class_name, radio)
settings = get_radio_settings(_module, _class_name)
validation = validate_radio_settings(_module, _class_name, settings["groups"])

def setting_value(nodes, setting_id, replacement=None):
    for node in nodes:
        if node.get("kind") == "setting" and node.get("id") == setting_id:
            if replacement is not None:
                node["values"][0]["current"] = replacement
            return node["values"][0]["current"]
        found = setting_value(node.get("children") or [], setting_id, replacement)
        if found is not None:
            return found
    return None

risky_settings = copy.deepcopy(settings["groups"])
setting_value(risky_settings, "upload_advanced", True)
setting_value(risky_settings, "upload_calibration", True)
safe_validation = validate_radio_settings(_module, _class_name, risky_settings)
image = get_cached_image_base64(_module, _class_name)
reloaded = load_image_base64(image["imageBase64"])
raw_image = base64.b64decode(image["imageBase64"])
image_body, native_metadata = chirp_common.CloneModeRadio._strip_metadata(raw_image)
json.dumps({
    "loaded": {
        "number": loaded.number,
        "empty": loaded.empty,
        "freq": loaded.freq,
        "name": loaded.name,
        "mode": loaded.mode,
        "step": loaded.tuning_step,
        "power": str(loaded.power),
    },
    "rows": len(payload["rows"]),
    "unreadable": payload["unreadableChannels"],
    "settingsAvailable": settings["available"],
    "settingsGroups": len(settings["groups"]),
    "settingsValid": validation["valid"],
    "settingsIssues": validation["issues"],
    "advancedAccepted": setting_value(safe_validation["settings"], "upload_advanced"),
    "calibrationAccepted": setting_value(safe_validation["settings"], "upload_calibration"),
    "imageSize": image["size"],
    "reloaded": {
        "module": reloaded["module"],
        "className": reloaded["className"],
        "rows": len(reloaded["rows"]),
    },
    "nativeMetadata": native_metadata,
})
    `,
    { _module: MODULE, _class_name: CLASS_NAME },
  );

  assert.deepEqual(result.loaded, {
    number: 1,
    empty: false,
    freq: 145500000,
    name: "TEST",
    mode: "FM",
    step: 12.5,
    power: "HIGH = 5W",
  });
  assert.equal(result.rows, 1);
  assert.deepEqual(result.unreadable, []);
  assert.equal(result.settingsAvailable, true);
  assert.equal(result.settingsGroups, 11);
  assert.equal(result.settingsValid, true);
  assert.deepEqual(result.settingsIssues, []);
  assert.equal(result.advancedAccepted, false);
  assert.equal(result.calibrationAccepted, false);
  assert.ok(result.imageSize > 0xB190, "saved image should include CHIRP metadata");
  assert.deepEqual(result.reloaded, {
    module: MODULE,
    className: CLASS_NAME,
    rows: 1,
  });
  assert.equal(result.nativeMetadata.variant, "");
  assert.equal(result.nativeMetadata.rclass, CLASS_NAME);
});

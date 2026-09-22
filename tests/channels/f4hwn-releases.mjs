import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BUNDLED_DRIVERS,
  BUNDLED_DRIVER_MODULES,
  listDriverModules,
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
  assert.equal(BUNDLED_DRIVERS.length, 13);
  assert.equal(BUNDLED_DRIVERS.flatMap((driver) => driver.releases).length, 15);
  for (const driver of BUNDLED_DRIVERS) {
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
test("all bundled F4HWN drivers participate in lazy driver discovery", async () => {
  const harness = await sharedHarness();
  assert.deepEqual(
    BUNDLED_DRIVER_MODULES,
    BUNDLED_DRIVERS.map((driver) => driver.module),
  );
  const discovered = await listDriverModules(harness.pythonSource);
  assert.deepEqual(
    BUNDLED_DRIVER_MODULES.filter((moduleName) => discovered.includes(moduleName)),
    BUNDLED_DRIVER_MODULES,
  );
});

test("every F4HWN release registers with a distinct selectable version", async () => {
  const harness = await sharedHarness();
  const radios = await listRegisteredRadios(harness, BUNDLED_DRIVER_MODULES);
  assert.equal(radios.length, BUNDLED_DRIVERS.length);
  const byModule = Object.fromEntries(radios.map((radio) => [radio.module, radio]));
  for (const driver of BUNDLED_DRIVERS) {
    const releaseLabel = driver.releases.length === 1
      ? driver.releases[0]
      : `${driver.releases[0]}-${driver.releases.at(-1)}`;
    const radio = byModule[driver.module];
    assert.ok(radio, driver.module);
    assert.equal(radio.key, `${driver.module}:${CLASS_NAME}`);
    assert.equal(radio.className, CLASS_NAME);
    assert.equal(radio.vendor, "Quansheng");
    assert.equal(radio.baudRate, 38400);
    assert.equal(radio.isLiveRadio, false);
    assert.equal(radio.variant, `F4HWN driver ${releaseLabel}`);
  }

  const metadata = await harness.runPythonJson(
    `json.dumps({
        module_name: get_radio_column_metadata(module_name, _class_name)
        for module_name in _modules
    })`,
    { _modules: BUNDLED_DRIVER_MODULES, _class_name: CLASS_NAME },
  );
  for (const driver of BUNDLED_DRIVERS) {
    const columns = metadata[driver.module].columns;
    assert.equal(columns.Location.min, 1);
    assert.ok(columns.Location.max >= 200);
    assert.ok(columns.Mode.options.includes("USB"));
  }

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
});

// Exercise the same bridge surfaces the browser reaches after a radio read:
// codeplug parsing, row editing, settings serialization/validation and image
// caching. An erased map avoids inventing a hardware fixture while still
// making the driver's entire bitwise layout parse.
test("the F4HWN v6 driver loads channels and settings through WebCHIRP", async () => {
  const harness = await sharedHarness();
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
image_body, legacy_metadata = chirp_common.CloneModeRadio._strip_metadata(raw_image)
legacy_metadata["variant"] = ""
legacy_image = image_body + chirp_common.CloneModeRadio.MAGIC + base64.b64encode(
    json.dumps(legacy_metadata).encode()
)
legacy_loaded = load_image_base64(base64.b64encode(legacy_image).decode(), _module, _class_name)
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
    "legacyLoaded": {
        "module": legacy_loaded["module"],
        "className": legacy_loaded["className"],
        "rows": len(legacy_loaded["rows"]),
    },
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
  assert.deepEqual(result.legacyLoaded, {
    module: MODULE,
    className: CLASS_NAME,
    rows: 1,
  });
});

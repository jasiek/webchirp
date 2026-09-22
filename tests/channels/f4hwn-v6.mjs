import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BUNDLED_DRIVER_MODULES,
  listDriverModules,
} from "../../web/js/python-sources.mjs";
import { listRegisteredRadios, sharedHarness } from "../support/chirp.mjs";
import { webDir } from "../support/repo-paths.mjs";

const MODULE = "f4hwn_v6";
const CLASS_NAME = "UVK5RadioEgzumer";
const RELEASE_SHA256 = "c1c560ae081a40ea7aee0cd1e71b47641e63d64aea8886412c1041bda14f5156";

// Pin the exact third-party release being shipped: a silent local edit would
// otherwise look like the named upstream v6.0.0 driver while no longer being it.
test("the bundled F4HWN driver is the unmodified v6.0.0 release", async () => {
  const source = await fs.readFile(
    path.join(webDir, "python", "chirp", "drivers", `${MODULE}.py`),
  );
  assert.equal(createHash("sha256").update(source).digest("hex"), RELEASE_SHA256);
});

// Bundling the source is only half of making it selectable: every source
// provider must enumerate the module so catalog builds and runtime fallback
// discovery import it alongside the pinned upstream modules.
test("the bundled F4HWN driver participates in driver discovery", async () => {
  const harness = await sharedHarness();
  assert.deepEqual(BUNDLED_DRIVER_MODULES, [MODULE]);
  assert.ok((await listDriverModules(harness.pythonSource)).includes(MODULE));
});

test("the F4HWN v6 radio registers through the wx compatibility shim", async () => {
  const harness = await sharedHarness();
  const radios = await listRegisteredRadios(harness, [MODULE]);
  assert.deepEqual(radios, [
    {
      key: `${MODULE}:${CLASS_NAME}`,
      module: MODULE,
      className: CLASS_NAME,
      vendor: "Quansheng",
      model: "UV-K1 & UV-K5 V3 (F4HWN)",
      baudRate: 38400,
      isLiveRadio: false,
    },
  ]);

  const metadata = await harness.runPythonJson(
    "json.dumps(get_radio_column_metadata(_module, _class_name))",
    { _module: MODULE, _class_name: CLASS_NAME },
  );
  assert.equal(metadata.columns.Location.min, 1);
  assert.equal(metadata.columns.Location.max, 1024);
  assert.ok(metadata.columns.Mode.options.includes("USB"));

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
});

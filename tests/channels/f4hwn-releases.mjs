import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  chirpBundleFileNames,
  createBrowserPythonSource,
  DEFAULT_CHIRP_REVISION,
  DEFAULT_DRIVER_SET,
  driverSetFromSearch,
  EXTRA_DRIVER_RELATIVE_FILES,
  listDriverModules,
  QUANSHENG_UNOFFICIAL_DRIVERS,
  QUANSHENG_UNOFFICIAL_DRIVER_MODULES,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
  RUNTIME_PYTHON_FILES,
} from "../../web/js/python-sources.ts";
import { listRegisteredRadios, sharedHarness } from "../support/chirp.mjs";
import { webDir } from "../support/repo-paths.mjs";

const CLASS_NAME = "UVK5RadioEgzumer";

// Pin the retained releases and their published bytes. The v4.3.2 asset still
// identifies itself as driver v4.3.0; its catalog label names the release.
test("the bundled F4HWN drivers are the exact published releases", async () => {
  assert.equal(QUANSHENG_UNOFFICIAL_DRIVERS.length, 7);
  assert.deepEqual(
    QUANSHENG_UNOFFICIAL_DRIVERS.flatMap((driver) => driver.releases),
    ["v4.3.2", "v5.9.0", "v6.0.0", "v6.1.0", "v6.2.0", "v6.3.0", "v7.0.0"],
  );
  assert.deepEqual(
    (await fs.readdir(path.join(webDir, "python/extra_drivers/quansheng")))
      .filter((name) => name.endsWith(".py")).sort(),
    QUANSHENG_UNOFFICIAL_DRIVERS.map((driver) => path.basename(driver.relPath)).sort(),
  );
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

test("browser sources list only the selected driver collection", async () => {
  const runtimeFileUrls = Object.fromEntries(
    [...RUNTIME_PYTHON_FILES, ...EXTRA_DRIVER_RELATIVE_FILES].map((relPath) => [
      relPath,
      `/runtime/${relPath}`,
    ]),
  );
  const fetchedJson = [];
  const sourceOptions = {
    runtimeFileUrls,
    chirpBundleBaseUrl: "https://example.test/chirp/",
    fetchTextImpl: async (url) => url,
    fetchJsonImpl: async (url) => {
      fetchedJson.push(url);
      return { chirpRevision: DEFAULT_CHIRP_REVISION, drivers: ["uv5r"] };
    },
  };

  const unofficial = createBrowserPythonSource({
    ...sourceOptions,
    driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET,
  });
  assert.deepEqual(await unofficial.listDriverModules(), QUANSHENG_UNOFFICIAL_DRIVER_MODULES);
  assert.equal(fetchedJson.length, 0, "unofficial discovery should not read the bundle manifest");
  assert.equal(unofficial.getRuntimeInfo().driverSet, QUANSHENG_UNOFFICIAL_DRIVER_SET);

  const chirp = createBrowserPythonSource(sourceOptions);
  assert.deepEqual(await chirp.listDriverModules(), ["uv5r"]);
  assert.deepEqual(await chirp.listDriverModules(), ["uv5r"]);
  assert.deepEqual(
    fetchedJson,
    [`https://example.test/chirp/${chirpBundleFileNames(DEFAULT_CHIRP_REVISION).manifest}`],
    "the manifest is read from the bundle directory, once",
  );
  assert.equal(chirp.getRuntimeInfo().driverSet, DEFAULT_DRIVER_SET);
});

test("a manifest for another pin is refused before any driver is imported", async () => {
  const runtimeFileUrls = Object.fromEntries(
    [...RUNTIME_PYTHON_FILES, ...EXTRA_DRIVER_RELATIVE_FILES].map((relPath) => [
      relPath,
      `/runtime/${relPath}`,
    ]),
  );
  const stale = createBrowserPythonSource({
    runtimeFileUrls,
    chirpBundleBaseUrl: "https://example.test/chirp/",
    fetchJsonImpl: async () => ({ chirpRevision: "0".repeat(40), drivers: ["uv5r"] }),
  });
  await assert.rejects(stale.listDriverModules(), /manifest is for revision 0{40}/);
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
  assert.equal(discovered.length, 203);
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
      "json.dumps(get_radio_column_metadata(_sid))",
      { _sid: await harness.session(driver.module, CLASS_NAME) },
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
// making the driver's entire bitwise layout parse. Every v6 release runs it:
// v6.1.0 changed the layout (a scan-mix block, a longer write range) and adds
// a "Mixed Scan Lists" settings group, and v6.2.0 adds a "TONE CALL" key
// action, so none stands in for another. v6.3.0 changes only the driver's
// version string, but it is still a module of its own to import. v7.0.0
// names two bytes v6.3.0 left unused, as the SetFnt and SetRxG settings.
const V6_RELEASES = [
  { module: "f4hwn_v6", release: "v6.0.0", settingsGroups: 11 },
  { module: "f4hwn_v6_1_0", release: "v6.1.0", settingsGroups: 12 },
  { module: "f4hwn_v6_2_0", release: "v6.2.0", settingsGroups: 12 },
  { module: "f4hwn_v6_3_0", release: "v6.3.0", settingsGroups: 12 },
  { module: "f4hwn_v7_0_0", release: "v7.0.0", settingsGroups: 12 },
];
for (const { module: MODULE, release, settingsGroups } of V6_RELEASES) {
  test(`the F4HWN ${release} driver loads channels and settings through WebCHIRP`, async () => {
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
_apply_rows_to_radio_instance(radio, [row])
loaded = radio.get_memory(1)

# Recorded as a download would record it: the session's image comes from the
# radio, which is what opens the settings and upload gates.
session = open_radio_session(_module, _class_name)
payload = _read_radio_payload(session, radio, ImageOrigin.RADIO)
settings = get_radio_settings(session.session_id)
validation = validate_radio_settings(session.session_id, settings["groups"])

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
safe_validation = validate_radio_settings(session.session_id, risky_settings)
image = get_cached_image_base64(session.session_id)
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
    assert.equal(result.settingsGroups, settingsGroups);
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
}

// FINDINGS f4hwn-older-driver-drops-new-key-actions: v6.2.0 differs from
// v6.1.0 only in its version string and a "TONE CALL" appended to
// KEYACTIONS_LIST, yet v6.1.0's get_action clamps any index past its own list
// to 0. A radio with a key set to TONE CALL therefore reads as NONE under
// v6.1.0, and once any setting is edited, set_settings writes every key
// action back, storing NONE (0). This pins why each release is bundled as its
// own module rather than one driver standing in for its neighbours; it is
// bundled driver behaviour, not an upstream defect awaiting a fix. An
// unedited write leaves the byte alone, because set_settings runs only on an
// edit (_validate_and_apply_radio_settings).
const TONE_CALL_RELEASES = [
  { module: "f4hwn_v6_1_0", release: "v6.1.0", reads: "NONE", afterEdit: "cleared" },
  { module: "f4hwn_v6_2_0", release: "v6.2.0", reads: "TONE CALL", afterEdit: "kept" },
];
test("a TONE CALL key reads and writes back as NONE under the v6.1.0 driver only", async () => {
  const results = {};
  for (const { module: MODULE, release } of TONE_CALL_RELEASES) {
    const harness = await sharedHarness({ driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET, isolated: true });
    results[release] = await harness.runPythonJson(
      `
import copy
import importlib
import json
import warnings
from chirp import chirp_common, memmap

warnings.simplefilter("ignore", FutureWarning)
driver = importlib.import_module("chirp.drivers." + _module)
# Releases share a registered id, so one runtime cannot import both. Each
# plants the byte TONE CALL is stored as: its index where the list has it,
# one past the last action where it does not (checked equal below).
actions = list(driver.KEYACTIONS_LIST)
tone_call = actions.index("TONE CALL") if "TONE CALL" in actions else len(actions)

radio = getattr(driver, _class_name)(None)
radio._mmap = memmap.MemoryMapBytes(bytes([0xFF]) * driver.MEM_SIZE)
radio.process_mmap()
radio._memobj.key1_shortpress_action = tone_call

session = open_radio_session(_module, _class_name)
payload = _read_radio_payload(session, radio, ImageOrigin.RADIO)
settings = get_radio_settings(session.session_id)

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

def stored_key1(exported):
    body, _metadata = chirp_common.CloneModeRadio._strip_metadata(
        base64.b64decode(exported["imageBase64"]))
    written = getattr(driver, _class_name)(memmap.MemoryMapBytes(body))
    return int(written._memobj.key1_shortpress_action)

unedited = export_image_base64(session.session_id, payload["rows"], settings["groups"])
edited_groups = copy.deepcopy(settings["groups"])
setting_value(edited_groups, "key2_shortpress_action", "FLASHLIGHT")
edited = export_image_base64(session.session_id, payload["rows"], edited_groups)
json.dumps({
    "actions": actions,
    "toneCall": tone_call,
    "reads": setting_value(settings["groups"], "key1_shortpress_action"),
    "unedited": stored_key1(unedited),
    "edited": stored_key1(edited),
})
      `,
      { _module: MODULE, _class_name: CLASS_NAME },
    );
  }

  // v6.2.0's list is v6.1.0's with TONE CALL appended, so both runs planted
  // the same byte.
  const older = results["v6.1.0"].actions;
  assert.deepEqual(results["v6.2.0"].actions, [...older, "TONE CALL"]);
  const toneCall = older.length;
  for (const { release, reads, afterEdit } of TONE_CALL_RELEASES) {
    const result = results[release];
    assert.equal(result.toneCall, toneCall);
    assert.equal(result.reads, reads, `${release} shows the TONE CALL key as ${reads}`);
    assert.equal(result.unedited, toneCall, `${release}: an unedited write keeps the byte`);
    assert.equal(
      result.edited,
      afterEdit === "cleared" ? 0 : toneCall,
      `${release}: editing another setting ${afterEdit} the TONE CALL key`,
    );
  }
});

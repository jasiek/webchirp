// Shared CHIRP-runtime helpers for the Pyodide-backed node:test files. Each
// one replaces a snippet that used to be pasted into several test files: the
// harness boot with repoRoot spelled out, the radio-catalog read, the
// chirp/tests/images read, and the handful of runtime_bridge.py calls every
// image-driven test makes before it gets to the thing it actually tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { findCatalogRadioForImageMetadata } from "../../web/js/image-metadata.mjs";
import { createTestRadioHarness } from "./radio-harness.mjs";
import { chirpImagesDir, repoRoot, webDir } from "./repo-paths.mjs";

// The booted runtime for this repo. Memoized by createTestRadioHarness(), so
// every test in a file that calls this gets the same harness; pass
// isolated: true for a fresh boot when a test must not see earlier tests'
// Python state. Other options go through to the harness unchanged.
export function sharedHarness(options = {}) {
  return createTestRadioHarness({ repoRoot, ...options });
}

// The radios array from web/radio-catalog.json, which is what the browser
// resolves image metadata against.
export async function readCatalog() {
  const text = await fs.readFile(path.join(webDir, "radio-catalog.json"), "utf8");
  return JSON.parse(text).radios;
}

// Raw bytes of one upstream test image from chirp/tests/images. A Buffer is a
// Uint8Array, so it goes straight into the harness's binary methods.
export function readImage(name) {
  return fs.readFile(path.join(chirpImagesDir, name));
}

// Import one driver module in the runtime, the way the browser does before it
// touches a selected radio. The trailing json.dumps keeps runPythonJson happy;
// ensure_radio_module() itself returns None.
export async function ensureModule(harness, moduleName) {
  await harness.runPythonJson("ensure_radio_module(_m) or json.dumps({})", { _m: moduleName });
}

// The metadata trailer of a CHIRP image, without importing any driver. Takes
// the image bytes, or an already base64-encoded image for tests that craft
// one in Python and get base64 back.
export function imageMetadata(harness, image) {
  const encoded = typeof image === "string" ? image : Buffer.from(image).toString("base64");
  return harness.runPythonJson("json.dumps(read_image_metadata_base64(_b))", { _b: encoded });
}

// Every driver, then every driver that could not be imported, the way the
// browser's all-drivers sweep runs. progressCb is only passed through when
// the caller gives one, so a test can still exercise the argument's default.
export function importAllDriverModules(harness, moduleNames, progressCb) {
  if (progressCb === undefined) {
    return harness.runPythonJson("json.dumps(import_all_driver_modules(_mods))", {
      _mods: moduleNames,
    });
  }
  return harness.runPythonJson("json.dumps(import_all_driver_modules(_mods, _cb))", {
    _mods: moduleNames,
    _cb: progressCb,
  });
}

// Import the named driver modules and list the radios they registered with
// CHIRP's directory, as the catalog build and the model picker see them.
export function listRegisteredRadios(harness, moduleNames) {
  return harness.runPythonJson("json.dumps(list_registered_radios(_mods))", {
    _mods: moduleNames,
  });
}

// The browser's image-load path for one upstream test image: read its
// metadata, resolve the catalog radio, import that driver, then load the
// image. Returns the resolved catalog entry, the loaded codeplug and the raw
// bytes, which is what a round-trip test needs to write it back.
export async function loadImageFor(harness, catalog, name) {
  const raw = await readImage(name);
  const metadata = await imageMetadata(harness, raw);
  const match = findCatalogRadioForImageMetadata(catalog, metadata);
  assert.ok(match, `${name} should resolve to a catalog radio`);
  await ensureModule(harness, match.module);
  const loaded = await harness.loadCodeplugBinary(raw);
  return { match, loaded, raw };
}

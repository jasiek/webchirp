import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness, resolveChirpPackageDir } from "./test-radio-harness.mjs";

// CHIRP calls its translation helpers as builtins, which only the wx frontend
// installs. These are every spelling gettext can install; the scan below finds
// the ones this CHIRP revision actually uses in the modules the browser
// runtime imports.
const TRANSLATION_BUILTINS = ["_", "gettext", "ngettext", "pgettext", "npgettext"];

// Directories the browser runtime can import. chirp/wxui is excluded on
// purpose: it installs these builtins itself and never loads in Pyodide.
const RUNTIME_SOURCE_DIRS = [".", "drivers", "sources"];

async function listRuntimeSourceFiles(chirpPackageDir) {
  const files = [];
  for (const dirName of RUNTIME_SOURCE_DIRS) {
    const dir = path.join(chirpPackageDir, dirName);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

// Match a bare call like `_("FM Radio")`, but not an attribute (`self._(`) or a
// longer identifier that merely ends in the same letters (`_mem(`, `my_(`).
function callPattern(name) {
  return new RegExp(`(^|[^A-Za-z0-9_.])${name}\\s*\\(`);
}

async function findTranslationBuiltinUses(files) {
  const uses = new Map();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const name of TRANSLATION_BUILTINS) {
      if (callPattern(name).test(source)) {
        if (!uses.has(name)) {
          uses.set(name, []);
        }
        uses.get(name).push(path.basename(file));
      }
    }
  }
  return uses;
}

test("CHIRP's translation builtins are available to the browser runtime", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chirpPackageDir = await resolveChirpPackageDir(
    process.env.WEBCHIRP_CHIRP_DIR || path.join(repoRoot, "chirp"),
  );
  const uses = await findTranslationBuiltinUses(await listRuntimeSourceFiles(chirpPackageDir));
  const harness = await createTestRadioHarness({ repoRoot });

  // Probe defensively: a missing builtin must fail the subtest that names it,
  // not blow up this shared setup and hide the rest.
  const runtime = await harness.runPythonJson(
    `
def _probe_call(_fn):
    try:
        return _fn()
    except Exception as _exc:
        return "%s: %s" % (type(_exc).__name__, _exc)

json.dumps({
    "installed": {
        _name: callable(getattr(builtins, _name, None))
        for _name in json.loads(_names_json)
    },
    "identity": _probe_call(lambda: _("FM Radio")),
    "singular": _probe_call(lambda: ngettext("memory", "memories", 1)),
    "plural": _probe_call(lambda: ngettext("memory", "memories", 2)),
    "wxuiImported": "chirp.wxui" in sys.modules,
})
    `,
    { _names_json: JSON.stringify(TRANSLATION_BUILTINS) },
  );

  await t.test("every translation builtin CHIRP calls is installed", () => {
    // Guards against a vacuous pass if the scan ever stops matching.
    assert.ok(
      (uses.get("_") || []).includes("uvk5.py"),
      "expected the scan to find _() calls in the uvk5 driver",
    );
    for (const [name, files] of uses) {
      assert.equal(
        runtime.installed[name],
        true,
        `${name}() is called by ${files.length} runtime module(s) (e.g. ${files[0]}) but is not an installed builtin`,
      );
    }
  });

  await t.test("translation builtins pass source strings through untranslated", () => {
    assert.equal(runtime.identity, "FM Radio");
    assert.equal(runtime.singular, "memory");
    assert.equal(runtime.plural, "memories");
  });

  await t.test("the builtins come from the runtime, not from loading chirp.wxui", () => {
    // chirp.wxui needs wx, which Pyodide does not have; if it ever appears here
    // the builtins are being installed by accident and will vanish.
    assert.equal(runtime.wxuiImported, false);
  });

  await t.test("uvk5 builds its settings tree from a loaded image", async () => {
    // The concrete regression. UVK5Radio labels two settings groups with _(),
    // and warns through _() on images with no firmware trailer — so both the
    // load and the settings build raised NameError. get_radio_settings()
    // swallows that into an "unavailable" payload, which is why the failure
    // only ever surfaced in the debug log.
    const image = await harness.runPythonJson(
      `
_meta = base64.b64encode(json.dumps({
    "rclass": "UVK5Radio", "vendor": "Quansheng", "model": "UV-K5",
}).encode())
_img = bytes(0x2000) + chirp_common.CloneModeRadio.MAGIC + _meta
ensure_radio_module("uvk5")
json.dumps({"imageBase64": base64.b64encode(_img).decode("ascii")})
      `,
    );
    const loaded = await harness.runPythonJson("json.dumps(load_image_base64(_image_b64))", {
      _image_b64: image.imageBase64,
    });
    assert.equal(loaded.className, "UVK5Radio");

    const settings = await harness.runPythonJson(
      "json.dumps(get_radio_settings(_sel_module, _sel_class))",
      { _sel_module: "uvk5", _sel_class: "UVK5Radio" },
    );
    assert.equal(settings.error, "", "uvk5 settings failed to build");
    assert.equal(settings.available, true);
    // The FM Radio group is one of the two labelled through _(), so its label
    // is the passthrough's output.
    const fmRadio = (settings.groups || []).find((group) => group.id === "fmradio");
    assert.ok(
      fmRadio,
      `expected an fmradio group, got ${(settings.groups || []).map((g) => g.id)}`,
    );
    assert.equal(fmRadio.label, "FM Radio");
  });
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listDriverModules } from "../web/js/python-sources.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

function parseFlagValue(flagName, argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === flagName && argv[i + 1]) {
      return String(argv[i + 1]);
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1);
    }
  }
  return "";
}

function normalizeRadioLabel(radio) {
  return [
    radio.vendor || "",
    radio.model || "",
    radio.variant || "",
    `(${radio.module}.${radio.className})`,
  ]
    .filter(Boolean)
    .join(" ");
}

test("all registered radios finish initial runtime loading", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const radioFilter = (
    process.env.WEBCHIRP_RADIO_FILTER ||
    parseFlagValue("--radio")
  ).trim().toLowerCase();

  const harness = await createTestRadioHarness({
    repoRoot,
    chirpDir: parseFlagValue("--chirp-dir"),
    serialMode: "stub",
  });

  const moduleNames = await listDriverModules(harness.pythonSource);
  const radios = await harness.runPythonJson(
    "json.dumps(list_registered_radios(_radio_catalog_modules))",
    { _radio_catalog_modules: moduleNames },
  );

  radios.sort((a, b) => {
    const av = `${a.vendor}\u0000${a.model}\u0000${a.variant}\u0000${a.module}\u0000${a.className}`;
    const bv = `${b.vendor}\u0000${b.model}\u0000${b.variant}\u0000${b.module}\u0000${b.className}`;
    return av.localeCompare(bv);
  });

  const selectedRadios = radioFilter
    ? radios.filter((radio) =>
        normalizeRadioLabel(radio).toLowerCase().includes(radioFilter),
      )
    : radios;

  assert.ok(selectedRadios.length > 0, `No radios matched filter: ${radioFilter || "<all>"}`);

  for (const radio of selectedRadios) {
    const label = normalizeRadioLabel(radio);
    await t.test(label, async () => {
      const result = await harness.runPythonJson(
        `
ensure_radio_module(_sel_module)
_meta = get_radio_column_metadata(_sel_module, _sel_class)
_settings = get_radio_settings(_sel_module, _sel_class)
json.dumps({
    "headerCount": len(_meta.get("headers") or []),
    "columnCount": len(_meta.get("columns") or {}),
    "settingsSupported": bool(_settings.get("supported")),
    "settingsAvailable": bool(_settings.get("available")),
    "settingsRequiresImage": bool(_settings.get("requiresImage")),
    "settingsGroupCount": len(_settings.get("groups") or []),
})
        `,
        {
          _sel_module: radio.module,
          _sel_class: radio.className,
        },
      );

      assert.ok(result.headerCount > 0, `${label}: expected metadata headers`);
      assert.ok(result.columnCount > 0, `${label}: expected metadata columns`);
      if (result.settingsAvailable) {
        assert.ok(result.settingsGroupCount > 0, `${label}: settings claimed support but returned no groups`);
      }
      if (result.settingsRequiresImage) {
        assert.equal(result.settingsSupported, false, `${label}: image-gated settings should not be marked supported during initial load`);
      }
    });
  }
});

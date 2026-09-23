import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CHIRP_REVISION,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
} from "../web/js/python-sources.mjs";
import { createTestRadioHarness } from "../tests/support/radio-harness.mjs";

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.cwd();
const OUTPUT_PATH = path.join(REPO_ROOT, "web", "radio-catalog.json");
const QUANSHENG_OUTPUT_PATH = path.join(
  REPO_ROOT,
  "web",
  "radio-catalog-quansheng-unofficial.json",
);
// Deliberately outside web/: the per-model page generator reads this at build
// time and no browser ever fetches it, so keeping it out of the deployed tree
// spares every visitor a file they would never use. The catalog next to it is
// the opposite -- the app downloads that on every load, which is why the
// per-radio capabilities live here instead of being folded into it.
const FEATURES_PATH = path.join(REPO_ROOT, "radio-features.json");

// Match the catalog ordering used by the browser runtime (runtime-rpc.js).
function sortRadioCatalog(radios) {
  return radios.slice().sort((a, b) => {
    const av = `${a.vendor}\u0000${a.model}`;
    const bv = `${b.vendor}\u0000${b.model}`;
    return av.localeCompare(bv);
  });
}

async function resolveChirpRevision(chirpPackageDir) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", chirpPackageDir, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "local";
  }
}

// Import one configured driver collection and return its catalog and failures.
async function buildDriverCatalog(driverSet) {
  const harness = await createTestRadioHarness({ repoRoot: REPO_ROOT, driverSet });
  const modules = await harness.pythonSource.listDriverModules();
  const radios = await harness.runPythonJson(
    "json.dumps(list_registered_radios(_modules))",
    { _modules: modules },
  );

  // list_registered_radios drops unimportable modules silently; surface them
  // here so a driver missing from the catalog is recorded, not inferred. The
  // same sweep backs the runtime's metadata-less image detection.
  const importFailures = (
    await harness.runPythonJson("json.dumps(import_all_driver_modules(_modules))", {
      _modules: modules,
    })
  ).failed;
  for (const name of Object.keys(importFailures).sort()) {
    console.warn(`Driver module not importable, absent from catalog: ${name} (${importFailures[name]})`);
  }

  const sorted = sortRadioCatalog(radios);
  const chirpRevision = await resolveChirpRevision(harness.pythonSource.getRuntimeInfo().chirpPackageDir);
  return { harness, modules, radios: sorted, chirpRevision, importFailures };
}

async function main() {
  const chirpCatalog = await buildDriverCatalog("chirp");

  // The browser runtime rejects a catalog built from any other revision, so a
  // mismatched catalog would silently disable the instant dropdowns.
  if (chirpCatalog.chirpRevision !== DEFAULT_CHIRP_REVISION) {
    throw new Error(
      `CHIRP source is at revision ${chirpCatalog.chirpRevision} but the runtime pin `
      + `(DEFAULT_CHIRP_REVISION in web/js/python-sources.mjs) is ${DEFAULT_CHIRP_REVISION}. `
      + "Check out the pinned revision in chirp/ or update the pin first.",
    );
  }

  const catalog = {
    chirpRevision: chirpCatalog.chirpRevision,
    driverSet: "chirp",
    count: chirpCatalog.radios.length,
    radios: chirpCatalog.radios,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 0)}\n`, "utf8");

  const quanshengCatalog = await buildDriverCatalog(QUANSHENG_UNOFFICIAL_DRIVER_SET);
  await writeFile(
    QUANSHENG_OUTPUT_PATH,
    `${JSON.stringify({
      chirpRevision: quanshengCatalog.chirpRevision,
      driverSet: QUANSHENG_UNOFFICIAL_DRIVER_SET,
      count: quanshengCatalog.radios.length,
      radios: quanshengCatalog.radios,
    }, null, 0)}\n`,
    "utf8",
  );

  // What each catalogued radio can do, read from the driver's own
  // RadioFeatures. Written from the same sweep because the drivers are already
  // imported here; doing it in a second pass would repeat the expensive part.
  const featureSweep = await chirpCatalog.harness.runPythonJson(
    "json.dumps(list_radio_features(_modules))",
    { _modules: chirpCatalog.modules },
  );
  for (const key of Object.keys(featureSweep.failed).sort()) {
    console.warn(`Radio could not describe itself, absent from features: ${key} (${featureSweep.failed[key]})`);
  }
  await writeFile(
    FEATURES_PATH,
    `${JSON.stringify({
      chirpRevision: chirpCatalog.chirpRevision,
      features: featureSweep.features,
    }, null, 0)}\n`,
    "utf8",
  );
  // eslint-disable-next-line no-console
  const failureCount = Object.keys(chirpCatalog.importFailures).length;
  console.log(
    `Wrote ${chirpCatalog.radios.length} radios from ${chirpCatalog.modules.length} driver modules to ${path.relative(REPO_ROOT, OUTPUT_PATH)} (chirp ${chirpCatalog.chirpRevision.slice(0, 12)}${failureCount ? `, ${failureCount} modules unimportable` : ""}).`,
  );
  const quanshengFailureCount = Object.keys(quanshengCatalog.importFailures).length;
  console.log(
    `Wrote ${quanshengCatalog.radios.length} radios from ${quanshengCatalog.modules.length} driver modules to ${path.relative(REPO_ROOT, QUANSHENG_OUTPUT_PATH)}${quanshengFailureCount ? ` (${quanshengFailureCount} modules unimportable)` : ""}.`,
  );
  const described = Object.keys(featureSweep.features).length;
  console.log(
    `Wrote features for ${described} of ${chirpCatalog.radios.length} radios to ${path.relative(REPO_ROOT, FEATURES_PATH)}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

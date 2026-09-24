import { execFile, fork } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHIRP_REVISION,
  QUANSHENG_UNOFFICIAL_DRIVER_SET,
  QUANSHENG_UNOFFICIAL_DRIVERS,
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
async function buildDriverCatalog(driverSet, selectedModules) {
  const harness = await createTestRadioHarness({ repoRoot: REPO_ROOT, driverSet });
  const modules = selectedModules || await harness.pythonSource.listDriverModules();
  const radios = await harness.rpc("list_registered_radios", {
    module_short_names: modules,
  });

  // list_registered_radios drops unimportable modules silently; surface them
  // here so a driver missing from the catalog is recorded, not inferred. The
  // same sweep backs the runtime's metadata-less image detection.
  const importFailures = (
    await harness.rpc("import_all_driver_modules", { module_short_names: modules })
  ).failed;
  for (const name of Object.keys(importFailures).sort()) {
    console.warn(`Driver module not importable, absent from catalog: ${name} (${importFailures[name]})`);
  }

  const sorted = sortRadioCatalog(radios);
  const chirpRevision = await resolveChirpRevision(harness.pythonSource.getRuntimeInfo().chirpPackageDir);
  return { harness, modules, radios: sorted, chirpRevision, importFailures };
}

// Give each release its own Python registry and release its runtime memory on exit.
async function buildIsolatedDriverCatalog(moduleName) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--driver-module", moduleName], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let result;
    child.on("message", (message) => { result = message; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 || !result) {
        reject(new Error(`Catalog generation failed for ${moduleName} (exit ${code})`));
      } else {
        resolve(result);
      }
    });
  });
}

// Keep firmware release labels in the catalog without changing CHIRP identities.
async function buildUnofficialCatalog() {
  const radios = [];
  const importFailures = {};
  const modules = [];
  let chirpRevision;
  for (const driver of QUANSHENG_UNOFFICIAL_DRIVERS) {
    const catalog = await buildIsolatedDriverCatalog(driver.module);
    if (catalog.radios.length === 0 || Object.keys(catalog.importFailures).length) {
      throw new Error(`No complete catalog for bundled driver ${driver.module}`);
    }
    chirpRevision = catalog.chirpRevision;
    modules.push(...catalog.modules);
    Object.assign(importFailures, catalog.importFailures);
    radios.push(...catalog.radios.map((radio) => ({
      ...radio,
      releaseLabel: driver.releases.join(" / "),
    })));
  }
  return { radios: sortRadioCatalog(radios), modules, importFailures, chirpRevision };
}

async function main() {
  if (process.argv[2] === "--driver-module") {
    const moduleName = process.argv[3];
    if (!process.send || !QUANSHENG_UNOFFICIAL_DRIVERS.some((driver) => driver.module === moduleName)) {
      throw new Error("The isolated catalog worker requires a known bundled driver and IPC");
    }
    const { harness: _harness, ...catalog } = await buildDriverCatalog(
      QUANSHENG_UNOFFICIAL_DRIVER_SET,
      [moduleName],
    );
    process.send(catalog);
    process.disconnect();
    return;
  }
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

  const quanshengCatalog = await buildUnofficialCatalog();
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
  const featureSweep = await chirpCatalog.harness.rpc("list_radio_features", {
    module_short_names: chirpCatalog.modules,
  });
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

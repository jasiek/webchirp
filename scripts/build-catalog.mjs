import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CHIRP_REVISION } from "../web/js/python-sources.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.cwd();
const OUTPUT_PATH = path.join(REPO_ROOT, "web", "radio-catalog.json");

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

async function main() {
  const harness = await createTestRadioHarness({ repoRoot: REPO_ROOT });
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

  // The browser runtime rejects a catalog built from any other revision, so a
  // mismatched catalog would silently disable the instant dropdowns.
  if (chirpRevision !== DEFAULT_CHIRP_REVISION) {
    throw new Error(
      `CHIRP source is at revision ${chirpRevision} but the runtime pin `
      + `(DEFAULT_CHIRP_REVISION in web/js/python-sources.mjs) is ${DEFAULT_CHIRP_REVISION}. `
      + "Check out the pinned revision in chirp/ or update the pin first.",
    );
  }

  const catalog = {
    chirpRevision,
    count: sorted.length,
    radios: sorted,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 0)}\n`, "utf8");
  // eslint-disable-next-line no-console
  const failureCount = Object.keys(importFailures).length;
  console.log(
    `Wrote ${sorted.length} radios from ${modules.length} driver modules to ${path.relative(REPO_ROOT, OUTPUT_PATH)} (chirp ${chirpRevision.slice(0, 12)}${failureCount ? `, ${failureCount} modules unimportable` : ""}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

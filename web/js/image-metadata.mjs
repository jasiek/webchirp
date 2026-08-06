// Match parsed CHIRP image metadata against the radio catalog so the correct
// driver module can be imported before image detection runs. CHIRP's
// directory.get_radio_by_image only searches drivers that are already
// imported, so the caller must resolve module names from metadata up front.
//
// The governing constraint: a resolved-but-WRONG match is worse than no match,
// because it suppresses the all-drivers fallback that would have found the
// right driver. So this must be at least as precise as the detection it front-
// runs — which compares VENDOR/MODEL/VARIANT across `rclass.ALIASES + [rclass]`
// (chirp/directory.py) — and must report ambiguity rather than guessing.

function identitiesFor(radio) {
  if (Array.isArray(radio.aliases) && radio.aliases.length > 0) {
    return radio.aliases;
  }
  // Catalogs built before aliases were recorded still match on the class's own
  // identity.
  return [{ vendor: radio.vendor, model: radio.model, variant: radio.variant || "" }];
}

function matchesIdentity(radio, vendor, model, variant) {
  return identitiesFor(radio).some((identity) => {
    if (String(identity.vendor || "") !== vendor || String(identity.model || "") !== model) {
      return false;
    }
    // CHIRP skips the variant comparison when the image records none, but a
    // recorded variant must match exactly — that is what separates
    // uvk5_egzumer.UVK5RadioEgzumer ("egzumer") from the plain uvk5 drivers.
    return variant === null || String(identity.variant || "") === variant;
  });
}

export function findCatalogRadioForImageMetadata(radioCatalog, metadata) {
  if (!metadata?.hasMetadata) {
    return null;
  }
  const catalog = Array.isArray(radioCatalog) ? radioCatalog : [];
  const vendor = String(metadata.vendor || "");
  const model = String(metadata.model || "");
  // null means the trailer records no variant, which CHIRP treats as "any";
  // "" is an explicitly empty variant and must match one.
  const variant =
    metadata.variant === undefined || metadata.variant === null
      ? null
      : String(metadata.variant);

  // The metadata rclass is the concrete driver class name, so it is the most
  // precise selector when the class still exists in the catalog. It often does
  // not: CHIRP stamps the synthetic "DynamicRadioAlias" whenever detection went
  // through an alias, so vendor/model is the common path rather than a rare
  // fallback.
  const rclass = String(metadata.rclass || "");
  if (rclass && vendor && model) {
    // A class name is not unique across modules (TS480Radio exists in both
    // kenwood_live and ts480), and a class can be renamed out from under an
    // image, so a name match only counts when the recorded identity agrees.
    const byClass = catalog.filter(
      (radio) => radio.className === rclass && matchesIdentity(radio, vendor, model, variant),
    );
    if (byClass.length === 1) {
      return byClass[0];
    }
  }

  // Fall back to vendor/model/variant identity, which survives driver class
  // renames and is what CHIRP itself compares.
  if (!vendor || !model) {
    return null;
  }

  const matches = catalog.filter((radio) => matchesIdentity(radio, vendor, model, variant));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    // Several drivers claim this identity (12 vendor/model pairs do, and
    // ('Quansheng','UV-K5') alone has four). Picking one would suppress the
    // sweep that can actually tell them apart, so decline to guess.
    return null;
  }
  return null;
}

// Only a detection failure is worth a retry. `runtime_bridge.ImageDetectionError`
// means no imported driver claimed the image, which importing more drivers can
// fix; every other failure (not a clone-mode image, a bad payload, a driver
// blowing up while reading memories) is about the image itself and would still
// fail after the sweep — so retrying would just cost seconds of CDN fetches in
// the browser before surfacing the same error. Pyodide surfaces the Python
// traceback as the error message, so the class name is the contract; see the
// Python docstring.
export function isImageDetectionFailure(error) {
  return /\bImageDetectionError\b/.test(String(error?.message || error || ""));
}

// Detection after a fast-path resolve, with the driver sweep as a backstop.
// Matching can be wrong in ways the catalog cannot see — a driver whose
// match_model rejects an image its metadata claims, a future CHIRP that records
// something new — and without this retry a wrong match is worse than no match at
// all, because it skips the sweep that would have succeeded.
// `importDriversForDetection` imports driver modules until one claims the image
// (or the list runs out); it is injectable rather than inlined so this can be
// tested without a Pyodide runtime.
export async function loadImageWithDriverFallback({
  resolvedDriver,
  loadImage,
  importDriversForDetection,
  log,
}) {
  if (!resolvedDriver) {
    await importDriversForDetection();
    return loadImage();
  }
  try {
    return await loadImage();
  } catch (error) {
    if (!isImageDetectionFailure(error)) {
      throw error;
    }
    log?.(
      `IMAGE detection failed with ${resolvedDriver.module}.${resolvedDriver.className} `
      + `(${error?.message || error}); retrying against the remaining drivers`,
    );
    await importDriversForDetection();
    return loadImage();
  }
}

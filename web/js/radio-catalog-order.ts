// The one order every radio picker lists the catalog in. The browser runtime
// (web/js/runtime-rpc.ts) sorts with it when it loads a catalog, and the
// catalog build (scripts/build-catalog.ts) writes the committed files in it,
// so neither can drift from the other. No DOM: the build imports it under
// Node's types.

/** The fields of a catalog entry that decide where it is listed. */
export interface CatalogSortFields {
  vendor: string;
  model: string;
  /** The firmware release a bundled unofficial driver was published with. */
  releaseLabel?: string;
}

// Order two catalog entries by vendor, then firmware release, then model.
// Release comes before model because one firmware line renames its model
// between releases ("UV-K5 (egzumer + f4hwn)", "UV-K1 & UV-K5 V3 (F4HWN
// Fusion)", "UV-K1 & UV-K5 V3 (F4HWN)"), so a model-first sort scatters the
// releases out of version order. Releases compare numerically, so v6.10.0
// follows v6.2.0. Vendor and model compare as separate fields because ICU
// collation ignores U+0000: joined with it, "TID" sorted after "TIDRADIO".
export function compareCatalogRadios(a: CatalogSortFields, b: CatalogSortFields): number {
  return a.vendor.localeCompare(b.vendor)
    || (a.releaseLabel ?? "").localeCompare(b.releaseLabel ?? "", undefined, { numeric: true })
    || a.model.localeCompare(b.model);
}

// A copy of the catalog in picker order; the input is left as it was.
export function sortRadioCatalog<T extends CatalogSortFields>(radios: readonly T[]): T[] {
  return radios.slice().sort(compareCatalogRadios);
}

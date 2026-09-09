// Installs the CDN import hook (scripts/test-support/cdn-imports.mjs) into this
// process. Import this module before dynamically importing anything that pulls
// a https: specifier; a static import of such a module is resolved before any
// top-level code runs, so the dependent import has to be dynamic.
import { register } from "node:module";

register("./cdn-imports.mjs", import.meta.url);

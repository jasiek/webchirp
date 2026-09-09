// Shared filesystem anchors for the node:test suite. Derived from this file's
// own location rather than process.cwd() so every test resolves the same paths
// no matter which directory npm test is invoked from.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const webDir = path.join(repoRoot, "web");
export const jsDir = path.join(webDir, "js");
export const chirpImagesDir = path.join(repoRoot, "chirp", "tests", "images");

// Every static page the app ships; tests that check per-page markup loop over this.
export const htmlPages = ["index.html", "about.html"];

// Runs the real scripts/build-dist.ts against a throwaway web/ tree, for the
// build suite's tests of what dist/ ends up holding. Shared so a test that
// builds one real page does not have to restate the files the build refuses
// to run without.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "./repo-paths.mjs";
import {
  CHIRP_BUNDLE_DIR,
  chirpBundleFileNames,
  DEFAULT_CHIRP_REVISION,
} from "../../web/js/python-sources.ts";

export const BUILD_DIST_SCRIPT = path.join(repoRoot, "scripts", "build-dist.ts");

// The CHIRP archive and manifest for the pinned revision, as dist-relative
// paths. build-dist.mjs requires them and lists them in the asset manifest.
export const CHIRP_BUNDLE_FILES = Object.values(chirpBundleFileNames(DEFAULT_CHIRP_REVISION))
  .map((name) => `${CHIRP_BUNDLE_DIR}/${name}`);

// The files build-dist.mjs refuses to build without -- the install assets, the
// CHIRP archive, the service worker and what it caches for offline use --
// whose contents are never read, only their presence (and the offline files'
// digests).
export const REQUIRED_FILES = {
  "sw.ts": "self.addEventListener(\"fetch\", () => {});\n",
  "radio-catalog.json": "{}\n",
  "radio-catalog-quansheng-unofficial.json": "{}\n",
  "version.json": "{}\n",
  "favicon.ico": "",
  "manifest.webmanifest": "{}\n",
  "images/icon-192.png": "",
  "images/icon-512.png": "",
  "images/icon-maskable-512.png": "",
  "images/apple-touch-icon.png": "",
  "images/screenshot-narrow.png": "",
  "images/screenshot-wide.png": "",
  ".well-known/assetlinks.json": "[]\n",
  ...Object.fromEntries(CHIRP_BUNDLE_FILES.map((rel) => [rel, "not a real archive\n"])),
};

// Write each relative path's content under root, creating directories.
export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

// Run the real build against a throwaway repo, surfacing its output on failure
// — a build that dies silently would otherwise look like an empty dist/.
export function runBuild(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BUILD_DIST_SCRIPT], { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`build-dist failed: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

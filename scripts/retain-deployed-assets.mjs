// Copy the currently-deployed generation of content-hashed assets into a
// freshly built dist/. GitHub Pages serves everything with a fixed
// `Cache-Control: max-age=600` and no header control, so for up to 10 minutes
// after a deploy a cached index.html can still reference the previous build's
// hashed asset names; without retention those names 404 and the app breaks
// until the cache expires. Hashed names are immutable (name == content), so
// carrying the old files forward is always safe.
//
// Usage: node scripts/retain-deployed-assets.mjs [deployed-site-base-url]
// Run in CI after `npm run build:dist`, before uploading the Pages artifact.
// With no argument the host comes from ./CNAME, which is what Pages actually
// serves the site as — passing it separately let the two drift for a week when
// the CNAME changed (see FINDINGS.md, pages-deploy-and-cache-window).
//
// A site that serves fine but has no asset-manifest.json is a genuine first
// deploy: warn and exit 0. A host that does not answer at all is a
// misconfiguration and exits non-zero, because silently retaining nothing
// looks identical to a successful run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DIST_DIR = path.join(process.cwd(), "dist");
const CNAME_FILE = path.join(process.cwd(), "CNAME");
const RETAINED_LIST = "retained-assets.json";
// Keep prior generations well past the 10-minute Pages cache window; cheap
// insurance for edge caches and long-lived tabs that lazy-load modules.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A hashed asset looks like name.<10 hex chars>.ext (see build-dist.mjs).
const HASHED_NAME_RE = /\.([0-9a-f]{10})\.[a-z]+$/;

function normalizeAssetPath(ref) {
  // Manifest values appear as both "./js/ui.<hash>.js" and "/js/ui.<hash>.js".
  return ref.replace(/^\.?\//, "");
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

// Does the host serve anything at all? Separates "first deploy" from "wrong
// hostname", which produce the same missing manifest.
async function siteIsReachable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/`, { redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveBaseUrl() {
  const explicit = (process.argv[2] || "").replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }
  if (!existsSync(CNAME_FILE)) {
    throw new Error(
      "No CNAME file and no base URL argument; pass the deployed site URL explicitly.",
    );
  }
  const host = (await readFile(CNAME_FILE, "utf8")).trim();
  if (!host) {
    throw new Error("CNAME is empty; pass the deployed site URL explicitly.");
  }
  return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

async function main() {
  const baseUrl = await resolveBaseUrl();
  if (!existsSync(DIST_DIR)) {
    throw new Error("dist/ not found; run `npm run build:dist` first.");
  }
  console.log(`Retaining assets from ${baseUrl}`);

  const manifest = await fetchJson(`${baseUrl}/asset-manifest.json`);
  if (!manifest?.assets) {
    if (!(await siteIsReachable(baseUrl))) {
      throw new Error(
        `${baseUrl} does not serve a site — retention would silently do nothing. ` +
          "Check that the host matches CNAME and that Pages is serving it.",
      );
    }
    console.warn(`No deployed asset manifest at ${baseUrl}; nothing to retain (first deploy?).`);
    return;
  }
  // The deployed site's own retained list chains retention across deploys that
  // land closer together than the cache window.
  const previousRetained = (await fetchJson(`${baseUrl}/${RETAINED_LIST}`)) || {};

  const now = Date.now();
  const candidates = new Map(); // asset path -> firstSeen ISO timestamp
  for (const ref of Object.values(manifest.assets)) {
    candidates.set(normalizeAssetPath(ref), new Date(now).toISOString());
  }
  for (const [assetPath, firstSeen] of Object.entries(previousRetained)) {
    const age = now - Date.parse(firstSeen);
    if (Number.isFinite(age) && age <= MAX_AGE_MS) {
      candidates.set(assetPath, firstSeen);
    }
  }

  const retained = {};
  for (const [assetPath, firstSeen] of candidates) {
    const hashMatch = path.basename(assetPath).match(HASHED_NAME_RE);
    if (!hashMatch) {
      continue; // only content-hashed files are safe to carry forward
    }
    const target = path.join(DIST_DIR, assetPath);
    if (!path.resolve(target).startsWith(path.resolve(DIST_DIR) + path.sep)) {
      continue; // ignore traversal attempts from a hostile manifest
    }
    if (existsSync(target)) {
      continue; // current build already provides this exact content
    }
    const res = await fetch(`${baseUrl}/${assetPath}`, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`Skipping ${assetPath}: deployed site returned ${res.status}`);
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    // Note: the filename hash cannot be re-verified against the content —
    // build-dist.mjs hashes files BEFORE rewriting asset references inside
    // them, so the served bytes intentionally differ from the name's digest.
    // The res.ok check above is the integrity gate; Pages returns real 404s
    // (no SPA fallback), so a miss can't smuggle an error page in here.
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    retained[assetPath] = firstSeen;
    console.log(`Retained ${assetPath}`);
  }

  await writeFile(
    path.join(DIST_DIR, RETAINED_LIST),
    `${JSON.stringify(retained, null, 2)}\n`,
    "utf8",
  );
  console.log(`Retained ${Object.keys(retained).length} previous-generation asset(s).`);
}

await main();

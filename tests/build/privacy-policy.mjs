// Guards the privacy policy (web/privacy.html) that Google Play requires of the
// Android app. Two things can quietly break it: the app can start sending
// something the policy does not mention, and the policy can stop being
// reachable from inside the app. Neither shows in a browser, and either one is
// a store-policy violation, so both are asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { JSDOM } from "jsdom";

import { moduleGraph, REQUIRED_FILES, runBuild, writeTree } from "../support/dist-build.mjs";
import { repoRoot, webDir } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";
import { CUSTOM_DIMENSIONS } from "../../web/js/analytics.ts";
import { PYODIDE_INDEX_URL } from "../../web/js/cdn-urls.ts";
import { RSGB_API_BASE } from "../../web/js/rsgb.ts";
import { OSM_TILE_URL_TEMPLATE } from "../../web/js/staticmap.ts";
import { TURNSTILE_SCRIPT_URL } from "../../web/js/turnstile.ts";

const POLICY = "privacy.html";

function readPage(name) {
  return readFile(path.join(webDir, name), "utf8");
}

// Whether el or any ancestor is hidden by attribute, which is how this app
// hides markup until it is needed.
function hiddenByAttribute(el) {
  for (let node = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) {
      return true;
    }
  }
  return false;
}

test("the policy is labelled a privacy policy", async () => {
  // Google Play rejects a policy that is not labelled as one.
  const { document } = new JSDOM(await readPage(POLICY)).window;
  assert.equal(document.querySelector("h1")?.textContent, "Privacy Policy");
  assert.match(document.title, /^Privacy Policy\b/);
});

test("the policy names every analytics parameter the app sends", async () => {
  // CUSTOM_DIMENSIONS is where every parameter must be declared before GA will
  // report it, so a parameter added there and not here is one the policy hides.
  const html = await readPage(POLICY);
  for (const { parameterName } of CUSTOM_DIMENSIONS) {
    assert.ok(
      html.includes(`<code>${parameterName}</code>`),
      `${POLICY} does not list the analytics parameter ${parameterName}`,
    );
  }
});

test("the policy names every host a position, a bot check or a download goes to", async () => {
  const html = await readPage(POLICY);
  const index = new JSDOM(await readPage("index.html")).window.document;
  const repeaterApi = index.querySelector('meta[name="webchirp-repeater-api-base"]')?.getAttribute("content");
  assert.ok(repeaterApi, "index.html names the repeater API it queries");
  const hosts = [
    repeaterApi,
    RSGB_API_BASE,
    OSM_TILE_URL_TEMPLATE.replace(/\{.\}/g, "0"),
    TURNSTILE_SCRIPT_URL,
    PYODIDE_INDEX_URL,
  ]
    .map((url) => new URL(url).host);
  for (const host of hosts) {
    assert.ok(html.includes(`<code>${host}</code>`), `${POLICY} does not name ${host}`);
  }
});

test("the policy names every host the site is deployed to", async () => {
  // Every page request goes to the host, so a deploy job added to pages.yml is
  // a new destination for every visitor, not only for one feature's users.
  const html = await readPage(POLICY);
  const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "pages.yml"), "utf8");
  // Matched on the action a deploy step uses, which is what every step has to
  // name, rather than on its arguments.
  const hosts = [
    [/uses:\s*actions\/deploy-pages@/, "GitHub Pages"],
    [/uses:\s*cloudflare\/wrangler-action@/, "Cloudflare Pages"],
  ];
  assert.ok(hosts.some(([step]) => step.test(workflow)), "pages.yml deploys to a host this test knows");
  for (const [step, host] of hosts) {
    if (step.test(workflow)) {
      assert.ok(html.includes(host), `pages.yml deploys to ${host}, which ${POLICY} does not name`);
    }
  }
});

test("the policy names the hosts the edge-injected page-view beacon talks to", async () => {
  // Cloudflare injects this script into every page at the edge (webchirp-hosting's
  // analytics.tf), so nothing in this repository names these hosts for the test
  // above to read.
  const html = await readPage(POLICY);
  for (const host of ["static.cloudflareinsights.com", "cloudflareinsights.com"]) {
    assert.ok(html.includes(`<code>${host}</code>`), `${POLICY} does not name ${host}`);
  }
});

test("the app and the about page link to the policy where it can be seen", async () => {
  for (const page of ["index.html", "about.html"]) {
    const { document } = new JSDOM(await readPage(page)).window;
    const links = [...document.querySelectorAll(`a[href="./${POLICY}"]`)];
    assert.ok(links.length > 0, `${page} has no link to ${POLICY}`);
    // Google Play wants the link visible during normal use, not behind a
    // disclosure the user has to find first.
    assert.ok(
      links.some((link) => !hiddenByAttribute(link)),
      `${page} links to ${POLICY} only from hidden markup`,
    );
  }
});

test("a built site serves the policy and caches it for offline use", async () => {
  // The real page and everything it loads, built by the real script: a build
  // that dropped or renamed the page would leave the URL entered in Play
  // Console answering 404.
  const files = {};
  for (const rel of [POLICY, "about.html", "styles.css", ...(await moduleGraph(webDir, "js/analytics.ts"))]) {
    files[rel] = await readPage(rel);
  }
  await withTempDir("privacy-dist-", async (dir) => {
    await writeTree(path.join(dir, "web"), { ...REQUIRED_FILES, ...files });
    await runBuild(dir);
    const dist = path.join(dir, "dist");

    const built = new JSDOM(await readFile(path.join(dist, POLICY), "utf8")).window.document;
    assert.equal(built.querySelector("h1")?.textContent, "Privacy Policy");
    const script = built.querySelector('script[type="module"]')?.getAttribute("src") ?? "";
    assert.match(script, /^\.\/js\/analytics\.[A-Z2-7]{8}\.js$/, "the page loads the bundled analytics module");

    const about = await readFile(path.join(dist, "about.html"), "utf8");
    assert.ok(about.includes(`href="./${POLICY}"`), "the built about page links to the policy");

    const manifest = JSON.parse(await readFile(path.join(dist, "asset-manifest.json"), "utf8"));
    assert.ok(POLICY in manifest.offline.files, "the service worker caches the policy with the build");
  });
});

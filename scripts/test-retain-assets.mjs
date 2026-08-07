// Guards the two ways asset retention has silently stopped working:
// a deployed hostname that drifted away from CNAME, and an unreachable host
// being treated the same as a first deploy. Both cost the live site its
// post-deploy cache window for a week before anyone noticed, because the
// script exited 0 either way (see FINDINGS.md, pages-deploy-and-cache-window).
//
// Everything here drives the real script as a child process, so what is under
// test is exactly what CI runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";

const SCRIPT = path.join(import.meta.dirname, "retain-deployed-assets.mjs");
const REPO_ROOT = path.join(import.meta.dirname, "..");

// The script resolves CNAME and dist/ relative to its cwd, so each case gets a
// throwaway repo rather than running against the real tree.
async function withTempRepo(cname) {
  const dir = await mkdtemp(path.join(tmpdir(), "retain-assets-"));
  if (cname) {
    await writeFile(path.join(dir, "CNAME"), `${cname}\n`, "utf8");
  }
  await mkdir(path.join(dir, "dist"), { recursive: true });
  return dir;
}

// Serves a fixed route table; every other path 404s, like Pages (no SPA
// fallback).
async function withSite(routes) {
  const server = createServer((req, res) => {
    const body = routes[req.url.split("?")[0]];
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Must not be spawnSync: the site under test is served from this process, so
// blocking the event loop on the child would deadlock it.
function run(cwd, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("the deployed base URL comes from CNAME, not a hardcoded host", async () => {
  const dir = await withTempRepo("example.test");
  try {
    // Asserted on the log line, which the script prints before it fetches
    // anything, so this holds regardless of what the network does with a
    // reserved .test name.
    const result = await run(dir);
    assert.match(result.stdout, /Retaining assets from https:\/\/example\.test\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the workflow passes no host, so CNAME stays the single source", async () => {
  // A URL argument overrides CNAME. If one ever reappears in pages.yml the two
  // can drift apart again silently, which is precisely how retention broke.
  const workflow = await readFile(path.join(REPO_ROOT, ".github/workflows/pages.yml"), "utf8");
  const invocation = workflow
    .split("\n")
    .find((line) => line.includes("retain-deployed-assets.mjs"));
  assert.ok(invocation, "pages.yml must still run the retention step");
  assert.match(
    invocation.trim(),
    /^- run: node scripts\/retain-deployed-assets\.mjs$/,
    "the retention step must take its host from CNAME, not an inline URL",
  );

  const cname = (await readFile(path.join(REPO_ROOT, "CNAME"), "utf8")).trim();
  assert.ok(cname, "CNAME must name the deployed host for the step above to resolve one");
});

test("a host that serves nothing fails the build instead of warning", async () => {
  // The real regression: webchirp.jasiek.me kept 404ing after the rename and
  // every deploy still exited 0, retaining nothing.
  const site = await withSite({});
  const dir = await withTempRepo("unused.test");
  try {
    const result = await run(dir, [site.url]);
    assert.notEqual(result.status, 0, "must exit non-zero");
    assert.match(result.stderr, /does not serve a site/);
    assert.match(result.stderr, /CNAME/);
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live site with no manifest yet still exits 0", async () => {
  const site = await withSite({ "/": "{}" });
  const dir = await withTempRepo("unused.test");
  try {
    const result = await run(dir, [site.url]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr + result.stdout, /nothing to retain/);
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live site with a manifest writes the retained list", async () => {
  const site = await withSite({
    "/": "{}",
    "/asset-manifest.json": JSON.stringify({ assets: { "js/ui.js": "./js/ui.0123456789.js" } }),
    "/js/ui.0123456789.js": "export const x = 1;",
  });
  const dir = await withTempRepo("unused.test");
  try {
    const result = await run(dir, [site.url]);
    assert.equal(result.status, 0, result.stderr);
    const retained = JSON.parse(
      await readFile(path.join(dir, "dist", "retained-assets.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(retained), ["js/ui.0123456789.js"]);
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("no CNAME and no argument is an error, not a silent skip", async () => {
  const dir = await withTempRepo(null);
  try {
    const result = await run(dir);
    assert.notEqual(result.status, 0, "must exit non-zero");
    assert.match(result.stderr, /No CNAME file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

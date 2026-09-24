// Guards the two ways asset retention has silently stopped working:
// a deployed hostname that drifted away from CNAME, and an unreachable host
// being treated the same as a first deploy. Both cost the live site its
// post-deploy cache window for a week before anyone noticed, because the
// script exited 0 either way (see FINDINGS.md, pages-deploy-and-cache-window).
// A third case fails identically but for a benign reason -- a CNAME moved to a
// domain Pages has not been told about -- so what is pinned there is the
// message, which is all that tells the two apart.
//
// Everything here drives the real script as a child process, so what is under
// test is exactly what CI runs.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";

import { repoRoot } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const SCRIPT = path.join(repoRoot, "scripts", "retain-deployed-assets.mjs");

// The script resolves CNAME and dist/ relative to its cwd, so each case gets a
// throwaway repo rather than running against the real tree. Runs fn with the
// repo's path and removes it afterwards.
function withTempRepo(cname, fn) {
  return withTempDir("retain-assets-", async (dir) => {
    if (cname) {
      await writeFile(path.join(dir, "CNAME"), `${cname}\n`, "utf8");
    }
    await mkdir(path.join(dir, "dist"), { recursive: true });
    return fn(dir);
  });
}

// Serves a fixed route table to fn; every other path 404s, like Pages (no SPA
// fallback). The server is closed once fn settles, however it settles.
async function withSite(routes, fn) {
  const server = createServer((req, res) => {
    const body = routes[req.url.split("?")[0]];
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
  await withTempRepo("example.test", async (dir) => {
    // Asserted on the log line, which the script prints before it fetches
    // anything, so this holds regardless of what the network does with a
    // reserved .test name.
    const result = await run(dir);
    assert.match(result.stdout, /Retaining assets from https:\/\/example\.test\b/);
  });
});

test("the workflow passes no host, so CNAME stays the single source", async () => {
  // A URL argument overrides CNAME. If one ever reappears in pages.yml the two
  // can drift apart again silently, which is precisely how retention broke.
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8");
  const invocation = workflow
    .split("\n")
    .find((line) => line.includes("retain-deployed-assets.mjs"));
  assert.ok(invocation, "pages.yml must still run the retention step");
  assert.match(
    invocation.trim(),
    /^- run: node scripts\/retain-deployed-assets\.mjs$/,
    "the retention step must take its host from CNAME, not an inline URL",
  );

  const cname = (await readFile(path.join(repoRoot, "CNAME"), "utf8")).trim();
  assert.ok(cname, "CNAME must name the deployed host for the step above to resolve one");
});

test("a host that serves nothing fails the build instead of warning", async () => {
  // The real regression: webchirp.jasiek.me kept 404ing after the rename and
  // every deploy still exited 0, retaining nothing.
  await withSite({}, (url) => withTempRepo("unused.test", async (dir) => {
    const result = await run(dir, [url]);
    assert.notEqual(result.status, 0, "must exit non-zero");
    assert.match(result.stderr, /does not serve a site/);
    assert.match(result.stderr, /CNAME/);
  }));
});

test("the unreachable-host failure explains the domain-move ordering", async () => {
  // A CNAME pointed at a domain Pages has not been told about yet fails here
  // exactly like a drifted hostname, and cannot be told apart from one. The
  // message is the only thing that separates them for whoever reads the log,
  // so it has to carry the order that works rather than just the symptom.
  await withSite({}, (url) => withTempRepo("unused.test", async (dir) => {
    const result = await run(dir, [url]);
    assert.notEqual(result.status, 0, "must exit non-zero");
    assert.match(
      result.stderr,
      /pointed at a new domain/,
      "the failure must name the domain-move case, not only a wrong hostname",
    );
    assert.match(
      result.stderr,
      /Pages only learns a new domain from a deploy/,
      "the failure must say why landing the CNAME change first cannot work",
    );
  }));
});

test("a live site with no manifest yet still exits 0", async () => {
  await withSite({ "/": "{}" }, (url) => withTempRepo("unused.test", async (dir) => {
    const result = await run(dir, [url]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr + result.stdout, /nothing to retain/);
  }));
});

test("a live site with a manifest writes the retained list", async () => {
  const routes = {
    "/": "{}",
    "/asset-manifest.json": JSON.stringify({ assets: { "js/ui.js": "./js/ui.0123456789.js" } }),
    "/js/ui.0123456789.js": "export const x = 1;",
  };
  await withSite(routes, (url) => withTempRepo("unused.test", async (dir) => {
    const result = await run(dir, [url]);
    assert.equal(result.status, 0, result.stderr);
    const retained = JSON.parse(
      await readFile(path.join(dir, "dist", "retained-assets.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(retained), ["js/ui.0123456789.js"]);
  }));
});

// The previous deploy's CHIRP archive is named by its submodule pin rather
// than a content digest (scripts/build-chirp-bundle.mjs). A cached page from
// that deploy boots from it, so it has to be carried forward like a hashed
// asset -- while a plain, mutable name in the same directory still must not.
test("the previous pin's CHIRP archive and manifest are retained", async () => {
  const oldPin = "a".repeat(40);
  const routes = {
    "/": "{}",
    "/asset-manifest.json": JSON.stringify({
      assets: {
        [`./chirp/chirp-${oldPin}.zip`]: `./chirp/chirp-${oldPin}.zip`,
        [`/chirp/chirp-${oldPin}.json`]: `/chirp/chirp-${oldPin}.json`,
        "./chirp/latest.zip": "./chirp/latest.zip",
      },
    }),
    [`/chirp/chirp-${oldPin}.zip`]: "PK old archive",
    [`/chirp/chirp-${oldPin}.json`]: "{}",
    "/chirp/latest.zip": "PK mutable",
  };
  await withSite(routes, (url) => withTempRepo("unused.test", async (dir) => {
    const result = await run(dir, [url]);
    assert.equal(result.status, 0, result.stderr);
    const retained = JSON.parse(
      await readFile(path.join(dir, "dist", "retained-assets.json"), "utf8"),
    );
    assert.deepEqual(
      Object.keys(retained).sort(),
      [`chirp/chirp-${oldPin}.json`, `chirp/chirp-${oldPin}.zip`],
    );
    assert.equal(
      await readFile(path.join(dir, "dist", "chirp", `chirp-${oldPin}.zip`), "utf8"),
      "PK old archive",
    );
  }));
});

test("no CNAME and no argument is an error, not a silent skip", async () => {
  await withTempRepo(null, async (dir) => {
    const result = await run(dir);
    assert.notEqual(result.status, 0, "must exit non-zero");
    assert.match(result.stderr, /No CNAME file/);
  });
});

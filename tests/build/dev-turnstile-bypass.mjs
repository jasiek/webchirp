// npm run dev with TURNSTILE_BYPASS_TOKEN set stands between the page and the
// repeater API (scripts/dev-turnstile-bypass.ts): the page's API base names the
// dev server, which forwards each request and adds the token to RepeaterBook's,
// so RepeaterBook queries against the production API get past its Turnstile
// check without the token ever being served to the page.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import { delay, findFreePort } from "../../scripts/app-driver.ts";
import {
  DEV_API_PROXY_PATH,
  pointApiBaseAtProxy,
  proxiedApiRoute,
  readApiBase,
  readTurnstileBypassToken,
} from "../../scripts/dev-turnstile-bypass.ts";
import { repoRoot } from "../support/repo-paths.mjs";
import { withTempDir } from "../support/temp-dir.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const API_BASE_TAG = (base) => `<meta name="webchirp-repeater-api-base" content="${base}" />`;

test("an unset or blank TURNSTILE_BYPASS_TOKEN reads as no token", () => {
  assert.equal(readTurnstileBypassToken({}), "");
  assert.equal(readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: "  " }), "");
});

test("a 32-character Bearer token is read as it is", () => {
  assert.equal(readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: TOKEN }), TOKEN);
  assert.equal(readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: ` ${TOKEN}\n` }), TOKEN);
});

test("a token the API would refuse fails the dev server at startup", () => {
  // The API requires exactly 32 characters.
  assert.throws(() => readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: "short" }), /must be 32 characters, got 5/);
  assert.throws(() => readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: `${TOKEN}0` }), /got 33/);
  // Right length, but not something a Bearer credential can carry.
  assert.throws(() => readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: `"><script>${"x".repeat(22)}` }), /not a Bearer token/);
});

test("index.html's API base is pointed at the proxy, and nothing else on the page changes", () => {
  const page = readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
  const apiBase = readApiBase(page);
  assert.equal(apiBase, "https://api.webchirp.org");
  const origin = "http://127.0.0.1:8000";
  assert.equal(
    pointApiBaseAtProxy(page, origin),
    page.replace(API_BASE_TAG(apiBase), API_BASE_TAG(`${origin}${DEV_API_PROXY_PATH}`)),
  );
});

test("a page without the tag is served unchanged", () => {
  const page = '<!doctype html>\n<meta name="description" content="" />\n';
  assert.equal(readApiBase(page), "");
  assert.equal(pointApiBaseAtProxy(page, "http://127.0.0.1:8000"), page);
});

test("only requests under the proxy path are forwarded, with their route and query", () => {
  assert.equal(proxiedApiRoute(`${DEV_API_PROXY_PATH}/repeaterbook?country=gb`), "/repeaterbook?country=gb");
  assert.equal(proxiedApiRoute(`${DEV_API_PROXY_PATH}/cities`), "/cities");
  assert.equal(proxiedApiRoute("/index.html"), null);
  // A file that merely starts with the same letters is still a file.
  assert.equal(proxiedApiRoute(`${DEV_API_PROXY_PATH}-notes.txt`), null);
});

// Serves one request handler on a free port for the duration of fn.
async function withServer(handler, fn) {
  const server = createServer(handler);
  const port = await findFreePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Runs scripts/dev-server.ts on webRoot with env for the duration of fn,
// handing fn the address it answers at.
async function withDevServer(webRoot, env, fn) {
  const port = await findFreePort();
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "dev-server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, ...env, WEB_ROOT: webRoot, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; ; attempt++) {
      assert.equal(child.exitCode, null, `the dev server exited: ${stderr}`);
      try {
        await fetch(origin, { method: "HEAD" });
        break;
      } catch {
        assert.ok(attempt < 100, "the dev server did not start");
        await delay(100);
      }
    }
    return await fn(origin);
  } finally {
    child.kill();
  }
}

test("the dev server forwards API requests and adds the token only to RepeaterBook's", async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ route: req.url }));
  }, async (apiOrigin) => {
    // Mounted below a path, as a fork's own proxy may be: the token goes by
    // the route the page asked for, not the path the API ends up at.
    const apiBase = `${apiOrigin}/api`;
    await withTempDir("dev-api-proxy-", async (webRoot) => {
      await writeFile(path.join(webRoot, "index.html"), `<!doctype html>\n${API_BASE_TAG(apiBase)}\n`);
      await withDevServer(webRoot, { TURNSTILE_BYPASS_TOKEN: TOKEN }, async (origin) => {
        const page = await (await fetch(`${origin}/`)).text();
        assert.ok(page.includes(API_BASE_TAG(`${origin}${DEV_API_PROXY_PATH}`)), page);
        assert.ok(!page.includes(TOKEN), "the token is never served to the page");

        const answer = await fetch(`${origin}${DEV_API_PROXY_PATH}/repeaterbook?country=gb`);
        assert.equal(answer.status, 200);
        assert.match(answer.headers.get("content-type"), /application\/json/);
        assert.deepEqual(await answer.json(), { route: "/api/repeaterbook?country=gb" });
        await fetch(`${origin}${DEV_API_PROXY_PATH}/przemienniki?country=pl`);
      });
    });
  });
  assert.deepEqual(seen, [
    { url: "/api/repeaterbook?country=gb", authorization: `Bearer ${TOKEN}` },
    { url: "/api/przemienniki?country=pl", authorization: undefined },
  ]);
});

test("without the token the dev server serves the page's own API base and forwards nothing", async () => {
  await withTempDir("dev-api-proxy-", async (webRoot) => {
    const page = `<!doctype html>\n${API_BASE_TAG("https://api.example.org")}\n`;
    await writeFile(path.join(webRoot, "index.html"), page);
    await withDevServer(webRoot, { TURNSTILE_BYPASS_TOKEN: "" }, async (origin) => {
      assert.equal(await (await fetch(`${origin}/`)).text(), page);
      assert.equal((await fetch(`${origin}${DEV_API_PROXY_PATH}/repeaterbook`)).status, 404);
    });
  });
});

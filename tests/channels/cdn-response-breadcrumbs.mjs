import test from "node:test";
import assert from "node:assert/strict";
import { installCdnResponseBreadcrumbs } from "../../web/js/cdn-response-breadcrumbs.mjs";

test("delivery breadcrumbs preserve responses and only log selected headers without queries", async () => {
  const response = new Response("asset", { status: 503, headers: {
    "server": "cloudflare", "cf-ray": "test-WAW",
    "x-served-by": "cache-vie-VIE", "x-github-edge-region": "fra",
    "set-cookie": "private", "authorization": "private",
  } });
  const crumbs = [];
  let received;
  const win = { location: { origin: "https://webchirp.org" }, fetch(...args) {
    assert.equal(this, win);
    received = args;
    return Promise.resolve(response);
  } };
  const restore = installCdnResponseBreadcrumbs(win, (crumb) => crumbs.push(crumb));
  const request = new Request("https://webchirp.org/python/bridge.py?private=secret");
  const options = { cache: "reload" };
  assert.equal(await win.fetch(request, options), response);
  assert.deepEqual(received, [request, options]);
  assert.deepEqual(crumbs[0].data, {
    url: "https://webchirp.org/python/bridge.py", status_code: 503,
    server: "cloudflare", "cf-ray": "test-WAW",
    "x-served-by": "cache-vie-VIE", "x-github-edge-region": "fra",
  });
  assert.equal(await response.text(), "asset");
  await win.fetch("https://other.example/python/bridge.py");
  await win.fetch("https://webchirp.org/api/search?name=private");
  assert.equal(crumbs.length, 1);
  await win.fetch(new URL("https://cdn.jsdelivr.net/pyodide/v0.27.2/full/python_stdlib.zip"));
  assert.equal(crumbs.length, 2);
  await win.fetch("/radio-catalog-quansheng-unofficial.json");
  assert.equal(crumbs.length, 3);
  restore();
});

test("failed fetch keeps its rejection and telemetry failure keeps a readable response", async () => {
  const error = new TypeError("Failed to fetch");
  const win = { location: { origin: "https://webchirp.org" }, fetch: () => Promise.reject(error) };
  let crumbs = 0;
  const restore = installCdnResponseBreadcrumbs(win, () => { crumbs += 1; });
  await assert.rejects(win.fetch("/chirp/archive.zip"), (reason) => reason === error);
  assert.equal(crumbs, 0);
  restore();
  const response = new Response("ok");
  win.fetch = () => Promise.resolve(response);
  installCdnResponseBreadcrumbs(win, () => { throw new Error("telemetry failed"); });
  assert.equal(await win.fetch("/chirp/archive.zip"), response);
});

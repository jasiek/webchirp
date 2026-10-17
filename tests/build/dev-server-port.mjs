// npm run dev in a linked worktree must not take master's port 8000, and must
// come back on the same port each time; scripts/dev-server-port.ts decides
// that from whether the checkout's .git is a directory or a file.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { defaultDevServerPort, isLinkedWorktree, MAIN_CHECKOUT_PORT } from "../../scripts/dev-server-port.ts";
import { withTempDir } from "../support/temp-dir.mjs";

test("the main checkout keeps port 8000", async () => {
  await withTempDir("dev-port-", async (dir) => {
    mkdirSync(path.join(dir, ".git"));
    assert.equal(isLinkedWorktree(dir), false);
    assert.equal(defaultDevServerPort(dir), MAIN_CHECKOUT_PORT);
  });
});

test("a directory that is no checkout at all keeps port 8000", async () => {
  await withTempDir("dev-port-", async (dir) => {
    assert.equal(defaultDevServerPort(dir), MAIN_CHECKOUT_PORT);
  });
});

test("a linked worktree gets a stable port of its own, never 8000", async () => {
  await withTempDir("dev-port-", async (parent) => {
    const ports = ["webchirp-feature-a", "webchirp-feature-b", "fix"].map((name) => {
      const dir = path.join(parent, name);
      mkdirSync(dir);
      writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      assert.equal(isLinkedWorktree(dir), true);
      const port = defaultDevServerPort(dir);
      assert.equal(defaultDevServerPort(dir), port, "the same worktree must get the same port");
      assert.ok(port > 8000 && port < 9000, `port ${port} is outside 8001..8999`);
      return port;
    });
    assert.equal(new Set(ports).size, ports.length, `expected distinct ports, got ${ports.join(", ")}`);
  });
});

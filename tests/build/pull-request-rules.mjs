// The pull-request rules scripts/check-pull-request.ts enforces in CI: no
// RELEASE_NOTES.md edit on a branch, no agent session link in a commit
// message, and every new dependency named in the description. The checks are
// driven here directly; the last test runs the whole range check against a
// throwaway repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  addedDependencies,
  checkPullRequest,
  dependencyFindings,
  releaseNotesFindings,
  sessionLinkFindings,
} from "../../scripts/check-pull-request.ts";
import { withTempDir } from "../support/temp-dir.mjs";

test("a branch may not touch RELEASE_NOTES.md", () => {
  assert.deepEqual(releaseNotesFindings(["web/app.ts", "README.md"]), []);
  assert.equal(releaseNotesFindings(["RELEASE_NOTES.md"]).length, 1);
});

test("a commit message may not link an agent session", () => {
  assert.deepEqual(sessionLinkFindings([{ sha: "a".repeat(40), message: "Fix the grid\n\nSee https://github.com/x/y/pull/1" }]), []);
  const found = sessionLinkFindings([
    { sha: "b".repeat(40), message: "Fix\n\nhttps://claude.ai/code/session_01ABC" },
    { sha: "c".repeat(40), message: "Fix\n\nhttps://chatgpt.com/codex/tasks/task_e_1" },
  ]);
  assert.equal(found.length, 2);
  assert.match(found[0], /^commit bbbbbbbbbb links an agent session \(https:\/\/claude\.ai\/code\/session_01ABC\)/);
});

test("added dependencies of either kind are found, and kept ones are not", () => {
  const base = { dependencies: { pyodide: "1" }, devDependencies: { jsdom: "1" } };
  const head = { dependencies: { pyodide: "2", zod: "1" }, devDependencies: { jsdom: "1", "@types/x": "1" } };
  assert.deepEqual(addedDependencies(base, head), ["@types/x", "zod"]);
  assert.deepEqual(addedDependencies(head, base), []);
});

test("each new dependency must be named in the description", () => {
  const base = { dependencies: {} };
  const head = { dependencies: { zod: "1", fflate: "1" } };
  assert.deepEqual(dependencyFindings(base, head, "New dependencies: zod, fflate"), []);
  assert.deepEqual(dependencyFindings(base, head, "New dependency: zod"), [
    "the description does not mention the new dependency fflate; list it there",
  ]);
});

test("the range check reads files, commits and package.json from git", async () => {
  await withTempDir("pr-rules-", async (dir) => {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "1" } }));
    writeFileSync(path.join(dir, "RELEASE_NOTES.md"), "- something\n");
    git("add", ".");
    git("commit", "-qm", "Add zod\n\nhttps://claude.ai/code/session_X");
    const head = git("rev-parse", "HEAD");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(checkPullRequest(base, head, "").length, 3);
      assert.equal(checkPullRequest(base, base, "").length, 0);
    } finally {
      process.chdir(cwd);
    }
  });
});

test("dependencies are compared with the merge base, not master's tip", async () => {
  await withTempDir("pr-rules-", async (dir) => {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "1" } }));
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "1", fflate: "1" } }));
    git("commit", "-qam", "Add fflate");
    const head = git("rev-parse", "HEAD");
    // Master drops zod and adds fflate on its own after the branch left it.
    git("checkout", "-q", "master");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { fflate: "1" } }));
    git("commit", "-qam", "Swap zod for fflate");
    const base = git("rev-parse", "HEAD");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      // zod is not new on the branch; fflate is, even though master has it too.
      assert.deepEqual(checkPullRequest(base, head, ""), [
        "the description does not mention the new dependency fflate; list it there",
      ]);
    } finally {
      process.chdir(cwd);
    }
  });
});

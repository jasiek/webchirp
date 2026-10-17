// Rules a pull request is held to that no test of the tree can see, because
// they are about the change itself: what it touches, what its commits say and
// what its description says. .github/workflows/pull-request-rules.yml runs this
// on every pull request; the checks are pure functions so
// tests/build/pull-request-rules.mjs can drive them without git or GitHub.
//
//   BASE_SHA=<base> HEAD_SHA=<head> PR_BODY=<description> node scripts/check-pull-request.ts
import { execFileSync } from "node:child_process";

type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

// RELEASE_NOTES.md is written on master after a merge, from the merged pull
// requests; a branch that edits it collides with that and with every other branch.
export function releaseNotesFindings(changedFiles: readonly string[]): string[] {
  return changedFiles.includes("RELEASE_NOTES.md")
    ? ["RELEASE_NOTES.md is updated on master after merging; revert it on this branch"]
    : [];
}

// A link to an agent's session leaks a private transcript into public history.
const SESSION_LINK = /https?:\/\/(?:claude\.ai\/(?:code|chat)\/|chatgpt\.com\/(?:codex|c)\/)\S*/i;

// Commit messages carrying an agent session link, by commit.
export function sessionLinkFindings(commits: readonly { sha: string; message: string }[]): string[] {
  return commits
    .filter(({ message }) => SESSION_LINK.test(message))
    .map(({ sha, message }) => `commit ${sha.slice(0, 10)} links an agent session (${SESSION_LINK.exec(message)?.[0]}); reword it`);
}

// Every dependency the head package.json adds over the base one, either kind.
export function addedDependencies(base: PackageJson, head: PackageJson): string[] {
  const before = new Set([...Object.keys(base.dependencies || {}), ...Object.keys(base.devDependencies || {})]);
  return [...Object.keys(head.dependencies || {}), ...Object.keys(head.devDependencies || {})]
    .filter((name) => !before.has(name))
    .sort();
}

// A new dependency must be named in the pull request's description, so the
// reviewer sees it without reading package-lock.json.
export function dependencyFindings(base: PackageJson, head: PackageJson, body: string): string[] {
  return addedDependencies(base, head)
    .filter((name) => !body.includes(name))
    .map((name) => `the description does not mention the new dependency ${name}; list it there`);
}

// git, with its output as text.
function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// package.json at a commit, or an empty one if it did not exist there.
function packageJsonAt(sha: string): PackageJson {
  try {
    return JSON.parse(git("show", `${sha}:package.json`));
  } catch {
    return {};
  }
}

// Every finding for the range base..head and the given description.
export function checkPullRequest(baseSha: string, headSha: string, body: string): string[] {
  const changed = git("diff", "--name-only", `${baseSha}...${headSha}`).split("\n").filter(Boolean);
  const commits = git("log", "--format=%H%x00%B%x01", `${baseSha}..${headSha}`)
    .split("\x01")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", message = ""] = entry.split("\x00");
      return { sha, message };
    });
  return [
    ...releaseNotesFindings(changed),
    ...sessionLinkFindings(commits),
    // Against the merge base, like the file diff above: master may have
    // added or dropped dependencies since the branch left it.
    ...dependencyFindings(packageJsonAt(git("merge-base", baseSha, headSha).trim()), packageJsonAt(headSha), body),
  ];
}

if (import.meta.main) {
  const { BASE_SHA, HEAD_SHA, PR_BODY } = process.env;
  if (!BASE_SHA || !HEAD_SHA) {
    console.error("set BASE_SHA and HEAD_SHA");
    process.exit(2);
  }
  const findings = checkPullRequest(BASE_SHA, HEAD_SHA, PR_BODY || "");
  for (const finding of findings) console.error(`::error::${finding}`);
  process.exit(findings.length ? 1 : 0);
}

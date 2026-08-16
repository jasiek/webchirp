import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CHIRP_REVISION } from "../web/js/python-sources.mjs";

const ROOT = process.cwd();
const RELEASE_NOTES = path.join(ROOT, "RELEASE_NOTES.md");
const OUTPUT = path.join(ROOT, "web", "version.json");

// The "Updated <date>" line links to RELEASE_NOTES.md, so the newest release
// heading there is the date the widget must show.
async function latestReleaseDate() {
  const notes = await readFile(RELEASE_NOTES, "utf8");
  const match = notes.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/m);
  if (!match) {
    throw new Error(
      `No "## YYYY-MM-DD" release heading found in ${path.relative(ROOT, RELEASE_NOTES)}`,
    );
  }
  return match[1];
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .trim();
}

// Which commit of this repository built the site. A loopback report filed from
// a phone has to name the code that produced it — "the site, some time last
// week" is not something a fix can be checked against. On CI the checkout is
// what Pages deploys, so GITHUB_SHA is authoritative; locally the working tree
// is usually ahead of HEAD, and a report that hides that would send someone
// looking for a bug at a commit that never had it.
function webchirpRevision() {
  const fromCi = process.env.GITHUB_SHA || "";
  if (/^[0-9a-f]{40}$/i.test(fromCi)) {
    return { sha: fromCi, dirty: false };
  }
  try {
    return { sha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0 };
  } catch {
    // A source tarball, or no git on PATH. The report says "unknown" rather
    // than claiming a revision it cannot know.
    return { sha: "", dirty: false };
  }
}

async function main() {
  const lastUpdated = await latestReleaseDate();
  const webchirp = webchirpRevision();
  // The runtime fetches CHIRP sources at this revision, so it — not the local
  // submodule checkout — is what the widget should advertise.
  const chirpSha = DEFAULT_CHIRP_REVISION;

  const version = {
    lastUpdated,
    webchirpSha: webchirp.sha,
    webchirpShaShort: webchirp.sha
      ? `${webchirp.sha.slice(0, 7)}${webchirp.dirty ? "-dirty" : ""}`
      : "",
    webchirpCommitUrl: webchirp.sha
      ? `https://github.com/jasiek/webchirp/commit/${webchirp.sha}`
      : "",
    chirpSha,
    chirpShaShort: chirpSha.slice(0, 7),
    chirpCommitUrl: `https://github.com/kk7ds/chirp/commit/${chirpSha}`,
  };

  await writeFile(OUTPUT, `${JSON.stringify(version, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}:`, version);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

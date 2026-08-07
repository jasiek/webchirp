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

async function main() {
  const lastUpdated = await latestReleaseDate();
  // The runtime fetches CHIRP sources at this revision, so it — not the local
  // submodule checkout — is what the widget should advertise.
  const chirpSha = DEFAULT_CHIRP_REVISION;

  const version = {
    lastUpdated,
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

import { cp, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const WEB_DIR = path.join(ROOT, "web");

async function main() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await cp(WEB_DIR, DIST_DIR, {
    recursive: true,
    filter: (src) => path.basename(src) !== "__pycache__",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

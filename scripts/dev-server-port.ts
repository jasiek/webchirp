// The port scripts/dev-server.ts listens on when PORT is not set. The main
// checkout keeps 8000; a linked git worktree (whose .git is a file pointing at
// the main repository, not a directory) gets a port of its own, derived from
// its directory name, so a server started there never collides with master's
// on 8000 and the same worktree always comes back on the same port.
import fs from "node:fs";
import path from "node:path";

export const MAIN_CHECKOUT_PORT = 8000;
// Worktree ports fall in 8001..8999.
const WORKTREE_PORT_BASE = 8001;
const WORKTREE_PORT_SPAN = 999;

// Whether dir is a linked worktree rather than the main checkout.
export function isLinkedWorktree(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

// A stable port for dir: 8000 for the main checkout, otherwise one hashed
// from the worktree's directory name (FNV-1a, so it needs no crypto import).
export function defaultDevServerPort(dir: string): number {
  if (!isLinkedWorktree(dir)) return MAIN_CHECKOUT_PORT;
  let hash = 0x811c9dc5;
  for (const char of path.basename(path.resolve(dir))) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return WORKTREE_PORT_BASE + (hash % WORKTREE_PORT_SPAN);
}

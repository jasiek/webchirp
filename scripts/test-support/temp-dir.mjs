// Throwaway directories for tests that drive a script against a fake tree.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Run fn with a fresh temporary directory and remove it afterwards, whether or
// not fn threw. Callback style rather than create/remove pairs so no test can
// forget the cleanup, or leave it in a try/finally around every body.
export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

import { mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await cp(path.join(repoRoot, 'index.html'), path.join(distDir, 'index.html'));
  await cp(path.join(repoRoot, 'web'), path.join(distDir, 'web'), { recursive: true });

  console.log(`Built deployable bundle at ${distDir}`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});

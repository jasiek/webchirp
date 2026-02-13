import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const smokeScript = path.join(__dirname, 'smoke_radio_clone.py');

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  node scripts/smoke-radio-clone.mjs --module <mod> --class <Class> --port <serial-port> [--baud <n>] [--max-diff-bytes <n>]

Example:
  node scripts/smoke-radio-clone.mjs --module h777 --class H777Radio --port /dev/tty.usbserial-0001 --max-diff-bytes 0`);
  process.exit(0);
}

const child = spawn('python', [smokeScript, ...args], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`smoke test terminated by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

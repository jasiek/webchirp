import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

const DEFAULT_REBOOT_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || "");
    if (!raw.startsWith("--")) {
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    if (key === "help") {
      out.help = "1";
      continue;
    }
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = "1";
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  npm run test:hw -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R",
    "",
    "Options:",
    "  --port PATH            Required serial path (for example /dev/ttyUSB0 or COM3)",
    "  --module NAME          Required CHIRP driver module short name (for example uv5r)",
    "  --class NAME           Required CHIRP driver class name (for example BaofengUV5R)",
    "  --baud N               Optional serial baud override (default: driver BAUD_RATE or 9600)",
    "  --chirp-dir PATH       Optional CHIRP source tree root (default: ./chirp or WEBCHIRP_CHIRP_DIR)",
    "  --serial-timeout-s N   Optional serial read timeout seconds (sets WEBCHIRP_SERIAL_TIMEOUT_S)",
    "  --reboot-delay-ms N    Wait after download before upload (default: 5000)",
  ].join("\n");
}


async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const portPath = String(args.port || "");
  const moduleName = String(args.module || "");
  const className = String(args.class || args["class-name"] || "");
  if (!portPath || !moduleName || !className) {
    console.error(usage());
    throw new Error("--port, --module, and --class are required");
  }

  if (args["serial-timeout-s"]) {
    process.env.WEBCHIRP_SERIAL_TIMEOUT_S = String(args["serial-timeout-s"]);
  }
  const rebootDelayOverride = Number(args["reboot-delay-ms"]);
  const rebootDelayMs = Number.isFinite(rebootDelayOverride)
    ? Math.max(0, rebootDelayOverride)
    : DEFAULT_REBOOT_DELAY_MS;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const harness = await createTestRadioHarness({
    repoRoot,
    chirpDir: String(args["chirp-dir"] || ""),
    portPath,
    serialMode: "node",
  });

  try {
    const radioInfo = await harness.getRadioInfo(moduleName, className);

    const baudOverride = args.baud ? Number(args.baud) : NaN;
    const baudRate = Number.isFinite(baudOverride) ? baudOverride : Number(radioInfo.baudRate || 9600);
    console.log(
      `Running live read->write test on ${radioInfo.vendor} ${radioInfo.model} (${moduleName}.${className}) via ${portPath} @ ${baudRate} bps`,
    );

    const connectResult = await harness.connect({ moduleName, className, baudRate });
    if (!connectResult.connected) {
      throw new Error(`Serial connect failed: ${JSON.stringify(connectResult)}`);
    }

    const downloaded = await harness.readCodeplug(moduleName, className);

    const rows = Array.isArray(downloaded.rows) ? downloaded.rows : [];
    console.log(`Download complete: ${rows.length} channel row(s) read.`);
    if (rebootDelayMs > 0) {
      console.log(`Waiting ${rebootDelayMs} ms for radio reboot before upload...`);
      await sleep(rebootDelayMs);
    }

    const uploaded = await harness.writeCodeplug(moduleName, className, downloaded);

    if (!uploaded.uploaded) {
      throw new Error(`Upload failed: ${JSON.stringify(uploaded)}`);
    }

    console.log("Upload complete: wrote the downloaded codeplug back to radio.");
  } finally {
    try {
      await harness.disconnect();
    } catch (error) {
      console.error(`Disconnect warning: ${error?.message || String(error)}`);
    }
  }
}

main().catch((error) => {
  const detail = (error && error.stack) || error?.message || String(error);
  console.error(detail);
  process.exitCode = 1;
});

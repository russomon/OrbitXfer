// Copy a pre-built orbitxfer-iroh-cli binary into the Tauri sidecar slot
// before bundling. Tauri's bundler expects sidecars at:
//   src-tauri/binaries/<name>-<host-target-triple>{.exe}
//
// This script DOES NOT build the CLI — it just syncs whatever's already
// in OrbitXfer-iroh-cli/target/{release,debug}/. Run
//   cargo build --release -p orbitxfer-iroh-cli
// (or the dev equivalent) before invoking this. Matches the pattern used
// by the Electron app's scripts/sync-cli.js.

import { existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, "..");
const cliRoot = resolve(projectRoot, "..", "OrbitXfer-iroh-cli");
const binDir = join(projectRoot, "src-tauri", "binaries");

function detectHostTriple() {
  try {
    const out = execSync("rustc -vV", { encoding: "utf8" });
    const match = out.match(/^host:\s*(\S+)$/m);
    if (match) return match[1];
  } catch (e) {
    console.error("Could not detect host triple via rustc:", e.message);
  }
  console.error(
    "Falling back to platform-derived triple. Install rustc to get the right one."
  );
  // Best-effort fallback for the common cases.
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

const hostTriple = detectHostTriple();
const isWindows = hostTriple.includes("windows");
const exeSuffix = isWindows ? ".exe" : "";

const candidates = [
  {
    label: "release",
    source: join(cliRoot, "target", "release", `orbitxfer-iroh-cli${exeSuffix}`),
  },
  {
    label: "debug",
    source: join(cliRoot, "target", "debug", `orbitxfer-iroh-cli${exeSuffix}`),
  },
];

const dest = join(
  binDir,
  `orbitxfer-iroh-cli-${hostTriple}${exeSuffix}`
);

function syncBinary({ label, source }) {
  if (!existsSync(source)) return false;
  mkdirSync(binDir, { recursive: true });
  copyFileSync(source, dest);
  if (!isWindows) chmodSync(dest, 0o755);
  console.log(`Synced ${label} CLI for ${hostTriple}:`);
  console.log(`  ${source}`);
  console.log(`  -> ${dest}`);
  return true;
}

// Prefer the first match (release before debug) and stop — without this,
// each successive candidate would overwrite the previous, and a stale
// debug binary would clobber a fresh release.
const synced = candidates.some(syncBinary);

if (!synced) {
  console.error(
    `\nNo OrbitXfer CLI binary found to sync for ${hostTriple}.`
  );
  console.error(`Expected one of:`);
  for (const c of candidates) console.error(`  ${c.source}`);
  console.error(`\nBuild it first:`);
  console.error(
    `  (cd ${relative(projectRoot, cliRoot)} && cargo build --release)`
  );
  process.exit(1);
}

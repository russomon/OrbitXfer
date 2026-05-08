#!/usr/bin/env bash
# Build a signed + notarized macOS bundle by sourcing tauri.env and
# invoking `npm run tauri build`. Mirrors the Electron app's reliance on
# electron-builder.env, but adapted for Tauri's bundler.
#
# Usage:
#   cp tauri.env.example tauri.env   # one-time, fill in your real values
#   ./scripts/build-mac-signed.sh
#
# Without tauri.env (and without env vars otherwise set), the bundle will
# fall back to ad-hoc signing — same as `npm run tauri build` directly.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"

env_file="${project_dir}/tauri.env"
if [[ -f "${env_file}" ]]; then
  echo "Sourcing ${env_file}"
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
else
  echo "No ${env_file} found — build will fall back to ad-hoc signing."
  echo "To sign + notarize: cp tauri.env.example tauri.env and fill in."
fi

cd "${project_dir}"
npm run tauri build

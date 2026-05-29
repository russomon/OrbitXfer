#!/usr/bin/env bash
# Validate that a built OrbitXfer.app is properly signed, accepted by
# Gatekeeper, and has a valid notarization staple. Adapted from the
# Electron app's verify-macos-release.sh for Tauri's bundle layout.
#
# Usage:
#   npm run verify:mac:release
# or
#   ./scripts/verify-macos-release.sh /path/to/OrbitXfer.app

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"

app_path="${1:-}"
if [[ -z "${app_path}" ]]; then
  # Look in both the host-arch and universal-apple-darwin bundle paths.
  # The universal2 build (v0.1.76+ in CI) lands its .app at
  # target/universal-apple-darwin/release/bundle/macos/.
  #
  # We iterate per-candidate (not one multi-arg `find`) because passing a
  # non-existent path to `find` makes it exit 1, and with `set -euo
  # pipefail` that aborts the script before we ever discover the .app at
  # the other (existing) candidate.
  candidates=(
    "${project_dir}/src-tauri/target/release/bundle/macos"
    "${project_dir}/src-tauri/target/universal-apple-darwin/release/bundle/macos"
  )
  for dir in "${candidates[@]}"; do
    if [[ -d "${dir}" ]]; then
      hit="$(find "${dir}" -maxdepth 2 -type d -name 'OrbitXfer.app' 2>/dev/null | sort | head -n 1)"
      if [[ -n "${hit}" ]]; then
        app_path="${hit}"
        break
      fi
    fi
  done
fi

if [[ -z "${app_path}" || ! -d "${app_path}" ]]; then
  echo "OrbitXfer.app not found. Build with 'npm run tauri build' first or pass a path explicitly." >&2
  exit 1
fi

echo "Verifying code signature for ${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"

echo "Checking Gatekeeper assessment for ${app_path}"
spctl -a -vv -t exec "${app_path}"

echo "Validating notarization staple for ${app_path}"
xcrun stapler validate "${app_path}"

echo "macOS release verification passed."

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"

app_path="${1:-}"
if [[ -z "${app_path}" ]]; then
  app_path="$(find "${project_dir}/dist" -maxdepth 2 -type d -name 'OrbitXfer.app' | sort | head -n 1)"
fi

if [[ -z "${app_path}" || ! -d "${app_path}" ]]; then
  echo "OrbitXfer.app not found. Build the mac app first or pass a path explicitly." >&2
  exit 1
fi

echo "Verifying code signature for ${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"

echo "Checking Gatekeeper assessment for ${app_path}"
spctl -a -vv -t exec "${app_path}"

echo "Validating notarization staple for ${app_path}"
xcrun stapler validate "${app_path}"

echo "macOS release verification passed."

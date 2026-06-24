#!/usr/bin/env bash
# Build a signed + notarized macOS bundle by sourcing tauri.env and
# invoking `npm run tauri build`. Mirrors the Electron app's reliance on
# electron-builder.env, but adapted for Tauri's bundler.
#
# Usage:
#   cp tauri.env.example tauri.env   # one-time, fill in your real values
#   ./scripts/build-mac-signed.sh                              # host arch
#   ./scripts/build-mac-signed.sh --target universal-apple-darwin   # fat
#
# Any extra args are forwarded to `tauri build`. When you pass
# `--target universal-apple-darwin`, this script first builds the
# orbitxfer-iroh-cli sidecar for BOTH arches and lipo's them into the
# universal sidecar slot (Tauri does NOT lipo sidecars itself), so the
# bundled CLI is fat too.
#
# After the build it notarizes + staples each produced .dmg. Tauri only
# notarizes/staples the .app, so a freshly built .dmg has no ticket of its
# own and a downloaded copy would still trip Gatekeeper. This closes that
# gap. The dmg step is skipped (with a note) when no notarization API key
# is configured — the same condition under which the bundle is only
# ad-hoc signed.
#
# Without tauri.env (and without env vars otherwise set), the bundle will
# fall back to ad-hoc signing — same as `npm run tauri build` directly.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"
cli_dir="$(cd "${project_dir}/.." && pwd)/OrbitXfer-iroh-cli"
bin_dir="${project_dir}/src-tauri/binaries"

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

# If a universal build was requested, build + lipo the universal sidecar
# first. Tauri looks for binaries/orbitxfer-iroh-cli-universal-apple-darwin
# when the build target is universal-apple-darwin and will NOT merge the
# per-arch ones on its own.
want_universal=false
for arg in "$@"; do
  [[ "${arg}" == "universal-apple-darwin" ]] && want_universal=true
done

if [[ "${want_universal}" == true ]]; then
  echo "==> Building universal CLI sidecar (arm64 + x86_64)"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
  (
    cd "${cli_dir}"
    cargo build --release --target aarch64-apple-darwin
    cargo build --release --target x86_64-apple-darwin
  )
  mkdir -p "${bin_dir}"
  lipo -create -output "${bin_dir}/orbitxfer-iroh-cli-universal-apple-darwin" \
    "${cli_dir}/target/aarch64-apple-darwin/release/orbitxfer-iroh-cli" \
    "${cli_dir}/target/x86_64-apple-darwin/release/orbitxfer-iroh-cli"
  cp "${cli_dir}/target/aarch64-apple-darwin/release/orbitxfer-iroh-cli" \
    "${bin_dir}/orbitxfer-iroh-cli-aarch64-apple-darwin"
  cp "${cli_dir}/target/x86_64-apple-darwin/release/orbitxfer-iroh-cli" \
    "${bin_dir}/orbitxfer-iroh-cli-x86_64-apple-darwin"
  chmod 755 "${bin_dir}"/orbitxfer-iroh-cli-universal-apple-darwin \
            "${bin_dir}"/orbitxfer-iroh-cli-aarch64-apple-darwin \
            "${bin_dir}"/orbitxfer-iroh-cli-x86_64-apple-darwin
  echo "    universal sidecar: $(lipo -info "${bin_dir}/orbitxfer-iroh-cli-universal-apple-darwin" | sed -E 's/.*are: //')"
fi

cd "${project_dir}"
npm run tauri build -- "$@"

# ---------------------------------------------------------------------------
# Notarize + staple the produced .dmg(s).
# ---------------------------------------------------------------------------
version="$(grep -m1 '"version"' "${project_dir}/src-tauri/tauri.conf.json" \
  | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"

if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_PATH:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
  echo "No notarization API key in env — skipping .dmg notarization."
  echo "(The .dmg is signed but not stapled; downloaded copies may trip Gatekeeper.)"
  exit 0
fi

dmgs=()
for dir in \
  "${project_dir}/src-tauri/target/release/bundle/dmg" \
  "${project_dir}/src-tauri/target/universal-apple-darwin/release/bundle/dmg" \
  "${project_dir}/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg" \
  "${project_dir}/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg"; do
  [[ -d "${dir}" ]] || continue
  while IFS= read -r f; do
    [[ -n "${f}" ]] && dmgs+=("${f}")
  done < <(find "${dir}" -maxdepth 1 -name "OrbitXfer_${version}_*.dmg" 2>/dev/null)
done

if [[ ${#dmgs[@]} -eq 0 ]]; then
  echo "No OrbitXfer_${version}_*.dmg found to notarize."
  exit 0
fi

for dmg in "${dmgs[@]}"; do
  if xcrun stapler validate "${dmg}" >/dev/null 2>&1; then
    echo "Already stapled, skipping: ${dmg}"
    continue
  fi
  echo "==> Notarizing $(basename "${dmg}")"
  xcrun notarytool submit "${dmg}" \
    --key "${APPLE_API_KEY_PATH}" \
    --key-id "${APPLE_API_KEY}" \
    --issuer "${APPLE_API_ISSUER}" \
    --wait
  echo "==> Stapling $(basename "${dmg}")"
  xcrun stapler staple "${dmg}"
  xcrun stapler validate "${dmg}"
  echo "    notarized + stapled: ${dmg}"
done

echo "Done. All v${version} .dmg(s) are notarized + stapled."

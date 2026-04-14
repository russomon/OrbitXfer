#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version> [YYYY-MM-DD]" >&2
  echo "Example: $0 0.1.51 2026-04-14" >&2
  exit 1
fi

version="$1"
date_arg="${2:-}"
if [[ "$version" != v* ]]; then
  version="v${version}"
fi
release_number="${version#v}"
release_date="${date_arg:-$(date +%Y-%m-%d)}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

cd "$repo_root"

if git rev-parse "$version" >/dev/null 2>&1; then
  echo "Error: tag ${version} already exists." >&2
  exit 1
fi

require_match() {
  local file="$1"
  local pattern="$2"
  if ! grep -q "$pattern" "$file"; then
    echo "Error: expected ${file} to contain version ${release_number}." >&2
    exit 1
  fi
}

require_match "OrbitXfer-iroh-gui/package.json" "\"version\": \"${release_number}\""
require_match "OrbitXfer-iroh-gui/package-lock.json" "\"version\": \"${release_number}\""
require_match "OrbitXfer-iroh-cli/src/main.rs" "const CLI_VERSION: &str = \"${release_number}\";"

if [[ ! -f RELEASES.md ]]; then
  echo "# Releases" > RELEASES.md
fi

echo "Enter release notes (one bullet per line). Finish with an empty line:"
notes=()
while IFS= read -r line; do
  [[ -z "$line" ]] && break
  notes+=("$line")
done

if [[ ${#notes[@]} -eq 0 ]]; then
  echo "Error: at least one release note is required." >&2
  exit 1
fi

tmp_file="$(mktemp)"
{
  head -n 1 RELEASES.md
  echo
  echo "## ${version} - ${release_date}"
  for note in "${notes[@]}"; do
    echo "- ${note}"
  done
  echo
  tail -n +2 RELEASES.md
} > "${tmp_file}"
mv "${tmp_file}" RELEASES.md

git add -A
git commit -m "Release ${version}"
git tag -a "${version}" -m "Release ${version}"

echo "Created release commit and annotated tag: ${version}"
echo "Push it with: git push origin main --follow-tags"

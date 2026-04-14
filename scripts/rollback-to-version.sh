#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <version> [branch-name]" >&2
  echo "Example: $0 0.1.51 rollback/0.1.51" >&2
  exit 1
fi

version="$1"
if [[ "$version" != v* ]]; then
  version="v${version}"
fi

branch_name="${2:-rollback/${version#v}}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

if ! git rev-parse "${version}^{commit}" >/dev/null 2>&1; then
  echo "Error: tag ${version} does not exist in this repository." >&2
  echo "Available versions:" >&2
  git tag --list --sort=version:refname >&2
  exit 1
fi

git switch -C "${branch_name}" "${version}"

echo "Checked out ${version} on branch ${branch_name}"
echo "Return to the latest code with: git switch main"

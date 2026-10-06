#!/usr/bin/env bash
# Builds pstack as this fork ships it: cursor/plugins pstack with overlay.patch
# applied, plus its Codex port. The Mac's pstack update.sh and the pstack-skills
# workflow both run this, so local installs and cloud environments get the same skills.
#
# usage: build.sh <cursor-plugins clone> <revision> <out>
# Writes <out>/pstack and <out>/codex, then prints "<version> <commit>".
# Exits non-zero without writing <out> when the overlay no longer applies.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
clone="$1"
commit="$(git -C "$clone" rev-parse --verify "$2^{commit}")"
out="$3"

scratch="$(mktemp -d)"
cleanup() {
  git -C "$clone" worktree remove --force "$scratch/tree" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
git -C "$clone" worktree add -q --detach "$scratch/tree" "$commit"
if ! git -C "$scratch/tree" apply --3way "$here/overlay.patch" >"$scratch/apply.log" 2>&1; then
  cat "$scratch/apply.log" >&2
  echo "overlay.patch no longer applies to cursor/plugins $commit. Rebase it: see scripts/pstack/README.md." >&2
  exit 1
fi

version="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$scratch/tree/pstack/.cursor-plugin/plugin.json")"
rm -rf "$out"
mkdir -p "$out"
cp -R "$scratch/tree/pstack" "$out/pstack"
python3 "$here/build-codex.py" "$out/pstack" "$out/codex" "$version+codex.$(date -u +%Y%m%d%H%M%S)" "$commit"
echo "$version $commit"

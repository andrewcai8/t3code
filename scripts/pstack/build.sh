#!/usr/bin/env bash
# Builds the pstack this fork's cloud environments get: chhoumann/t3-pstack, a T3 port of
# cursor/plugins pstack, with this fork's model tiers, flattened from its Claude Code and Codex
# plugin into plain skill directories. Claude and Codex read the same tree. Needs node and bun.
#
# usage: build.sh <t3-pstack clone> <revision> <out>
# Writes <out>/skills, then prints "<version> <commit>".
# Exits non-zero without writing <out> when a skill names a plugin file the build drops.
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
tree="$scratch/tree"

# This fork's model tiers (models.json beside this script) replace t3-pstack's, and its own
# generator restamps every skill's Models section from them.
node -e 'const fs = require("fs"); const [policy, tiers] = process.argv.slice(1);
  const p = JSON.parse(fs.readFileSync(policy, "utf8")); p.tiers = JSON.parse(fs.readFileSync(tiers, "utf8"));
  fs.writeFileSync(policy, JSON.stringify(p, null, 2) + "\n");' "$tree/plugins/pstack/models.json" "$here/models.json"
(cd "$tree" && bun install --frozen-lockfile --silent && bun tools/generate.mjs) >&2
cp -R "$tree/plugins/pstack" "$scratch/pstack"
skills="$scratch/pstack/skills"

# The skills read agent briefs at `<plugin root>/agents/`, beside `skills/`. A box receives
# only skill directories, so the briefs move into poteto-mode and the references follow.
mv "$scratch/pstack/agents" "$skills/poteto-mode/agents"
find "$skills" -name '*.md' -exec perl -pi -e 's|<plugin root>/agents/|<plugin root>/skills/poteto-mode/agents/|g' {} +
mv "$scratch/pstack/models.json" "$skills/setup-pstack/models.json"
perl -pi -e 's|"\.\./\.\./\.\./models\.json"|"../models.json"|' "$skills/setup-pstack/scripts/t3-sheet.mjs"
if ! grep -q '"\.\./models\.json"' "$skills/setup-pstack/scripts/t3-sheet.mjs"; then
  echo "t3-sheet.mjs at t3-pstack $commit no longer reads ../../../models.json; update build.sh to its new path." >&2
  exit 1
fi
mkdir "$skills/poteto-mode/licenses"
cp "$tree"/LICENSE* "$tree"/NOTICE*.md "$skills/poteto-mode/licenses/"
# Only the skill directories ship, so the checks below see only them.
find "$scratch/pstack" -mindepth 1 -maxdepth 1 ! -name skills -exec rm -rf {} +

missing="$(
  { grep -rhoE '<plugin root>/[A-Za-z0-9_./-]*[A-Za-z0-9_/-]' "$skills" || true; } | sort -u | while read -r ref; do
    test -e "$scratch/pstack/${ref#<plugin root>/}" || echo "$ref"
  done
  { grep -rnoE --include='*.mjs' --include='*.js' --include='*.ts' 'new URL\("[^"]+", import\.meta\.url\)' "$skills" || true; } | while IFS=: read -r file _ ref; do
    rel="$(sed -E 's/new URL\("([^"]+)".*/\1/' <<<"$ref")"
    target="$(cd "$(dirname "$file")" && realpath -m "$rel")"
    case "$target" in "$skills"/*) test -e "$target" || echo "$file reads $rel" ;; *) echo "$file reads $rel" ;; esac
  done
)"
if [ -n "$missing" ]; then
  printf 'Skills at t3-pstack %s read plugin files the flattened build lacks:\n%s\n' "$commit" "$missing" >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$out"
cp -R "$skills" "$out/skills"
echo "$(cat "$tree/VERSION") $commit"

#!/usr/bin/env bash
# Builds the pstack this fork's cloud environments get: chhoumann/t3-pstack, a T3 port of
# cursor/plugins pstack, flattened from its Claude Code and Codex plugin into plain skill
# directories. Claude and Codex read the same tree.
#
# usage: build.sh <t3-pstack clone> <revision> <out>
# Writes <out>/skills, then prints "<version> <commit>".
# Exits non-zero without writing <out> when a skill names a plugin file the build drops.
set -euo pipefail
clone="$1"
commit="$(git -C "$clone" rev-parse --verify "$2^{commit}")"
out="$3"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git -C "$clone" archive "$commit" | tar -x -C "$scratch"
skills="$scratch/plugins/pstack/skills"

# The skills read agent briefs at `<plugin root>/agents/`, beside `skills/`. A box receives
# only skill directories, so the briefs move into poteto-mode and the references follow.
mv "$scratch/plugins/pstack/agents" "$skills/poteto-mode/agents"
find "$skills" -name '*.md' -exec perl -pi -e 's|<plugin root>/agents/|<plugin root>/skills/poteto-mode/agents/|g' {} +
mv "$scratch/plugins/pstack/models.json" "$skills/setup-pstack/models.json"
perl -pi -e 's|"\.\./\.\./\.\./models\.json"|"../models.json"|' "$skills/setup-pstack/scripts/t3-sheet.mjs"
mkdir "$skills/poteto-mode/licenses"
cp "$scratch"/LICENSE* "$scratch"/NOTICE*.md "$skills/poteto-mode/licenses/"
# Only the skill directories ship, so the checks below see only them.
find "$scratch/plugins/pstack" -mindepth 1 -maxdepth 1 ! -name skills -exec rm -rf {} +

missing="$(
  grep -rhoE '<plugin root>/[A-Za-z0-9_./-]*[A-Za-z0-9_/-]' "$skills" | sort -u | while read -r ref; do
    test -e "$scratch/plugins/pstack/${ref#<plugin root>/}" || echo "$ref"
  done
  grep -rnoE --include='*.mjs' --include='*.js' --include='*.ts' 'new URL\("[^"]+", import\.meta\.url\)' "$skills" | while IFS=: read -r file _ ref; do
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
echo "$(cat "$scratch/VERSION") $commit"

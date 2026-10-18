#!/usr/bin/env bash
# Print the Graphite merge-queue GitHub label for the current repo, or nothing.
# `graphite` wins when both `graphite` and `merge-queue` exist.
# Never require the Graphite CLI (`gt`).
set -euo pipefail
labels="$(gh label list --limit 100 --json name --jq '.[].name' 2>/dev/null || true)"
if [[ -z "$labels" ]]; then
  exit 0
fi
if printf '%s\n' "$labels" | grep -qx graphite; then
  printf '%s\n' graphite
  exit 0
fi
if printf '%s\n' "$labels" | grep -qx merge-queue; then
  printf '%s\n' merge-queue
fi

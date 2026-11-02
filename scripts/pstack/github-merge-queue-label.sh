#!/usr/bin/env bash
# Print the merge-queue GitHub label for the current repo, or nothing.
# Trunk's `trunk-merge-queue-submit` wins: a repo that moved from Graphite to Trunk keeps its
# old `graphite` and `merge-queue` labels, and labeling those queues nothing.
# A failed lookup exits non-zero rather than printing nothing, which would read as "no queue"
# and send the agent to `gh pr merge`. REST, because GraphQL's budget runs out first on busy hosts.
# Never require the Graphite CLI (`gt`).
set -euo pipefail
labels="$(gh api 'repos/{owner}/{repo}/labels?per_page=100' --paginate --jq '.[].name')"
for label in trunk-merge-queue-submit graphite merge-queue; do
  if printf '%s\n' "$labels" | grep -qx "$label"; then
    printf '%s\n' "$label"
    exit 0
  fi
done
